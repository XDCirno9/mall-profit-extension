(function initMallProfitExtension() {
  'use strict';

  const Core = globalThis.MallProfitCore;
  const Sites = globalThis.MallProfitSites;
  // 按当前域名挑站点适配器。manifest 只匹配这两个站，理论上取不到就说明走错了页面，直接不做。
  const Site = Sites ? Sites.forLocation(window.location) : null;
  if (!Core || !Site) return;

  const CONFIG = Object.freeze({
    listConcurrency: 8,
    offerConcurrency: 4,
    // 核对挂单库存是一个物品一个请求，SMCShop 按当前筛选结果大约几百条，
    // 并发开小一点，别把站点打疼
    stockConcurrency: 3,
    offerPageSize: 100,
    cacheTtlMs: 5 * 60 * 1000,
    fetchRetries: 2,
    maxOffers: 20000,
    jumpTimeoutMs: 8000,
    mallUiTimeoutMs: 2000,
    mallSearchPlaceholder: '搜索物品名',
    mallItemTableHeader: '物品名',
    highlightMs: 1800,
    inputDebounceMs: 220
  });

  const L = Site.labels;

  // 两个站点共用同一个 chrome.storage.local，key 必须分开，否则在 A 站存的缓存会被 B 站当成自己的。
  // mall 不加后缀：老用户已经有那份缓存了，没必要为这次改版白拉一遍全量数据。
  const keySuffix = Site.id === 'mall' ? '' : `.${Site.id}`;
  const STORAGE_KEYS = Object.freeze({
    market: `mallProfit.market.v1${keySuffix}`,
    totals: `mallProfit.totals.v1${keySuffix}`,
    analyses: `mallProfit.analyses.v1${keySuffix}`,
    // 挂单库存的核对结果，跟商品快照绑在一起：快照换了它就必须作废
    stocks: `mallProfit.stocks.v1${keySuffix}`,
    portBlacklist: `mallProfit.portBlacklist.v1${keySuffix}`
  });

  // 表头定义：field 为空的列（# 序号）不参与排序，其余列点一下表头即可升 / 降序。
  // 数组顺序 = 表格列顺序，content.css 用 nth-child 定列宽，调整顺序要同步改样式。
  const TABLE_COLUMNS = Object.freeze({
    unit: Object.freeze([
      Object.freeze({ label: '#', field: '' }),
      Object.freeze({ label: '商品', field: 'itemName' }),
      Object.freeze({ label: L.minSell, field: 'minSellPrice' }),
      Object.freeze({ label: L.maxBuy, field: 'maxBuyPrice' }),
      Object.freeze({ label: '单件利润', field: 'unitProfit' }),
      Object.freeze({ label: '利润率', field: 'profitRate' }),
      Object.freeze({ label: L.sellAmount, field: 'sellAmount' })
    ]),
    total: Object.freeze([
      Object.freeze({ label: '#', field: '' }),
      Object.freeze({ label: '商品', field: 'itemName' }),
      Object.freeze({ label: L.minSell, field: 'minSellPrice' }),
      Object.freeze({ label: L.maxBuy, field: 'maxBuyPrice' }),
      Object.freeze({ label: '总利润', field: 'totalProfit' }),
      Object.freeze({ label: '可匹配数量', field: 'matchedQty' }),
      Object.freeze({ label: '单件利润', field: 'unitProfit' }),
      Object.freeze({ label: '利润率', field: 'profitRate' })
    ])
  });

  const MODE_DEFAULT_SORT = Object.freeze({
    unit: 'unitProfit-desc',
    total: 'totalProfit-desc'
  });

  const numberFormatter = new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 2
  });

  const integerFormatter = new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 0
  });

  const state = {
    items: [],
    unitRows: [],
    totalCache: {},
    analysisCache: {},
    // 逐物品核对过的「有货报价」：{ [商品名]: { status, minSellPrice, maxBuyPrice, ... } }
    stockCache: {},
    stockLoading: false,
    stockController: null,
    stockRunId: 0,
    // 用户按过「停止核对」：在下次刷新数据之前不再自动开始
    stockStopped: false,
    // 核对失败的商品（接口报错）。记下来就不在一轮里反复重试，
    // 否则自动核对会被「render → 又发现它没结果 → 再请求」这个循环带着跑
    stockErrors: new Set(),
    portBlacklist: [],
    availablePorts: [],
    draftPortBlacklist: new Set(),
    portSearch: '',
    portListLoading: false,
    portError: '',
    offerErrors: new Set(),
    marketSavedAt: 0,
    jumpBusy: '',
    jumpNotice: '',
    truncatedCount: 0,
    storageWarning: '',
    portNotice: '',
    portRenderedSignature: '',
    mode: 'unit',
    sortKey: 'unitProfit-desc',
    search: '',
    minSellAmount: 0,
    vanillaFilter: 'all',
    calcScope: 'all',
    // 按钮上要显示「重新计算（N 条）」，但 setBusy 会在算报价时被调用上万次，
    // 所以这个数字只在 render 里算一次存下来，setBusy 只读它
    scopeTargetCount: 0,
    // 不支持异常过滤的站点必须留在 0：那一支要求每行都有分析结果，否则整张表会一片空白
    anomalyMultiplier: Site.features.anomalyFilter ? 10 : 0,
    // 「最高收价 ÷ 最低卖价」的上限倍率，0 = 不过滤。默认 10 倍是实测出来的分界线：
    // 真实行商物品的倍率都在 10 倍以内，而乱标价造成的虚高是几百到十几万倍。
    // 只有聚合极值的数据源（SMCShop）才开这个开关，商城那边报价是真实行情，倍率大是正常的。
    priceRatioLimit: Site.features.priceRatioFilter ? 10 : 0,
    // 被倍率上限筛掉的行数，渲染说明文字时用
    priceRatioHiddenCount: 0,
    // 库存核对这一类：核对过的、判定缺货（或价差为负）被藏起来的、以及挂单过多核不准的
    stockCheckedCount: 0,
    stockExcludedCount: 0,
    stockUncertainCount: 0,
    // 接口连 amount 字段都不给了（形状变了），这时候不能把「读不到库存」当成「全都没货」
    stockShapeWarning: false,
    panelOpen: false,
    dataLoading: false,
    offerLoading: false,
    marketController: null,
    offerController: null,
    offerRunId: 0,
    progress: null,
    error: ''
  };

  const elements = {};

  function createElement(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
  }

  // 搜索框和数量框的输入都会触发一次全表重排，商城有上万个商品时逐键重排肉眼可见地卡，
  // 所以统一做防抖：停下来一小会儿再重排一次。
  function debounce(fn, wait) {
    let timer = 0;
    return function debounced(...args) {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        fn.apply(this, args);
      }, wait);
    };
  }

  // 输入框只在内容真的不同、且用户没在编辑它的时候才写回，
  // 否则每帧覆盖 value 会把光标顶到末尾，还会吃掉尾随空格
  function syncInputValue(element, value) {
    if (!element || element === document.activeElement) return;
    if (element.value !== value) element.value = value;
  }

  // 站点之间的界面差异集中在这里：换标题文案、把该站不支持的功能整块藏掉。
  // 灰着的控件比不存在的控件更让人困惑——SMCShop 只做单件利润，
  // 留一堆点不动的下拉会让人以为面板坏了。
  function applySiteChrome() {
    const heading = elements['mpe-panel'].querySelector('.mpe-heading');
    if (heading) {
      heading.querySelector('h2').textContent = Site.title;
      heading.querySelector('p').textContent = Site.tagline;
    }
    elements['mpe-status-note'].textContent = L.statusNote;
    elements['mpe-explainer'].textContent = L.unitRule;
    const quantityField = elements['mpe-min-sell-amount'].closest('.mpe-field');
    const quantityLabel = quantityField ? quantityField.querySelector('span') : null;
    if (quantityLabel) quantityLabel.textContent = L.minSellFilter;

    const features = Site.features;
    const toggle = (node, supported) => {
      if (node) node.classList.toggle('mpe-hidden', !supported);
    };
    toggle(elements['mpe-panel'].querySelector('.mpe-segmented'), features.totalProfit);
    toggle(elements['mpe-calculate'], features.manualCalculation);
    toggle(elements['mpe-calc-scope'].closest('.mpe-field'), features.manualCalculation);
    toggle(elements['mpe-anomaly-filter'].closest('.mpe-field'), features.anomalyFilter);
    toggle(elements['mpe-price-ratio-filter'].closest('.mpe-field'), features.priceRatioFilter);
    toggle(elements['mpe-vanilla-filter'].closest('.mpe-field'), features.vanillaFilter);
    toggle(elements['mpe-port-manager'], features.portBlacklist);
  }

  function createUI() {
    if (document.getElementById('mpe-root')) return;

    const root = createElement(`
      <div id="mpe-root">
        <button class="mpe-launcher" id="mpe-launcher" type="button" aria-label="打开商城利润筛选器">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 19V9h4v10H4Zm6 0V5h4v14h-4Zm6 0v-7h4v7h-4Z"></path>
          </svg>
          <span>利润排行</span>
          <span class="mpe-badge" id="mpe-badge" hidden>0</span>
        </button>

        <div class="mpe-backdrop" id="mpe-backdrop" hidden></div>

        <aside class="mpe-panel" id="mpe-panel" data-open="false" aria-hidden="true">
          <header class="mpe-header">
            <div class="mpe-heading">
              <span class="mpe-heading-mark" aria-hidden="true">利</span>
              <div>
                <h2>商城利润筛选器</h2>
                <p>比较最低出售价与最高收购价，筛选正利润商品</p>
              </div>
            </div>
            <div class="mpe-header-actions">
              <button class="mpe-button mpe-button-primary" id="mpe-calculate" type="button">开始计算</button>
              <button class="mpe-button mpe-button-secondary" id="mpe-refresh" type="button">刷新数据</button>
              <button class="mpe-icon-button" id="mpe-close" type="button" aria-label="关闭">×</button>
            </div>
          </header>

          <div class="mpe-status-line">
            <span id="mpe-data-status">尚未读取物品列表</span>
            <span class="mpe-status-note" id="mpe-status-note" data-notice="false">忽略路程与运输成本 · 自动隐藏标记商店</span>
          </div>

          <div class="mpe-toolbar">
            <div class="mpe-segmented" role="group" aria-label="利润模式">
              <button class="mpe-segment is-active" data-mode="unit" type="button">单件利润</button>
              <button class="mpe-segment" data-mode="total" type="button">总利润</button>
            </div>

            <label class="mpe-field mpe-search-field">
              <span>搜索</span>
              <input id="mpe-search" type="search" placeholder="输入商品名称" autocomplete="off">
            </label>

            <label class="mpe-field mpe-quantity-field">
              <span>最低在售数量</span>
              <input id="mpe-min-sell-amount" type="number" min="0" step="1" placeholder="不限" inputmode="numeric">
            </label>

            <label class="mpe-field mpe-version-field">
              <span>商品版本</span>
              <select id="mpe-vanilla-filter">
                <option value="all">原版 + 非原版</option>
                <option value="vanilla">仅原版</option>
                <option value="non-vanilla">仅非原版</option>
              </select>
            </label>

            <label class="mpe-field mpe-anomaly-field">
              <span>异常价格</span>
              <select id="mpe-anomaly-filter">
                <option value="0">关闭过滤</option>
                <option value="5">严格 · 5×中位数</option>
                <option value="10">推荐 · 10×中位数</option>
                <option value="20">宽松 · 20×中位数</option>
              </select>
            </label>

            <!-- 只用聚合快照现成的极值就能判，不需要逐物品取明细，所以切换即刻生效 -->
            <label class="mpe-field mpe-price-ratio-field">
              <span>价格倍率上限</span>
              <select id="mpe-price-ratio-filter">
                <option value="0">关闭过滤</option>
                <option value="5">严格 · 5 倍</option>
                <option value="10">推荐 · 10 倍</option>
                <option value="20">宽松 · 20 倍</option>
                <option value="50">很宽松 · 50 倍</option>
              </select>
            </label>

            <!-- 「当前筛选结果」= 筛选后的全部行，不再截断条数 -->
            <label class="mpe-field mpe-scope-field">
              <span>计算范围</span>
              <select id="mpe-calc-scope">
                <option value="all">全部商品</option>
                <option value="filtered">当前筛选结果</option>
              </select>
            </label>

            <button class="mpe-button mpe-button-secondary" id="mpe-port-manager" type="button">港口黑名单 <span id="mpe-port-count">0</span></button>
            <button class="mpe-button mpe-button-secondary" id="mpe-retry" type="button" hidden>重试失败项</button>
            <button class="mpe-button mpe-button-danger" id="mpe-cancel" type="button" hidden>停止计算</button>
          </div>

          <div class="mpe-explainer" id="mpe-explainer">
            单件利润 = 最高收购价 − 最低出售价。只显示大于 0 的商品。
          </div>

          <div class="mpe-progress" id="mpe-progress" hidden>
            <div class="mpe-progress-label">
              <span id="mpe-progress-text">正在读取数据</span>
              <span id="mpe-progress-count"></span>
            </div>
            <div class="mpe-progress-track">
              <div class="mpe-progress-bar" id="mpe-progress-bar"></div>
            </div>
          </div>

          <div class="mpe-error" id="mpe-error" hidden></div>

          <section class="mpe-summary" aria-label="利润摘要">
            <div class="mpe-stat">
              <span>筛选结果</span>
              <strong id="mpe-stat-count">—</strong>
            </div>
            <div class="mpe-stat">
              <span>最高单件利润</span>
              <strong id="mpe-stat-unit">—</strong>
            </div>
            <div class="mpe-stat">
              <span>最高总利润</span>
              <strong id="mpe-stat-total">—</strong>
            </div>
          </section>

          <div class="mpe-table-wrap" id="mpe-table-wrap">
            <table class="mpe-table">
              <thead id="mpe-thead"></thead>
              <tbody id="mpe-tbody"></tbody>
            </table>
            <div class="mpe-empty" id="mpe-empty" hidden></div>
          </div>

          <footer class="mpe-footer">
            <span>数据来自商城的公开报价接口，仅按当前价格计算 · 点击商品名称可跳到商城页面中的该物品详情 · 点击表头可切换排序</span>
            <span id="mpe-row-count"></span>
          </footer>
        </aside>
        <div class="mpe-manager" id="mpe-port-modal" hidden>
          <div class="mpe-manager-backdrop" id="mpe-port-modal-backdrop"></div>
          <section class="mpe-manager-panel" role="dialog" aria-modal="true" aria-labelledby="mpe-port-modal-title">
            <header class="mpe-manager-header">
              <div>
                <h3 id="mpe-port-modal-title">港口黑名单</h3>
                <p>屏蔽后，该港口的收购和出售报价不会参与利润计算。</p>
              </div>
              <button class="mpe-icon-button" id="mpe-port-modal-close" type="button" aria-label="关闭">×</button>
            </header>
            <div class="mpe-manager-toolbar">
              <input id="mpe-port-search" type="search" placeholder="搜索港口名称" autocomplete="off">
              <button class="mpe-button mpe-button-secondary" id="mpe-port-reload" type="button">刷新港口列表</button>
              <button class="mpe-button mpe-button-secondary" id="mpe-port-export" type="button">导出黑名单</button>
              <label class="mpe-button mpe-button-secondary mpe-file-button">
                导入黑名单
                <input id="mpe-port-import" type="file" accept=".json,.txt,.csv,application/json,text/plain">
              </label>
            </div>
            <div class="mpe-manager-status" id="mpe-port-status">请选择需要屏蔽的港口。</div>
            <div class="mpe-port-list" id="mpe-port-list"></div>
            <div class="mpe-manager-add">
              <input id="mpe-port-add-input" type="text" placeholder="手动输入港口名称">
              <button class="mpe-button mpe-button-secondary" id="mpe-port-add" type="button">添加</button>
            </div>
            <footer class="mpe-manager-footer">
              <span id="mpe-port-selected-count">已屏蔽 0 个港口</span>
              <button class="mpe-button mpe-button-secondary" id="mpe-port-clear" type="button">清空选择</button>
              <button class="mpe-button mpe-button-primary" id="mpe-port-save" type="button">保存并关闭</button>
            </footer>
          </section>
        </div>
      </div>
    `);

    document.body.appendChild(root);

    const ids = [
      'mpe-launcher',
      'mpe-badge',
      'mpe-backdrop',
      'mpe-panel',
      'mpe-calculate',
      'mpe-refresh',
      'mpe-close',
      'mpe-data-status',
      'mpe-status-note',
      'mpe-search',
      'mpe-min-sell-amount',
      'mpe-vanilla-filter',
      'mpe-anomaly-filter',
      'mpe-price-ratio-filter',
      'mpe-calc-scope',
      'mpe-port-manager',
      'mpe-port-count',
      'mpe-retry',
      'mpe-port-modal',
      'mpe-port-modal-backdrop',
      'mpe-port-modal-close',
      'mpe-port-search',
      'mpe-port-reload',
      'mpe-port-export',
      'mpe-port-import',
      'mpe-port-status',
      'mpe-port-list',
      'mpe-port-add-input',
      'mpe-port-add',
      'mpe-port-selected-count',
      'mpe-port-clear',
      'mpe-port-save',
      'mpe-cancel',
      'mpe-explainer',
      'mpe-progress',
      'mpe-progress-text',
      'mpe-progress-count',
      'mpe-progress-bar',
      'mpe-error',
      'mpe-stat-count',
      'mpe-stat-unit',
      'mpe-stat-total',
      'mpe-table-wrap',
      'mpe-thead',
      'mpe-tbody',
      'mpe-empty',
      'mpe-row-count'
    ];

    for (const id of ids) elements[id] = document.getElementById(id);
    applySiteChrome();
    bindEvents();
    render();
  }

  function bindEvents() {
    elements['mpe-launcher'].addEventListener('click', openPanel);
    elements['mpe-close'].addEventListener('click', closePanel);
    elements['mpe-backdrop'].addEventListener('click', closePanel);
    elements['mpe-calculate'].addEventListener('click', () => void runCalculation(true));
    // 失败的条目不会被写进缓存，所以 force=false 的这轮计算天然只会重新请求它们，
    // retryOnly 再把范围钉死在 offerErrors 上，已经算好的结果一个字都不动
    elements['mpe-retry'].addEventListener('click', () => void runCalculation(false, true));
    elements['mpe-refresh'].addEventListener('click', handleRefresh);
    elements['mpe-cancel'].addEventListener('click', cancelOfferCalculation);
    const debouncedRender = debounce(render, CONFIG.inputDebounceMs);
    elements['mpe-search'].addEventListener('input', (event) => {
      // 原样保存，只在筛选时 trim：提前 trim 再写回输入框会吃掉尾随空格
      state.search = event.target.value;
      debouncedRender();
    });
    elements['mpe-min-sell-amount'].addEventListener('input', (event) => {
      const value = Number(event.target.value);
      state.minSellAmount = Number.isFinite(value) && value > 0 ? value : 0;
      debouncedRender();
    });
    // 表头每次都会整体重绘，所以用事件委托挂在 thead 上，不逐个 th 绑
    elements['mpe-thead'].addEventListener('click', (event) => {
      const target = event.target;
      const button = target && typeof target.closest === 'function'
        ? target.closest('.mpe-th-button')
        : null;
      if (!button || !elements['mpe-thead'].contains(button)) return;
      toggleSort(button.dataset.sortField);
    });
    elements['mpe-vanilla-filter'].addEventListener('change', (event) => {
      state.vanillaFilter = event.target.value;
      render();
    });
    elements['mpe-anomaly-filter'].addEventListener('change', (event) => {
      state.anomalyMultiplier = Number(event.target.value) || 0;
      cancelOfferCalculation(false);
      // 换了倍数等于换了整套缓存，「重试失败项」不该再挂着上一套条件下的失败记录
      state.offerErrors.clear();
      state.error = '';
      render();
    });

    // 计算范围只决定「下一次点计算算哪些」，表里已有的结果不动，所以切换时不必重算
    elements['mpe-calc-scope'].addEventListener('change', (event) => {
      state.calcScope = event.target.value === 'filtered' ? 'filtered' : 'all';
      state.error = '';
      render();
    });

    // 倍率上限是纯视图筛选：判据来自商品快照，不碰报价明细，所以切一下只重绘不重算
    elements['mpe-price-ratio-filter'].addEventListener('change', (event) => {
      state.priceRatioLimit = Number(event.target.value) || 0;
      state.error = '';
      render();
    });

    elements['mpe-port-manager'].addEventListener('click', openPortManager);
    elements['mpe-port-modal-close'].addEventListener('click', closePortManager);
    elements['mpe-port-modal-backdrop'].addEventListener('click', closePortManager);
    elements['mpe-port-reload'].addEventListener('click', () => void loadAvailablePorts(true));
    elements['mpe-port-export'].addEventListener('click', exportPortBlacklist);
    elements['mpe-port-import'].addEventListener('change', importPortBlacklist);
    elements['mpe-port-add'].addEventListener('click', addManualPort);
    elements['mpe-port-add-input'].addEventListener('keydown', (event) => {
      if (event.key === 'Enter') addManualPort();
    });
    elements['mpe-port-clear'].addEventListener('click', () => {
      state.draftPortBlacklist.clear();
      state.portNotice = '';
      state.portError = '';
      renderPortManager();
    });
    elements['mpe-port-save'].addEventListener('click', () => void savePortBlacklist());
    elements['mpe-port-search'].addEventListener('input', (event) => {
      state.portSearch = event.target.value.trim();
      renderPortManager();
    });
    elements['mpe-port-list'].addEventListener('change', (event) => {
      const checkbox = event.target.closest('input[data-port]');
      if (!checkbox) return;
      const port = checkbox.dataset.port;
      if (checkbox.checked) state.draftPortBlacklist.add(port);
      else state.draftPortBlacklist.delete(port);
      // 只刷新计数，不重建列表，避免勾选时滚动位置被重置
      const selectedCount = normalizePortNames([...state.draftPortBlacklist]).length;
      elements['mpe-port-selected-count'].textContent = `已屏蔽 ${selectedCount} 个港口`;
    });
    elements['mpe-tbody'].addEventListener('click', (event) => {
      const button = event.target.closest('button[data-mpe-item]');
      if (!button) return;
      event.preventDefault();
      const itemName = button.dataset.mpeItem;
      if (itemName) void jumpToItem(itemName);
    });

    for (const button of document.querySelectorAll('.mpe-segment')) {
      button.addEventListener('click', () => setMode(button.dataset.mode));
    }

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!elements['mpe-port-modal'].hidden) {
        closePortManager();
        return;
      }
      if (!state.panelOpen) return;
      // 商城的物品详情显示在面板之上，Esc 让给商城去关详情，别顺手把面板也关了
      if (findMallDialog()) return;
      closePanel();
    });
  }

  // 商城的物品详情是一个挂在 body 下的模态框，用它的 data-slot 精确识别，避免误伤别的弹层
  function findMallDialog() {
    return document.querySelector('body > [data-slot="dialog-content"], body > [role="dialog"]:not([id^="mpe-"])');
  }

  function syncPanelChrome() {
    elements['mpe-backdrop'].hidden = !state.panelOpen;
    document.documentElement.classList.toggle('mpe-panel-open', state.panelOpen);
  }

  function openPanel() {
    state.panelOpen = true;
    elements['mpe-panel'].dataset.open = 'true';
    elements['mpe-panel'].setAttribute('aria-hidden', 'false');
    syncPanelChrome();
    render();

    if (!state.items.length && !state.dataLoading) {
      void loadMarket(false);
    }
  }

  function closePanel() {
    state.panelOpen = false;
    elements['mpe-panel'].dataset.open = 'false';
    elements['mpe-panel'].setAttribute('aria-hidden', 'true');
    syncPanelChrome();
  }

  function openPortManager() {
    state.draftPortBlacklist = new Set(normalizePortNames(state.portBlacklist));
    state.portSearch = '';
    state.portError = '';
    state.portNotice = '';
    state.portRenderedSignature = '';
    elements['mpe-port-search'].value = '';
    elements['mpe-port-modal'].hidden = false;
    renderPortManager();
    if (!state.availablePorts.length) void loadAvailablePorts(false);
    window.requestAnimationFrame(() => {
      if (!elements['mpe-port-modal'].hidden) elements['mpe-port-search'].focus();
    });
  }

  function closePortManager() {
    const wasOpen = !elements['mpe-port-modal'].hidden;
    elements['mpe-port-modal'].hidden = true;
    state.portError = '';
    state.portNotice = '';
    state.portRenderedSignature = '';
    renderPortManager();
    if (wasOpen && elements['mpe-port-manager']) elements['mpe-port-manager'].focus();
  }

  function renderPortManager() {
    if (!elements['mpe-port-list']) return;
    const selected = normalizePortNames([...state.draftPortBlacklist]);
    const names = normalizePortNames([
      ...state.availablePorts,
      ...selected
    ]);
    const query = state.portSearch.toLocaleLowerCase('zh-CN');
    const visible = names.filter((name) => !query || name.toLocaleLowerCase('zh-CN').includes(query));

    elements['mpe-port-selected-count'].textContent = `已屏蔽 ${selected.length} 个港口`;
    elements['mpe-port-count'].textContent = String(state.portBlacklist.length);

    if (state.portListLoading) {
      elements['mpe-port-status'].textContent = '正在读取港口列表…';
    } else if (state.portError) {
      elements['mpe-port-status'].textContent = state.portError;
    } else if (state.portNotice) {
      elements['mpe-port-status'].textContent = state.portNotice;
    } else {
      elements['mpe-port-status'].textContent = `共 ${names.length} 个港口，当前显示 ${visible.length} 个。`;
    }

    const signature = visible.join('\u0001');
    const list = elements['mpe-port-list'];
    const previousScrollTop = list.scrollTop;
    const keepScroll = signature === state.portRenderedSignature;

    list.innerHTML = visible.length
      ? visible.map((name) => {
        const checked = state.draftPortBlacklist.has(name) ? ' checked' : '';
        return `<label class="mpe-port-option"><input type="checkbox" data-port="${escapeHtml(name)}"${checked}><span>${escapeHtml(name)}</span></label>`;
      }).join('')
      : `<div class="mpe-port-empty">${state.portListLoading ? '正在读取港口列表…' : '没有匹配的港口'}</div>`;

    state.portRenderedSignature = signature;
    if (keepScroll) list.scrollTop = previousScrollTop;
  }

  async function loadAvailablePorts(force) {
    if (state.portListLoading) return;
    if (!force && state.availablePorts.length) return;
    state.portListLoading = true;
    state.portError = '';
    renderPortManager();
    try {
      const data = await apiGet('/ports?includeTagged=false');
      const portList = requireArrayField(data, 'ports', '港口接口');
      state.availablePorts = normalizePortNames(portList.map((port) => port && port.portName));
    } catch (error) {
      if (!isAbortError(error)) state.portError = `港口列表读取失败：${error.message || '未知错误'}`;
    } finally {
      state.portListLoading = false;
      renderPortManager();
    }
  }

  function addManualPort() {
    const name = String(elements['mpe-port-add-input'].value || '').trim();
    if (!name) return;
    state.draftPortBlacklist.add(name);
    elements['mpe-port-add-input'].value = '';
    state.portNotice = '';
    state.portError = '';
    renderPortManager();
  }

  function exportPortBlacklist() {
    const ports = normalizePortNames([...state.draftPortBlacklist]);
    const payload = {
      format: 'mall-profit-port-blacklist',
      version: 1,
      exportedAt: new Date().toISOString(),
      ports
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    anchor.href = url;
    anchor.download = `mall-port-blacklist-${date}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importPortBlacklist(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = Core.parsePortBlacklistText(text);
      if (!parsed.ok) throw new Error(parsed.error);
      const ports = normalizePortNames(parsed.ports);
      state.draftPortBlacklist = new Set(ports);
      state.portError = '';
      state.portNotice = `已导入 ${ports.length} 个港口，点击“保存并关闭”后生效。`;
    } catch (error) {
      state.portNotice = '';
      state.portError = `导入失败：${error.message || '文件格式不正确'}`;
    } finally {
      event.target.value = '';
      state.portRenderedSignature = '';
      renderPortManager();
    }
  }

  async function savePortBlacklist() {
    const next = normalizePortNames([...state.draftPortBlacklist]);
    const changed = next.join('\u0000') !== normalizePortNames(state.portBlacklist).join('\u0000');
    state.portBlacklist = next;
    if (changed) {
      state.analysisCache = {};
      cancelOfferCalculation(false);
      // 缓存整套清空了，失败记录跟着作废，否则按钮会挂着已经无从补齐的计数
      state.offerErrors.clear();
      await clearAnalysisStorage();
      await persistPortBlacklist();
    }
    closePortManager();
    render();
  }
  function setMode(mode) {
    const nextMode = mode === 'total' ? 'total' : 'unit';
    if (nextMode === state.mode) return;
    state.mode = nextMode;
    state.sortKey = MODE_DEFAULT_SORT[nextMode];
    if (nextMode === 'unit' && state.anomalyMultiplier === 0) cancelOfferCalculation();
    renderMode();
    render();
  }

  function renderMode() {
    for (const button of document.querySelectorAll('.mpe-segment')) {
      button.classList.toggle('is-active', button.dataset.mode === state.mode);
    }
    const modeText = state.mode === 'total' ? L.totalRule : L.unitRule;
    const anomalyText = state.anomalyMultiplier > 0
      ? (' 异常报价按同商品中位数的 ' + state.anomalyMultiplier + ' 倍过滤。')
      : '';
    // 说清楚被藏掉的是「极值被乱标价污染」的行，并给出条数，免得用户以为物品凭空消失了
    const ratioText = state.priceRatioLimit > 0
      ? (' 最高收价超过最低卖价 ' + state.priceRatioLimit + ' 倍的物品已隐藏'
        + (state.priceRatioHiddenCount > 0
          ? '（' + integerFormatter.format(state.priceRatioHiddenCount) + ' 个）。'
          : '。'))
      : '';
    const blockedText = state.portBlacklist.length > 0
      ? (' 已屏蔽 ' + state.portBlacklist.length + ' 个港口的报价。')
      : '';
    // 库存核对的结果要报出来：这张排行榜的「最低卖价」默认是全站极值，
    // 里面混着大量标了价却没有货的挂单，不说明白用户会以为物品被吞了
    const stockText = Site.features.stockVerification && state.stockCheckedCount > 0
      ? (' 已按挂单库存核对 ' + integerFormatter.format(state.stockCheckedCount) + ' 个物品'
        + (state.stockExcludedCount > 0
          ? '，隐藏 ' + integerFormatter.format(state.stockExcludedCount) + ' 个缺货或价差为负的。'
          : '。')
        + (state.stockUncertainCount > 0
          ? (' 另有 ' + integerFormatter.format(state.stockUncertainCount) + ' 个物品挂单超过 200 条，没能逐条核对。')
          : ''))
      : '';
    elements['mpe-explainer'].textContent = modeText + anomalyText + ratioText + blockedText + stockText;
  }

  function getTableColumns() {
    return TABLE_COLUMNS[state.mode === 'total' ? 'total' : 'unit'];
  }

  // 当前排序键必须落在本模式真实存在的列上。总利润模式切回单件模式时
  // totalProfit-* 这一列已经不存在，这里会自动退回该模式的默认排序。
  function normalizeSortKey(columns) {
    const available = columns.filter((column) => column.field).map((column) => column.field);
    const parsed = Core.parseSortKey(state.sortKey);
    if (!available.includes(parsed.field)) {
      state.sortKey = MODE_DEFAULT_SORT[state.mode === 'total' ? 'total' : 'unit'];
      return Core.parseSortKey(state.sortKey);
    }
    state.sortKey = `${parsed.field}-${parsed.direction}`;
    return parsed;
  }

  // 点表头只重排表格，不会触发报价计算：计算始终只能由「开始计算 / 重新计算」手动触发
  function toggleSort(field) {
    const column = getTableColumns().find((item) => item.field === field);
    if (!field || !column) return;
    const current = Core.parseSortKey(state.sortKey);
    // 同一列再点一次就反转方向；换到新列时数值列先看大的（降序），商品列先按名称升序
    const direction = current.field === field
      ? (current.direction === 'asc' ? 'desc' : 'asc')
      : (Core.sortFields[field] === 'text' ? 'asc' : 'desc');
    state.sortKey = `${field}-${direction}`;
    render();
  }

  function renderTableHeader(columns) {
    const active = normalizeSortKey(columns);
    elements['mpe-thead'].innerHTML = `<tr>${columns.map((column) => {
      if (!column.field) {
        return `<th class="mpe-th-plain">${escapeHtml(column.label)}</th>`;
      }
      const isActive = column.field === active.field;
      const isAsc = active.direction === 'asc';
      const arrow = isActive ? (isAsc ? '▲' : '▼') : '⇅';
      const hint = isActive ? (isAsc ? '点击改为降序' : '点击改为升序') : '点击排序';
      const ariaSort = isActive ? (isAsc ? 'ascending' : 'descending') : 'none';
      return `<th aria-sort="${ariaSort}"${isActive ? ' data-active="true"' : ''}>`
        + `<button class="mpe-th-button${isActive ? ' is-active' : ''}" type="button"`
        + ` data-sort-field="${column.field}" title="${escapeHtml(`${column.label} · ${hint}`)}">`
        + `<span class="mpe-th-label">${escapeHtml(column.label)}</span>`
        + `<span class="mpe-th-arrow" aria-hidden="true">${arrow}</span>`
        + '</button></th>';
    }).join('')}</tr>`;
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(resolve, ms);
      if (!signal) return;
      signal.addEventListener('abort', () => {
        window.clearTimeout(timer);
        reject(createAbortError());
      }, { once: true });
    });
  }

  function createAbortError() {
    const error = new Error('已取消');
    error.name = 'AbortError';
    return error;
  }

  function isAbortError(error) {
    return error && error.name === 'AbortError';
  }

  async function apiGet(path, signal, retries = CONFIG.fetchRetries) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(`${Site.apiBase || ''}${path}`, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal
        });

        if (!response.ok) {
          const error = new Error(`商城接口返回 ${response.status}`);
          error.status = response.status;
          throw error;
        }

        return await response.json();
      } catch (error) {
        if (isAbortError(error)) throw error;
        lastError = error;
        const status = Number(error && error.status);
        const retryable = !status || status === 429 || status >= 500;
        if (!retryable || attempt >= retries) break;
        await sleep(350 * (attempt + 1), signal);
      }
    }
    throw lastError || new Error('商城接口请求失败');
  }

  function requireArrayField(payload, field, label) {
    if (!payload || typeof payload !== 'object') {
      throw new Error(`${label}返回格式异常（不是 JSON 对象）`);
    }
    const value = payload[field];
    if (!Array.isArray(value)) {
      throw new Error(`${label}缺少 ${field} 数组字段，商城接口可能已变更`);
    }
    return value;
  }

  async function mapLimit(values, limit, worker, signal) {
    let nextIndex = 0;

    async function run() {
      while (true) {
        if (signal && signal.aborted) throw createAbortError();
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        await worker(values[index], index);
      }
    }

    const workerCount = Math.min(limit, values.length);
    await Promise.all(Array.from({ length: workerCount }, () => run()));
  }

  // 拉全站物品列表。两个站点的差别只在这里：
  // - mall 是分页目录（8000+ 商品，按 offset 并发翻页）
  // - SMCShop 一个请求就把全库聚合成 summaries 返回（item 留空时服务端直接给汇总）
  async function fetchCatalog(signal) {
    const catalog = Site.catalog;

    if (catalog.kind === 'single') {
      updateProgress('正在读取物品列表', 0, 1);
      const payload = await apiGet(catalog.path, signal);
      const list = requireArrayField(payload, catalog.listField, '物品列表接口');
      return { items: dedupeItems(list.map((entry) => Site.toItem(entry))), total: list.length };
    }

    const pageSize = catalog.pageSize;
    const firstPage = await apiGet(catalog.path(0, pageSize), signal);
    const firstItems = requireArrayField(firstPage, catalog.listField, '物品列表接口');
    const reportedTotal = Number(firstPage[catalog.totalField]);
    const total = Number.isFinite(reportedTotal) && reportedTotal >= 0 ? reportedTotal : firstItems.length;

    const items = [...firstItems];
    const offsets = [];
    for (let offset = pageSize; offset < total; offset += pageSize) offsets.push(offset);

    const totalPages = 1 + offsets.length;
    let completedPages = 1;
    updateProgress('正在读取物品列表', completedPages, totalPages);

    await mapLimit(offsets, CONFIG.listConcurrency, async (offset) => {
      const page = await apiGet(catalog.path(offset, pageSize), signal);
      items.push(...requireArrayField(page, catalog.listField, '物品列表接口'));
      completedPages += 1;
      updateProgress('正在读取物品列表', completedPages, totalPages);
    }, signal);

    return { items: dedupeItems(items), total };
  }

  // 按物品名去重，顺便把字段规整成统一形状；同一物品重复出现时以最后一条为准
  function dedupeItems(rawItems) {
    const deduplicated = new Map();
    for (const rawItem of rawItems) {
      const item = Core.normalizeItem(rawItem);
      if (item) deduplicated.set(item.itemName, item);
    }
    return [...deduplicated.values()];
  }

  async function loadMarket(force) {
    if (state.dataLoading) return;
    if (!force && state.items.length && isFresh(state.marketSavedAt)) {
      render();
      return;
    }

    state.dataLoading = true;
    state.error = '';
    state.offerErrors.clear();
    // 换了商品快照，上一份挂单核对的结论就全作废了；正在跑的那轮也一起停掉
    cancelStockVerification();
    state.stockErrors.clear();
    state.stockStopped = false;
    state.marketController = new AbortController();
    setBusy();
    render();
    updateProgress('正在读取物品列表', 0, 1);

    try {
      if (force) await clearStoredData();
      const result = await fetchCatalog(state.marketController.signal);
      state.items = result.items;
      state.unitRows = Core.buildUnitRows(result.items);
      state.marketSavedAt = Date.now();
      state.totalCache = {};
      state.analysisCache = {};
      state.stockCache = {};
      await clearAnalysisStorage();
      await persistMarket();
      render();
      scheduleHideProgress();
    } catch (error) {
      if (!isAbortError(error)) {
        state.error = `物品列表读取失败：${error.message || '未知错误'}`;
      }
      hideProgress();
      render();
    } finally {
      state.dataLoading = false;
      state.marketController = null;
      setBusy();
      render();
    }
  }

  async function handleRefresh() {
    if (state.dataLoading || state.offerLoading) return;
    state.totalCache = {};
    state.analysisCache = {};
    state.offerErrors.clear();
    await clearStoredData();
    await loadMarket(true);
  }

  async function fetchAllOffers(itemName, mode, signal) {
    const offers = [];
    let offset = 0;
    let total = Infinity;
    let guard = 0;
    let truncated = false;

    while (offset < total && offers.length < CONFIG.maxOffers && guard < 250) {
      guard += 1;
      const page = await apiGet(Site.offers.path(itemName, mode, offset, CONFIG.offerPageSize), signal);
      const pageOffers = requireArrayField(page, 'offers', '报价接口');
      const reportedTotal = Number(page.total);
      if (Number.isFinite(reportedTotal) && reportedTotal >= 0) total = reportedTotal;
      if (!pageOffers.length) break;
      offers.push(...pageOffers);
      offset += pageOffers.length;
    }

    if (offers.length >= CONFIG.maxOffers || guard >= 250) {
      truncated = Number.isFinite(total) ? offers.length < total : true;
    }

    return { offers, truncated };
  }

  function isFresh(timestamp) {
    return Number.isFinite(timestamp) && Date.now() - timestamp < CONFIG.cacheTtlMs;
  }

  // for-in 碰到第一个键就返回，对非空对象是 O(1)，不会像 Object.keys() 那样还得把键收集一遍
  // state.unitRows 在 loadMarket / loadStoredData 里跟着 items 一起生成，
  // 这里兜底「items 有了、unitRows 还没建」的那一瞬
  function getUnitRows() {
    return state.unitRows.length ? state.unitRows : Core.buildUnitRows(state.items);
  }

  function hasAnyKey(object) {
    for (const key in object) return true;
    return false;
  }

  // 「算过没有」只看有没有缓存条目，不看有没有过期——用来决定按钮写「开始计算」还是「重新计算」。
  // 过期结果现在也会显示，如果这里还按新鲜度判断，就会出现「表里有旧数据、状态栏提示重新计算、
  // 按钮却写开始计算」的矛盾。
  function hasCachedResult() {
    if (state.anomalyMultiplier > 0 || state.portBlacklist.length > 0) {
      return hasAnyKey(getCurrentAnalysisCache());
    }
    if (state.mode === 'total') return hasAnyKey(state.totalCache);
    return false;
  }

  function hasFreshTotal(itemName) {
    const entry = state.totalCache[itemName];
    return Boolean(entry && isFresh(entry.updatedAt));
  }

  function normalizePortNames(values) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map((port) => String(port || '').trim())
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  function hashText(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function getAnalysisCacheKey(multiplier, blacklist) {
    const ports = normalizePortNames(blacklist);
    return `${multiplier}:${hashText(ports.join('\n'))}`;
  }

  function getCurrentAnalysisCache() {
    const key = getAnalysisCacheKey(state.anomalyMultiplier, state.portBlacklist);
    if (!state.analysisCache[key]) state.analysisCache[key] = {};
    return state.analysisCache[key];
  }

  // cache 由调用方传进来：算报价前要按行问「哪些还没算过」，成千上万次调用，
  // 而 getCurrentAnalysisCache() 每次都重算 key（港口名排序 + hash），传引用能整轮省掉
  function hasFreshAnalysis(cache, itemName) {
    const entry = cache[itemName];
    return Boolean(entry && isFresh(entry.updatedAt));
  }

  // 库存核对的缓存：跟异常分析一样按「有没有新鲜结果」判断，过期就重新核对
  function hasFreshStock(itemName) {
    const entry = state.stockCache[itemName];
    return Boolean(entry && isFresh(entry.updatedAt));
  }

  // 核对一个物品到底有没有货：拉它的挂单明细，只在 amount > 0 的挂单里取极值。
  // 一个请求就够——不带 type 时服务端会把 SELL 和 BUY 一起返回（实测过）。
  async function fetchItemStock(row, signal) {
    const payload = await apiGet(Site.stock.path(row.itemName), signal);
    const listings = requireArrayField(payload, Site.stock.listField, '挂单接口');
    const prices = Core.resolveInStockPrices(listings, row.itemName, { cap: Site.stock.cap });
    const updatedAt = Date.now();
    const counts = { sellCount: prices.sellCount, buyCount: prices.buyCount };

    // 接口不再返回库存字段：读不到库存不等于没货，显式报出来并按「核不准」处理
    if (prices.unknownShape) {
      state.stockShapeWarning = true;
      return { status: 'uncertain', updatedAt };
    }
    // 一次最多返回 cap 条。截断时数组里可能整段缺一类挂单（实测查「圆石」200 条全是卖单），
    // 而且返回顺序不保证按价格，所以不能断定没货——退回聚合值，宁可留着虚高也不凭空误杀。
    if (prices.truncated) return { status: 'uncertain', updatedAt };

    // 有货的卖单或收单缺一边，就是买不到或卖不掉；两头都有但价差不是正数，同样没得赚
    const { minSellPrice, maxBuyPrice } = prices;
    if (minSellPrice === null || maxBuyPrice === null || !(maxBuyPrice - minSellPrice > 0)) {
      return { status: 'excluded', updatedAt, ...counts };
    }
    return { status: 'ok', minSellPrice, maxBuyPrice, updatedAt, ...counts };
  }

  // 自动核对挂单库存。范围就是「当前筛选结果」：先按搜索 / 最少商店数 / 版本筛，
  // 再把倍率已经判掉的行剔出去——成书那种 125000 倍的物品不值得再为它发请求，
  // 所以搜「锭」可能只剩十几条要核。
  // 由 render() 收口触发（带防抖），而不是散在各个事件里：任何改动的落点最后都要 render，
  // 挂在一处就不会漏；重复触发由 stockLoading 挡住。
  const stockDebouncedVerify = debounce(() => void verifyStock(), CONFIG.inputDebounceMs);

  function scheduleStockVerification() {
    if (!Site.features.stockVerification || !state.panelOpen) return;
    // 「停止核对」按下去之后就别再自动开始了，否则一 render 又从头拉一遍
    if (state.stockStopped) return;
    if (state.dataLoading || state.stockLoading || !state.items.length) return;
    stockDebouncedVerify();
  }

  // 已经核对过的行不再进待办，所以中途改筛选、再改回来都不会重复请求
  function getStockTargets() {
    return getFilteredRows().filter((row) => (
      !row.stockExcluded
      && withinPriceRatio(row)
      && !hasFreshStock(row.itemName)
      && !state.stockErrors.has(row.itemName)
    ));
  }

  async function verifyStock() {
    if (!Site.features.stockVerification || state.stockLoading || state.dataLoading) return;
    if (!state.items.length) return;

    const targets = getStockTargets();
    // 没有待办就直接返回，别顺手 render：render 末尾又会安排下一次核对，
    // 空待办还重绘一次就会变成「每 220 毫秒重绘一次」的死循环
    if (!targets.length) return;

    const runId = state.stockRunId + 1;
    state.stockRunId = runId;
    state.stockLoading = true;
    const controller = new AbortController();
    state.stockController = controller;
    let completed = 0;
    let writesSincePersist = 0;
    setBusy();
    updateProgress('正在核对挂单库存', 0, targets.length);

    try {
      await mapLimit(targets, CONFIG.stockConcurrency, async (row) => {
        try {
          state.stockCache[row.itemName] = await fetchItemStock(row, controller.signal);
          writesSincePersist += 1;
          if (writesSincePersist >= 10) {
            writesSincePersist = 0;
            await persistStockCache();
          }
        } catch (error) {
          if (isAbortError(error)) throw error;
          state.stockErrors.add(row.itemName);
        } finally {
          completed += 1;
          if (runId === state.stockRunId) {
            updateProgress('正在核对挂单库存', completed, targets.length);
            // 每隔一小批重绘一次，缺货的行是逐批消失的，不用等三百条全核完
            if (completed % 12 === 0) render();
          }
        }
      }, controller.signal);

      await persistStockCache();
      hideProgress();
    } catch (error) {
      if (!isAbortError(error)) {
        state.error = `挂单库存核对失败：${error.message || '未知错误'}`;
      }
      if (runId === state.stockRunId) hideProgress();
    } finally {
      if (runId === state.stockRunId) {
        state.stockLoading = false;
        state.stockController = null;
        setBusy();
        render();
      }
    }
  }

  async function ensureAnomalyAnalysis(force, retryOnly = false) {
    if (state.dataLoading || (state.anomalyMultiplier <= 0 && state.portBlacklist.length === 0)) return;
    if (!state.items.length) {
      await loadMarket(false);
      if (!state.items.length) return;
    }

    const multiplier = state.anomalyMultiplier;
    const blacklist = normalizePortNames(state.portBlacklist);
    const cacheKey = getAnalysisCacheKey(multiplier, blacklist);

    if (state.offerLoading && !force) return;
    if (force) {
      state.analysisCache[cacheKey] = {};
      cancelOfferCalculation(false);
    }

    if (!state.analysisCache[cacheKey]) state.analysisCache[cacheKey] = {};
    const cache = state.analysisCache[cacheKey];
    // 待办 = 计算范围内的行里还没有新鲜结果的。默认范围是全量商品，选了「当前筛选结果」
    // 就是筛选出来的全部行。
    // 「重试失败项」不吃范围限制，直接在全量里挑上一轮失败的那些——用户点这个按钮要补的
    // 就是那几个，不该因为随后改了范围就变成重算几百条。
    const targets = retryOnly ? getUnitRows() : getScopeTargets();
    // offerErrors 必须在切出待办之后再清，否则就找不到上一轮失败的到底是哪几个了
    const failed = retryOnly ? new Set(state.offerErrors) : null;
    const pending = targets.filter((row) => !hasFreshAnalysis(cache, row.itemName));
    const missing = failed ? pending.filter((row) => failed.has(row.itemName)) : pending;
    state.offerErrors.clear();
    state.truncatedCount = 0;

    if (!missing.length) {
      state.offerLoading = false;
      render();
      return;
    }

    const runId = state.offerRunId + 1;
    state.offerRunId = runId;
    state.offerLoading = true;
    const offerController = new AbortController();
    const offerSignal = offerController.signal;
    state.offerController = offerController;
    // 重试时进度条只反映这一小撮补齐项，用全量当分母会让它一上来就停在 99%
    const total = retryOnly ? missing.length : targets.length;
    let completed = total - missing.length;
    let writesSincePersist = 0;
    let truncatedItems = 0;
    setBusy();
    render();
    updateProgress('正在过滤异常报价', completed, total);

    try {
      await mapLimit(missing, CONFIG.offerConcurrency, async (row) => {
        try {
          const [buyResult, sellResult] = await Promise.all([
            fetchAllOffers(row.itemName, 'buy', offerSignal),
            fetchAllOffers(row.itemName, 'sell', offerSignal)
          ]);
          if (buyResult.truncated || sellResult.truncated) truncatedItems += 1;
          const analysis = Core.buildOfferAnalysis(buyResult.offers, sellResult.offers, multiplier, blacklist);
          cache[row.itemName] = {
            ...analysis,
            multiplier,
            updatedAt: Date.now()
          };
          writesSincePersist += 1;
          if (writesSincePersist >= 10) {
            writesSincePersist = 0;
            await persistAnalysisCache();
          }
        } catch (error) {
          if (isAbortError(error)) throw error;
          state.offerErrors.add(row.itemName);
        } finally {
          completed += 1;
          if (runId === state.offerRunId) {
            updateProgress('正在过滤异常报价', completed, total);
          }
        }
      }, offerSignal);

      await persistAnalysisCache();
      hideProgress();
    } catch (error) {
      if (!isAbortError(error)) {
        state.error = `异常价格过滤失败：${error.message || '未知错误'}`;
      }
      if (runId === state.offerRunId) hideProgress();
    } finally {
      if (runId === state.offerRunId) {
        state.truncatedCount = truncatedItems;
        state.offerLoading = false;
        state.offerController = null;
        setBusy();
        render();
      }
    }
  }
  async function ensureTotalProfits(force, retryOnly = false) {
    if (state.dataLoading) return;
    if (!state.items.length) {
      await loadMarket(false);
      if (!state.items.length) return;
    }

    if (state.offerLoading && !force) return;
    if (force) {
      state.totalCache = {};
      cancelOfferCalculation(false);
    }

    // 同 ensureAnomalyAnalysis：范围默认全量，选「当前筛选结果」就只算筛选出来的那些；
    // 「重试失败项」不受范围影响，只补上一轮报错的那几个。
    const targets = retryOnly ? getUnitRows() : getScopeTargets();
    const failed = retryOnly ? new Set(state.offerErrors) : null;
    const pending = targets.filter((row) => !hasFreshTotal(row.itemName));
    const missing = failed ? pending.filter((row) => failed.has(row.itemName)) : pending;
    state.offerErrors.clear();
    state.truncatedCount = 0;

    if (!missing.length) {
      state.offerLoading = false;
      render();
      return;
    }

    const runId = state.offerRunId + 1;
    state.offerRunId = runId;
    state.offerLoading = true;
    const offerController = new AbortController();
    const offerSignal = offerController.signal;
    state.offerController = offerController;
    // 重试时进度条只反映这一小撮补齐项，用全量当分母会让它一上来就停在 99%
    const total = retryOnly ? missing.length : targets.length;
    let completed = total - missing.length;
    let writesSincePersist = 0;
    let truncatedItems = 0;
    setBusy();
    render();
    updateProgress('正在计算总利润', completed, total);

    try {
      await mapLimit(missing, CONFIG.offerConcurrency, async (row) => {
        try {
          const [buyResult, sellResult] = await Promise.all([
            fetchAllOffers(row.itemName, 'buy', offerSignal),
            fetchAllOffers(row.itemName, 'sell', offerSignal)
          ]);
          if (buyResult.truncated || sellResult.truncated) truncatedItems += 1;
          const result = Core.calculateMatchedProfit(buyResult.offers, sellResult.offers);
          state.totalCache[row.itemName] = {
            ...result,
            updatedAt: Date.now()
          };
          writesSincePersist += 1;
          if (writesSincePersist >= 10) {
            writesSincePersist = 0;
            await persistTotalCache();
          }
        } catch (error) {
          if (isAbortError(error)) throw error;
          state.offerErrors.add(row.itemName);
        } finally {
          completed += 1;
          if (runId === state.offerRunId) {
            updateProgress('正在计算总利润', completed, total);
          }
        }
      }, offerSignal);

      await persistTotalCache();
      hideProgress();
    } catch (error) {
      if (!isAbortError(error)) {
        state.error = `总利润计算失败：${error.message || '未知错误'}`;
      }
      if (runId === state.offerRunId) hideProgress();
    } finally {
      if (runId === state.offerRunId) {
        state.truncatedCount = truncatedItems;
        state.offerLoading = false;
        state.offerController = null;
        setBusy();
        render();
      }
    }
  }

  // 停掉正在跑的那一轮库存核对。abort 之后 mapLimit 会把 AbortError 抛回来，
  // verifyStock 的 catch 认得出它，不会当成「这几个物品核对失败」记一笔。
  function cancelStockVerification() {
    if (state.stockController) state.stockController.abort();
    state.stockRunId += 1;
    state.stockLoading = false;
    state.stockController = null;
  }

  function cancelOfferCalculation(renderAfter = true) {
    if (state.offerController) state.offerController.abort();
    state.offerRunId += 1;
    state.offerLoading = false;
    state.offerController = null;
    // 「停止计算」也要能停掉挂单库存核对：它不算是计算，但一样是几百个请求。
    // 停下来之后在下次刷新数据之前不再自动开始，否则一 render 又从头拉一遍。
    cancelStockVerification();
    if (Site.features.stockVerification) state.stockStopped = true;
    hideProgress();
    setBusy();
    if (renderAfter) render();
  }

  function updateProgress(label, current, total) {
    if (!elements['mpe-progress']) return;
    state.progress = { label, current, total };
    const safeTotal = Math.max(0, Number(total) || 0);
    const safeCurrent = Math.max(0, Number(current) || 0);
    const percent = safeTotal > 0 ? Math.min(100, (safeCurrent / safeTotal) * 100) : 0;
    elements['mpe-progress'].hidden = false;
    elements['mpe-progress-text'].textContent = label;
    elements['mpe-progress-count'].textContent = safeTotal > 0 ? `${integerFormatter.format(safeCurrent)} / ${integerFormatter.format(safeTotal)}` : '';
    elements['mpe-progress-bar'].style.width = `${percent}%`;
    elements['mpe-cancel'].hidden = !(state.offerLoading || state.stockLoading);
    setBusy();
  }

  function hideProgress() {
    state.progress = null;
    if (!elements['mpe-progress']) return;
    elements['mpe-progress'].hidden = true;
    elements['mpe-cancel'].hidden = true;
  }

  function scheduleHideProgress() {
    window.setTimeout(() => {
      if (!state.dataLoading && !state.offerLoading && !state.stockLoading) hideProgress();
    }, 500);
  }

  // 当前模式下有没有「需要算」的东西。只做单件利润的站点永远是 false：
  // 它的价格是服务端聚合好的，打开面板就能看到，不存在计算这一步。
  function isCalculable() {
    return state.anomalyMultiplier > 0
      || state.portBlacklist.length > 0
      || (state.mode === 'total' && Site.features.totalProfit);
  }

  function calculationNeeded() {
    if (!state.items.length) return true;
    const rows = getUnitRows();
    if (state.anomalyMultiplier > 0 || state.portBlacklist.length > 0) {
      const cache = getCurrentAnalysisCache();
      return rows.some((row) => !hasFreshAnalysis(cache, row.itemName));
    }
    if (state.mode === 'total') {
      return rows.some((row) => !hasFreshTotal(row.itemName));
    }
    return false;
  }

  // force=true 是「开始计算 / 重新计算」：清掉当前条件下的结果从头算。
  // force=false 是「重试失败项」：只补上一轮失败的那些，已经算好的结果原样保留。
  // retryOnly 会额外把范围收窄到 offerErrors 里记着的那几个商品，避免用户之后改了计算范围，
  // 一点「重试失败项」变成顺手把整个新范围都算一遍。
  async function runCalculation(force = true, retryOnly = false) {
    if (state.dataLoading || state.offerLoading) return;
    state.error = '';
    if (!state.items.length) {
      await loadMarket(false);
      if (!state.items.length) return;
    }
    if (state.anomalyMultiplier > 0 || state.portBlacklist.length > 0) {
      await ensureAnomalyAnalysis(force, retryOnly);
      return;
    }
    if (state.mode === 'total') {
      await ensureTotalProfits(force, retryOnly);
      return;
    }
    render();
  }
  function setBusy() {
    if (!elements['mpe-refresh']) return;
    // 挂单库存核对也是「正在占着网络」，按钮得一起锁住，但文案要分得清是在干什么
    const verifying = state.stockLoading && !state.offerLoading;
    const busy = state.dataLoading || state.offerLoading || state.stockLoading;
    elements['mpe-refresh'].disabled = busy;
    elements['mpe-refresh'].textContent = state.dataLoading
      ? '读取中…'
      : verifying
        ? '核对中…'
        : state.offerLoading
          ? '计算中…'
          : '刷新数据';
    elements['mpe-cancel'].textContent = verifying ? '停止核对' : '停止计算';

    const calculable = isCalculable();
    elements['mpe-calculate'].disabled = busy || !state.items.length || !calculable;
    // 带上条数：范围可能是「当前筛选结果」这样的一小撮，
    // 只写「开始计算」用户没法预判这一下要发出去多少请求
    const scopeSuffix = state.scopeTargetCount > 0
      ? `（${integerFormatter.format(state.scopeTargetCount)} 条）`
      : '';
    elements['mpe-calculate'].textContent = state.dataLoading
      ? '读取中…'
      : state.offerLoading
        ? '计算中…'
        : !calculable
          ? '无需计算'
          : (calculationNeeded() && !hasCachedResult() ? '开始计算' : '重新计算') + scopeSuffix;

    // 失败的条目不会被写进缓存，所以「重试失败项」就是不带 force 地再跑一轮计算，
    // 幂等的补齐逻辑天然只会重新请求它们，已经算好的结果不动
    const failed = state.offerErrors.size;
    elements['mpe-retry'].hidden = busy || failed === 0;
    elements['mpe-retry'].disabled = busy;
    elements['mpe-retry'].textContent = `重试失败项（${integerFormatter.format(failed)}）`;
  }

  // 「看什么」的筛选条件只留这一份：搜索、最低在售数量、商品版本。
  // 抽出来是因为「只计算当前筛选结果」得在分析缓存还空着的时候先筛一遍商品快照——
  // 那会儿表格里绝大多数行还没有结果会被判成不可见，筛出来是 0 条。
  // 倍率上限与库存核对不写在这里：它们是「这一行该不该显示」的判据，走 isRowVisible，
  // 因为说明文字要分别报出这两类各隐藏了多少条。
  function matchesFilter(row, search) {
    if (search && !row.itemName.toLocaleLowerCase('zh-CN').includes(search)) return false;
    if (row.sellAmount < state.minSellAmount) return false;
    const isVanilla = Boolean(row.vanillaId);
    if (state.vanillaFilter === 'vanilla' && !isVanilla) return false;
    if (state.vanillaFilter === 'non-vanilla' && isVanilla) return false;
    return true;
  }

  function withinPriceRatio(row) {
    return Core.withinPriceRatio(row.maxBuyPrice, row.minSellPrice, state.priceRatioLimit);
  }

  // 过了「看什么」之后，这一行还该不该出现。缺货（买了没货 / 没人收）和倍率超上限都在这儿挡掉，
  // 表格和「隐藏了几条」的计数共用这一个判据。
  function isRowVisible(row) {
    if (row.stockExcluded) return false;
    return withinPriceRatio(row);
  }

  function currentSearchKeyword() {
    return state.search.trim().toLocaleLowerCase('zh-CN');
  }

  // 把分析 / 总利润 / 库存核对的结果合并进商品快照行，表格和计算范围共用这一份数字。
  // 两边各算一套的话，「最低在售数量」会在表格里按「剔除异常报价后的数量」筛、
  // 在计算范围里按商城原始快照筛，于是出现「表里只剩 3 行、按钮却写要算 37 条」。
  // strict=true（表格）丢掉「还没算过」「被异常规则判定排除」「核对后发现缺货」的行；
  // strict=false 保留它们——点计算的时候缓存本来就是空的，全丢掉就没东西可算了，
  // 说明文字也得靠它数出「共隐藏了几条」。
  function mergeRow(row, cache, strict) {
    if (state.anomalyMultiplier > 0 || state.portBlacklist.length > 0) {
      const analysis = cache[row.itemName];
      if (!analysis) return strict ? null : { ...row };
      // 被异常规则排除的行在表格里不显示，但报价变了之后它可能重新合格，所以范围里照样要算
      if (analysis.excluded) {
        return strict ? null : { ...row, sellAmount: analysis.sellAmount };
      }
      return {
        ...row,
        minSellPrice: analysis.minSellPrice,
        maxBuyPrice: analysis.maxBuyPrice,
        sellAmount: analysis.sellAmount,
        sellOfferCount: analysis.sellOfferCount,
        buyOfferCount: analysis.buyOfferCount,
        unitProfit: analysis.unitProfit,
        profitRate: analysis.profitRate,
        totalProfit: analysis.totalProfit,
        matchedQty: analysis.matchedQty,
        outlierCount: analysis.outlierCount,
        // 单纯过了 5 分钟有效期不再丢行——否则用户算完过一会儿回来会看到整张表凭空变空
        stale: !isFresh(analysis.updatedAt)
      };
    }

    // 库存核对的结果在这里生效：两个价格换成「有货的极值」，利润跟着重算。
    // 缺货的行标记出来而不是直接丢，strict=false 那份要靠它统计隐藏条数。
    const stock = Site.features.stockVerification ? state.stockCache[row.itemName] : null;
    if (stock) {
      if (stock.status === 'excluded') {
        return strict ? null : { ...row, stockExcluded: true };
      }
      if (stock.status === 'ok') {
        const unitProfit = stock.maxBuyPrice - stock.minSellPrice;
        return {
          ...row,
          minSellPrice: stock.minSellPrice,
          maxBuyPrice: stock.maxBuyPrice,
          sellOfferCount: stock.sellCount,
          buyOfferCount: stock.buyCount,
          unitProfit,
          profitRate: (unitProfit / stock.minSellPrice) * 100,
          stockVerified: true,
          stale: !isFresh(stock.updatedAt)
        };
      }
      // uncertain：挂单超过上限被截断（或接口不再返回库存字段），核不准，保留聚合值
      return { ...row, stockUncertain: true, stale: !isFresh(state.marketSavedAt) };
    }

    const total = state.totalCache[row.itemName];
    // 单件利润模式下表格里的数字来自商品快照，跟总利润缓存是否过期无关；
    // 但快照本身也会过期，照样打上 stale，状态栏才能提示「可以刷新一下了」
    if (!total || state.mode !== 'total') return { ...row, stale: !isFresh(state.marketSavedAt) };
    return {
      ...Core.withTotalProfit(row, total),
      stale: !isFresh(total.updatedAt)
    };
  }

  // 过了「看什么」的全部行。
  // strict=true 是表格那份：还没算过、被异常规则判掉、核对后发现缺货的行都不在里面；
  // strict=false 保留它们，因为说明文字的计数、以及「当前筛选结果」这个计算范围都要用它
  // （点计算时缓存本来就是空的，全丢掉就没东西可算了）。
  function getFilteredRows(strict = false) {
    const search = currentSearchKeyword();
    const cache = getCurrentAnalysisCache();
    return state.unitRows
      .map((row) => mergeRow(row, cache, strict))
      .filter((row) => Boolean(row) && matchesFilter(row, search));
  }

  // 计算范围要算的行：默认全部正利润商品，选「当前筛选结果」就是表格里显示的那些（未排序）
  function getScopeTargets(filtered) {
    if (state.calcScope !== 'filtered') return state.unitRows;
    return getScopeRows(filtered || getFilteredRows());
  }

  function getScopeRows(filtered) {
    return filtered.filter(isRowVisible);
  }

  function getVisibleRows() {
    return Core.sortRows(getScopeRows(getFilteredRows(true)), state.sortKey);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function formatNumber(value) {
    return Number.isFinite(value) ? numberFormatter.format(value) : '—';
  }

  function formatPercent(value) {
    return Number.isFinite(value) ? `${numberFormatter.format(value)}%` : '—';
  }

  function formatTime(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '尚未更新';
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(timestamp));
  }

  let highlightedRow = null;
  let highlightTimer = 0;

  // 商城是同一个 SPA 挂在多个路径上的：`/`、`/mall`、`/mall/` 打开的都是带物品表的商城首页，
  // 而且服务端对任意路径都返回同一份外壳。所以判断"是不是商城页"只能看页面里有没有
  // 商城的物品表或搜索框，不能看 URL 路径，否则从 `/` 进来的用户会被直接拦掉。
  function hasMallUi() {
    return Boolean(findMallItemTable() || findMallSearchInput());
  }

  function waitForMallUi(timeoutMs) {
    if (hasMallUi()) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      let timer = 0;
      let poll = 0;

      const finish = (ready) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.clearInterval(poll);
        resolve(ready);
      };

      poll = window.setInterval(() => {
        if (settled) return;
        if (hasMallUi()) finish(true);
      }, 120);
      timer = window.setTimeout(() => finish(false), timeoutMs);
    });
  }

  function findMallItemTable() {
    for (const table of document.querySelectorAll('table')) {
      if (table.closest('#mpe-root')) continue;
      const head = table.querySelector('thead');
      if (head && head.textContent.includes(CONFIG.mallItemTableHeader)) return table;
    }
    return null;
  }

  function findLeafWithText(root, text) {
    if (!root) return null;
    if (!root.children.length) return root.textContent.trim() === text ? root : null;
    for (const child of root.children) {
      const match = findLeafWithText(child, text);
      if (match) return match;
    }
    return null;
  }

  function findMallItemRow(itemName) {
    const table = findMallItemTable();
    if (!table) return null;
    // 精确匹配整数个文本节点，避免「石头」误命中「圆石」
    for (const row of table.querySelectorAll('tbody tr')) {
      if (findLeafWithText(row, itemName)) return row;
    }
    return null;
  }

  function findMallSearchInput() {
    const exact = document.querySelector(`input[placeholder="${CONFIG.mallSearchPlaceholder}"]`);
    if (exact && !exact.closest('#mpe-root')) return exact;
    for (const input of document.querySelectorAll('input')) {
      if (input.closest('#mpe-root')) continue;
      const placeholder = input.getAttribute('placeholder') || '';
      if (placeholder.includes('物品')) return input;
    }
    return null;
  }

  function setNativeInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function waitForMallItemRow(itemName, timeoutMs) {
    const immediate = findMallItemRow(itemName);
    if (immediate) return Promise.resolve(immediate);

    // 商城在搜索时会整表卸载再重挂，任何绑定在旧节点上的监听都会失效，
    // 所以这里用轮询定位，不去依赖某个具体节点是否还挂在文档上。
    return new Promise((resolve) => {
      let settled = false;
      let timer = 0;
      let poll = 0;

      const finish = (row) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.clearInterval(poll);
        resolve(row);
      };

      const check = () => {
        if (settled) return;
        const row = findMallItemRow(itemName);
        if (row) finish(row);
      };

      poll = window.setInterval(check, 120);
      timer = window.setTimeout(() => finish(null), timeoutMs);
    });
  }

  function scrollRowIntoView(row) {
    if (typeof row.scrollIntoView !== 'function') return;
    try {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch {
      try {
        row.scrollIntoView();
      } catch {
        // 个别环境不支持 scrollIntoView，滚动失败不影响跳转本身
      }
    }
  }

  function clearHighlight() {
    window.clearTimeout(highlightTimer);
    highlightTimer = 0;
    if (highlightedRow) {
      highlightedRow.classList.remove('mpe-jump-target');
      highlightedRow = null;
    }
  }

  function activateMallRow(row, itemName) {
    scrollRowIntoView(row);

    // 商城的 onClick 挂在 React 根节点上，必须派发可冒泡的真实事件
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

    // 搜索路径下商城会整表重挂，这里拿到的一定是新节点，高亮直接打在新节点上即可
    clearHighlight();
    row.classList.add('mpe-jump-target');
    highlightedRow = row;
    highlightTimer = window.setTimeout(() => {
      if (highlightedRow === row) clearHighlight();
    }, CONFIG.highlightMs);
  }

  async function jumpToItem(itemName) {
    if (state.jumpBusy || !itemName) return;

    state.error = '';
    state.jumpNotice = '';
    state.jumpBusy = itemName;
    renderStatus();

    try {
      if (Site.jump.kind === 'smcshop') {
        state.jumpNotice = await jumpInSmcshop(itemName);
        closePanel();
        return;
      }
      state.jumpNotice = await jumpInMall(itemName);
    } catch (error) {
      state.error = `跳转失败：${error.message || '未知错误'}`;
    } finally {
      state.jumpBusy = '';
      render();
    }
  }

  // mall：面板不关闭、也不收窄，商城自己的物品详情会显示在面板之上
  async function jumpInMall(itemName) {
    // 商城 DOM 可能尚未挂载完成（例如刚刷新页面），先给它一点时间再判定失败
    if (!(await waitForMallUi(CONFIG.mallUiTimeoutMs))) {
      throw new Error('当前页面没有商城物品列表，请先打开商城页面再点击物品名');
    }

    let searchInput = null;
    let previousSearch = '';
    let row = findMallItemRow(itemName);

    if (!row) {
      searchInput = findMallSearchInput();
      if (!searchInput) {
        throw new Error('没有找到商城的物品搜索框，请确认商城页面已经完全加载');
      }
      previousSearch = searchInput.value;
      const alreadySearched = previousSearch.trim() === itemName;
      if (!alreadySearched) setNativeInputValue(searchInput, itemName);
      row = await waitForMallItemRow(itemName, alreadySearched ? 600 : CONFIG.jumpTimeoutMs);
    }

    if (!row) {
      // 商城搜索会整表重挂，原先抓到的 input 节点可能已脱离文档，回滚前重新定位一次
      const restoreInput = findMallSearchInput() || searchInput;
      if (restoreInput && previousSearch !== restoreInput.value) {
        setNativeInputValue(restoreInput, previousSearch);
      }
      throw new Error(`商城列表中没有找到「${itemName}」，可能已下架，或商城正被港口筛选限制`);
    }

    const calculationRunning = state.offerLoading;
    activateMallRow(row, itemName);
    return calculationRunning
      ? `已打开「${itemName}」详情，面板保持打开，后台计算仍在继续。`
      : `已打开「${itemName}」详情，面板保持打开，关掉详情即可继续看排行。`;
  }

  // SMCShop：把物品名填进它的查询框，再点对应的那张卡片。详情是页面正文（#details 顶掉 #results），
  // 不是浮层，所以面板得让位收起，否则正好挡在详情上面。
  async function jumpInSmcshop(itemName) {
    const form = document.querySelector(Site.jump.searchForm);
    const input = document.querySelector(Site.jump.searchInput);
    if (!form || !input) {
      throw new Error('当前页面没有商店查询表单，请先打开商店查询页');
    }

    setNativeInputValue(input, itemName);
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    const card = await pollUntil(() => findSmcshopCard(itemName), CONFIG.jumpTimeoutMs);
    if (!card) {
      throw new Error(`商店列表中没有找到「${itemName}」，可能还没有被任何客户端收录`);
    }
    card.click();

    const opened = await pollUntil(() => isSmcshopDetailOpen(itemName), CONFIG.jumpTimeoutMs);
    if (!opened) {
      throw new Error(`打开「${itemName}」的商店详情超时，请重试`);
    }
    return `已打开「${itemName}」的商店详情，面板已收起；重新点「利润排行」即可回到榜单。`;
  }

  // 服务端搜索是模糊匹配，卡片必须按 data-item 精确相等来挑，
  // 否则点「圆石」会命中排在它前面的「深板岩圆石」
  function findSmcshopCard(itemName) {
    const cards = document.querySelectorAll(`${Site.jump.results} ${Site.jump.card}[data-item]`);
    for (const card of cards) {
      if (card.dataset.item === itemName) return card;
    }
    return null;
  }

  function isSmcshopDetailOpen(itemName) {
    const details = document.querySelector(Site.jump.details);
    if (!details || details.hidden) return false;
    const heading = details.querySelector('h2');
    return Boolean(heading) && heading.textContent.trim() === itemName;
  }

  // 轮询等待。搜索和详情都是异步渲染的，而且整块会被替换掉，所以每次都要重新查节点
  function pollUntil(read, timeoutMs, intervalMs = 120) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        const value = read();
        if (value) {
          resolve(value);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(null);
          return;
        }
        window.setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  function render() {
    if (!elements['mpe-tbody']) return;
    // 「显示什么」在这里一次算清：可见行与两类隐藏计数共用同一份 filtered，
    // 否则会出现「表里只剩 7 行、说明却写隐藏了 82 个」这种两边对不上的情况
    const filtered = getFilteredRows();
    // 「开始计算（N 条）」里的 N 在这里算一次存进 state：setBusy 在算报价时会被调上万次，只读它
    state.scopeTargetCount = getScopeTargets(filtered).length;
    countHiddenRows(filtered);
    // 表格用的是 strict 那份（丢掉还没算过的行），可见行的排序一次渲染只做一次，
    // 摘要和表格共用结果，不要把排序分别写进两个子渲染里
    const rows = Core.sortRows(getScopeRows(getFilteredRows(true)), state.sortKey);
    renderMode();
    renderStatus(rows);
    renderSummary(rows);
    renderTable(rows);
    elements['mpe-error'].hidden = !state.error;
    elements['mpe-error'].textContent = state.error;
    syncInputValue(elements['mpe-search'], state.search);
    syncInputValue(elements['mpe-min-sell-amount'], state.minSellAmount > 0 ? String(state.minSellAmount) : '');
    elements['mpe-vanilla-filter'].value = state.vanillaFilter;
    elements['mpe-anomaly-filter'].value = String(state.anomalyMultiplier);
    elements['mpe-price-ratio-filter'].value = String(state.priceRatioLimit);
    elements['mpe-calc-scope'].value = state.calcScope;
    setBusy();
    // 库存核对收口在这里触发（内部自带防抖与重复检查）：打开面板、改搜索、改数量、改倍率
    // 最后都会走到 render，挂在一处就不会漏，也不必在每个事件里各写一遍
    scheduleStockVerification();
  }

  // 说明文字要报出两类各隐藏了多少条。两类互斥地数，加起来正好是「筛出来但没显示」的条数：
  // 缺货（买了没货 / 没人收）和被核对改低到没利润的行归第一类，只是倍率超上限的归第二类。
  function countHiddenRows(filtered) {
    let excluded = 0;
    let ratioHidden = 0;
    let checked = 0;
    let uncertain = 0;
    for (const row of filtered) {
      if (row.stockVerified || row.stockExcluded || row.stockUncertain) checked += 1;
      if (row.stockExcluded) {
        excluded += 1;
        continue;
      }
      if (row.stockUncertain) uncertain += 1;
      if (!withinPriceRatio(row)) ratioHidden += 1;
    }
    state.stockCheckedCount = checked;
    state.stockExcludedCount = excluded;
    state.stockUncertainCount = uncertain;
    state.priceRatioHiddenCount = ratioHidden;
  }

  // rows 可以不传：跳转时只想立刻把「正在定位…」刷出来，不需要顺手统计过期条数
  function renderStatus(rows = []) {
    const count = state.unitRows.length;
    if (state.dataLoading) {
      elements['mpe-data-status'].textContent = '正在读取物品列表…';
    } else if (state.items.length) {
      elements['mpe-data-status'].textContent = `已读取 ${integerFormatter.format(state.items.length)} 个物品 · 更新于 ${formatTime(state.marketSavedAt)}`;
    } else {
      elements['mpe-data-status'].textContent = '尚未读取物品列表';
    }
    elements['mpe-badge'].hidden = count <= 0;
    elements['mpe-badge'].textContent = count > 999 ? '999+' : String(count);
    elements['mpe-port-count'].textContent = String(state.portBlacklist.length);

    if (elements['mpe-status-note']) {
      let note = L.statusNote;
      let notice = false;
      if (state.jumpBusy) {
        note = `正在商城列表中定位「${state.jumpBusy}」…`;
        notice = true;
      } else if (state.storageWarning) {
        note = state.storageWarning;
        notice = true;
      } else if (state.stockShapeWarning) {
        // 读不到库存就不敢判「没货」，只能退回聚合值——这属于参数异常，必须说出来
        note = '挂单接口没有返回库存字段，已跳过缺货核对，价格按聚合值显示。';
        notice = true;
      } else if (state.jumpNotice) {
        note = state.jumpNotice;
        notice = true;
      } else if (state.stockStopped) {
        note = '已停止核对挂单库存，缺失的结果按聚合值显示；点「刷新数据」可重新核对。';
        notice = true;
      } else if (state.stockErrors.size > 0) {
        note = `${integerFormatter.format(state.stockErrors.size)} 个物品的挂单库存核对失败，点「刷新数据」可重试。`;
        notice = true;
      } else if (state.truncatedCount > 0) {
        note = `有 ${integerFormatter.format(state.truncatedCount)} 个商品的报价超过上限被截断，其总利润可能偏小。`;
        notice = true;
      } else {
        // 过期结果继续显示，但要说明白它是旧的，别让用户以为报价已经刷新过
        const staleCount = rows.filter((row) => row.stale).length;
        if (staleCount > 0) {
          const ttlMinutes = Math.round(CONFIG.cacheTtlMs / 60000);
          // 没有计算这一步的站点只能靠「刷新数据」重新拉，提示里得说对按钮名
          const action = isCalculable() ? '点击「重新计算」可刷新' : '点击「刷新数据」可更新';
          note = `${integerFormatter.format(staleCount)} 个物品的数据已超过 ${ttlMinutes} 分钟有效期，${action}。`;
          notice = true;
        } else if (state.calcScope === 'filtered') {
          // 计算范围是常驻设置不是临时提醒，所以拼在常规说明前面但不打高亮标记。
          // 切回「全部商品」后这条会消失，而表里可能仍然只有上一轮算过的那部分结果。
          note = `计算范围：当前筛选结果（${integerFormatter.format(state.scopeTargetCount)} 条） · ${L.statusNote}`;
        }
      }
      elements['mpe-status-note'].textContent = note;
      elements['mpe-status-note'].dataset.notice = String(notice);
    }
  }

  // 取某一列最大值所在的行：一次 O(n) 扫描，不必为了拿一行而给整表再排一次序
  function maxRowBy(rows, read) {
    let best = null;
    let bestValue = -Infinity;
    for (const row of rows) {
      const value = read(row);
      if (Number.isFinite(value) && value > bestValue) {
        bestValue = value;
        best = row;
      }
    }
    return best;
  }

  function renderSummary(rows) {
    elements['mpe-stat-count'].textContent = rows.length
      ? integerFormatter.format(rows.length)
      : '—';

    const bestUnit = maxRowBy(rows, (row) => row.unitProfit);
    elements['mpe-stat-unit'].textContent = bestUnit ? formatNumber(bestUnit.unitProfit) : '—';

    const bestTotal = maxRowBy(rows, (row) => row.totalProfit);
    elements['mpe-stat-total'].textContent = bestTotal ? formatNumber(bestTotal.totalProfit) : '—';
  }

  function renderTable(rows) {
    const columns = getTableColumns();

    renderTableHeader(columns);

    if (!rows.length) {
      elements['mpe-tbody'].innerHTML = '';
      elements['mpe-empty'].hidden = false;
      elements['mpe-empty'].textContent = state.dataLoading
        ? '正在读取物品列表…'
        : state.offerLoading && state.anomalyMultiplier > 0
          ? '正在过滤异常报价…'
          : (state.anomalyMultiplier > 0 || state.portBlacklist.length > 0) && calculationNeeded()
            ? '已启用异常过滤，请点击开始计算。'
            : state.items.length
              ? '没有符合当前条件的正利润商品'
              : '打开面板后将自动读取物品列表';
      elements['mpe-row-count'].textContent = '';
      return;
    }

    elements['mpe-empty'].hidden = true;
    elements['mpe-tbody'].innerHTML = rows.map((row, index) => {
      const name = escapeHtml(row.itemName);
      const common = `
        <td class="mpe-rank">${index + 1}</td>
        <td class="mpe-item"><button class="mpe-item-link" type="button" data-mpe-item="${name}" title="在商城页面中打开「${name}」的详情">${name}</button></td>
        <td class="mpe-number">${formatNumber(row.minSellPrice)}</td>
        <td class="mpe-number">${formatNumber(row.maxBuyPrice)}</td>
      `;

      if (state.mode === 'total') {
        const hasTotal = Number.isFinite(row.totalProfit);
        const failed = state.offerErrors.has(row.itemName);
        const totalText = hasTotal ? formatNumber(row.totalProfit) : failed ? '失败' : '待计算';
        const quantityText = hasTotal ? formatNumber(row.matchedQty) : '—';
        return `<tr>
          ${common}
          <td class="mpe-number mpe-total">${totalText}</td>
          <td class="mpe-number">${quantityText}</td>
          <td class="mpe-number mpe-unit">${formatNumber(row.unitProfit)}</td>
          <td class="mpe-number">${formatPercent(row.profitRate)}</td>
        </tr>`;
      }

      return `<tr>
        ${common}
        <td class="mpe-number mpe-unit">${formatNumber(row.unitProfit)}</td>
        <td class="mpe-number">${formatPercent(row.profitRate)}</td>
        <td class="mpe-number">${formatNumber(row.sellAmount)}</td>
      </tr>`;
    }).join('');

    elements['mpe-row-count'].textContent = `显示 ${integerFormatter.format(rows.length)} 条`;
  }

  async function loadStoredData() {
    try {
      const stored = await chrome.storage.local.get([
        STORAGE_KEYS.market,
        STORAGE_KEYS.totals,
        STORAGE_KEYS.analyses,
        STORAGE_KEYS.stocks,
        STORAGE_KEYS.portBlacklist
      ]);

      const market = stored[STORAGE_KEYS.market];
      if (market && isFresh(market.savedAt) && Array.isArray(market.items)) {
        state.items = market.items.map(Core.normalizeItem).filter(Boolean);
        state.unitRows = Core.buildUnitRows(state.items);
        state.marketSavedAt = market.savedAt;
      }

      // 挂单库存的结论只对同一份商品快照有效：savedAt 对不上就整份作废，
      // 否则会拿上一批挂单的核对结果去判这一批数据
      const stocks = stored[STORAGE_KEYS.stocks];
      if (stocks && stocks.savedAt === state.marketSavedAt
        && stocks.entries && typeof stocks.entries === 'object') {
        const entries = {};
        for (const [itemName, entry] of Object.entries(stocks.entries)) {
          if (entry && Number.isFinite(entry.updatedAt)) entries[itemName] = entry;
        }
        state.stockCache = entries;
      }

      state.portBlacklist = normalizePortNames(stored[STORAGE_KEYS.portBlacklist] || []);

      // 过期但结构完整的缓存照样载入：表格里会标成「已过期」并提示重新计算，
      // 而不是把算好的排行直接丢掉（丢掉的话重开页面会看到一张空表）
      const totals = stored[STORAGE_KEYS.totals];
      if (totals && totals.entries && typeof totals.entries === 'object') {
        const entries = {};
        for (const [itemName, entry] of Object.entries(totals.entries)) {
          if (entry && Number.isFinite(entry.updatedAt)) entries[itemName] = entry;
        }
        state.totalCache = entries;
      }

      const analyses = stored[STORAGE_KEYS.analyses];
      if (analyses && typeof analyses === 'object') {
        const restored = {};
        for (const [multiplier, entries] of Object.entries(analyses)) {
          if (!entries || typeof entries !== 'object') continue;
          const kept = {};
          for (const [itemName, entry] of Object.entries(entries)) {
            if (entry && Number.isFinite(entry.updatedAt)) kept[itemName] = entry;
          }
          if (Object.keys(kept).length) restored[multiplier] = kept;
        }
        state.analysisCache = restored;
      }
    } catch (error) {
      console.warn('[Mall Profit] 读取本地缓存失败', error);
    }
  }

  function noteStorageFailure(label, error) {
    const message = String((error && error.message) || '');
    state.storageWarning = /quota|exceed/i.test(message)
      ? '本地缓存空间不足，已跳过缓存写入；重开面板会重新读取物品列表。'
      : `本地缓存写入失败（${label}），结果只保留在当前页面。`;
    console.warn('[Mall Profit] 缓存写入失败', label, error);
  }

  async function persistMarket() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.market]: {
          savedAt: state.marketSavedAt,
          items: state.items
        }
      });
      state.storageWarning = '';
    } catch (error) {
      noteStorageFailure('商品缓存', error);
    }
  }

  async function persistTotalCache() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.totals]: {
          savedAt: Date.now(),
          entries: state.totalCache
        }
      });
      state.storageWarning = '';
    } catch (error) {
      noteStorageFailure('总利润缓存', error);
    }
  }

  async function persistAnalysisCache() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.analyses]: state.analysisCache
      });
      state.storageWarning = '';
    } catch (error) {
      noteStorageFailure('异常过滤缓存', error);
    }
  }

  async function persistPortBlacklist() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.portBlacklist]: normalizePortNames(state.portBlacklist)
      });
      state.storageWarning = '';
    } catch (error) {
      noteStorageFailure('港口黑名单', error);
    }
  }

  async function persistStockCache() {
    try {
      await chrome.storage.local.set({
        [STORAGE_KEYS.stocks]: {
          savedAt: state.marketSavedAt,
          entries: state.stockCache
        }
      });
      state.storageWarning = '';
    } catch (error) {
      noteStorageFailure('库存核对缓存', error);
    }
  }

  async function clearAnalysisStorage() {
    try {
      await chrome.storage.local.remove(STORAGE_KEYS.analyses);
    } catch (error) {
      console.warn('[Mall Profit] 清理报价分析缓存失败', error);
    }
  }
  async function clearStoredData() {
    try {
      await chrome.storage.local.remove([
        STORAGE_KEYS.market,
        STORAGE_KEYS.totals,
        STORAGE_KEYS.analyses,
        STORAGE_KEYS.stocks
      ]);
    } catch (error) {
      console.warn('[Mall Profit] 清理缓存失败', error);
    }
  }

  async function start() {
    createUI();
    await loadStoredData();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void start(), { once: true });
  } else {
    void start();
  }
})();

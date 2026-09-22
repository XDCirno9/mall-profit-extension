(function initMallProfitExtension() {
  'use strict';

  const Core = globalThis.MallProfitCore;
  if (!Core) return;

  const CONFIG = Object.freeze({
    apiBase: 'https://mall.vesego.xyz/api/mall',
    pageSize: 100,
    listConcurrency: 8,
    offerConcurrency: 4,
    cacheTtlMs: 5 * 60 * 1000,
    fetchRetries: 2,
    maxOffers: 20000,
    jumpTimeoutMs: 8000,
    mallSearchPlaceholder: '搜索物品名',
    mallItemTableHeader: '物品名',
    highlightMs: 1800,
    defaultStatusNote: '忽略路程与运输成本 · 自动隐藏标记商店'
  });

  const STORAGE_KEYS = Object.freeze({
    market: 'mallProfit.market.v1',
    totals: 'mallProfit.totals.v1',
    analyses: 'mallProfit.analyses.v1',
    portBlacklist: 'mallProfit.portBlacklist.v1'
  });

  const UNIT_SORT_OPTIONS = Object.freeze([
    ['unitProfit-desc', '单件利润 高 → 低'],
    ['unitProfit-asc', '单件利润 低 → 高'],
    ['profitRate-desc', '利润率 高 → 低'],
    ['minSellPrice-asc', '最低出售价 低 → 高'],
    ['itemName-asc', '商品名称']
  ]);

  const TOTAL_SORT_OPTIONS = Object.freeze([
    ['totalProfit-desc', '总利润 高 → 低'],
    ['totalProfit-asc', '总利润 低 → 高'],
    ['unitProfit-desc', '单件利润 高 → 低'],
    ['profitRate-desc', '利润率 高 → 低'],
    ['itemName-asc', '商品名称']
  ]);

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
    anomalyMultiplier: 10,
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
            <span id="mpe-data-status">尚未读取商城数据</span>
            <span class="mpe-status-note" id="mpe-status-note" data-notice="false">忽略路程与运输成本 · 自动隐藏标记商店</span>
          </div>

          <div class="mpe-toolbar">
            <div class="mpe-segmented" role="group" aria-label="利润模式">
              <button class="mpe-segment is-active" data-mode="unit" type="button">单件利润</button>
              <button class="mpe-segment" data-mode="total" type="button">总利润</button>
            </div>

            <label class="mpe-field mpe-sort-field">
              <span>排序</span>
              <select id="mpe-sort"></select>
            </label>

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

            <button class="mpe-button mpe-button-secondary" id="mpe-port-manager" type="button">港口黑名单 <span id="mpe-port-count">0</span></button>
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
            <span>数据来自商城的公开报价接口，仅按当前价格计算 · 点击商品名称可跳到商城页面中的该物品详情</span>
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
      'mpe-sort',
      'mpe-search',
      'mpe-min-sell-amount',
      'mpe-vanilla-filter',
      'mpe-anomaly-filter',
      'mpe-port-manager',
      'mpe-port-count',
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
    bindEvents();
    renderSortOptions();
    render();
  }

  function bindEvents() {
    elements['mpe-launcher'].addEventListener('click', openPanel);
    elements['mpe-close'].addEventListener('click', closePanel);
    elements['mpe-backdrop'].addEventListener('click', closePanel);
    elements['mpe-calculate'].addEventListener('click', runCalculation);
    elements['mpe-refresh'].addEventListener('click', handleRefresh);
    elements['mpe-cancel'].addEventListener('click', cancelOfferCalculation);
    elements['mpe-search'].addEventListener('input', (event) => {
      state.search = event.target.value.trim();
      render();
    });
    elements['mpe-min-sell-amount'].addEventListener('input', (event) => {
      const value = Number(event.target.value);
      state.minSellAmount = Number.isFinite(value) && value > 0 ? value : 0;
      render();
    });
    elements['mpe-sort'].addEventListener('change', (event) => {
      state.sortKey = event.target.value;
      render();
    });
    elements['mpe-vanilla-filter'].addEventListener('change', (event) => {
      state.vanillaFilter = event.target.value;
      render();
    });
    elements['mpe-anomaly-filter'].addEventListener('change', (event) => {
      state.anomalyMultiplier = Number(event.target.value) || 0;
      cancelOfferCalculation(false);
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
      if (itemName) void jumpToMallItem(itemName);
    });

    for (const button of document.querySelectorAll('.mpe-segment')) {
      button.addEventListener('click', () => setMode(button.dataset.mode));
    }

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!elements['mpe-port-modal'].hidden) closePortManager();
      else if (state.panelOpen) closePanel();
    });
  }

  function openPanel() {
    state.panelOpen = true;
    elements['mpe-panel'].dataset.open = 'true';
    elements['mpe-panel'].setAttribute('aria-hidden', 'false');
    elements['mpe-backdrop'].hidden = false;
    document.documentElement.classList.add('mpe-panel-open');
    render();

    if (!state.items.length && !state.dataLoading) {
      void loadMarket(false);
    }
  }

  function closePanel() {
    state.panelOpen = false;
    elements['mpe-panel'].dataset.open = 'false';
    elements['mpe-panel'].setAttribute('aria-hidden', 'true');
    elements['mpe-backdrop'].hidden = true;
    document.documentElement.classList.remove('mpe-panel-open');
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
    state.sortKey = nextMode === 'total' ? 'totalProfit-desc' : 'unitProfit-desc';
    if (nextMode === 'unit' && state.anomalyMultiplier === 0) cancelOfferCalculation();
    renderMode();
    renderSortOptions();
    render();
  }

  function renderMode() {
    for (const button of document.querySelectorAll('.mpe-segment')) {
      button.classList.toggle('is-active', button.dataset.mode === state.mode);
    }
    const modeText = state.mode === 'total'
      ? '总利润会把最低出售报价与最高收购报价按数量匹配，忽略港口和运输成本。'
      : '单件利润 = 最高收购价 − 最低出售价。只显示大于 0 的商品。';
    const anomalyText = state.anomalyMultiplier > 0
      ? (' 异常报价按同商品中位数的 ' + state.anomalyMultiplier + ' 倍过滤。')
      : '';
    const blockedText = state.portBlacklist.length > 0
      ? (' 已屏蔽 ' + state.portBlacklist.length + ' 个港口的报价。')
      : '';
    elements['mpe-explainer'].textContent = modeText + anomalyText + blockedText;
  }

  function renderSortOptions() {
    const options = state.mode === 'total' ? TOTAL_SORT_OPTIONS : UNIT_SORT_OPTIONS;
    if (!options.some(([value]) => value === state.sortKey)) {
      state.sortKey = options[0][0];
    }
    elements['mpe-sort'].innerHTML = options
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join('');
    elements['mpe-sort'].value = state.sortKey;
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
        const response = await fetch(`${CONFIG.apiBase}${path}`, {
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

  function buildItemsPath(offset) {
    const params = new URLSearchParams({
      includeTagged: 'false',
      limit: String(CONFIG.pageSize),
      offset: String(offset)
    });
    return `/items?${params.toString()}`;
  }

  async function fetchMarketItems(signal) {
    const firstPage = await apiGet(buildItemsPath(0), signal);
    const firstItems = requireArrayField(firstPage, 'items', '商品列表接口');
    const reportedTotal = Number(firstPage.total);
    const total = Number.isFinite(reportedTotal) && reportedTotal >= 0 ? reportedTotal : firstItems.length;

    const items = [...firstItems];
    const offsets = [];
    for (let offset = CONFIG.pageSize; offset < total; offset += CONFIG.pageSize) offsets.push(offset);

    const totalPages = 1 + offsets.length;
    let completedPages = 1;
    updateProgress('正在读取商品列表', completedPages, totalPages);

    await mapLimit(offsets, CONFIG.listConcurrency, async (offset) => {
      const page = await apiGet(buildItemsPath(offset), signal);
      items.push(...requireArrayField(page, 'items', '商品列表接口'));
      completedPages += 1;
      updateProgress('正在读取商品列表', completedPages, totalPages);
    }, signal);

    const deduplicated = new Map();
    for (const rawItem of items) {
      const item = Core.normalizeItem(rawItem);
      if (item) deduplicated.set(item.itemName, item);
    }

    return {
      items: [...deduplicated.values()],
      total
    };
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
    state.marketController = new AbortController();
    setBusy();
    render();
    updateProgress('正在读取商品列表', 0, 1);

    try {
      if (force) await clearStoredData();
      const result = await fetchMarketItems(state.marketController.signal);
      state.items = result.items;
      state.unitRows = Core.buildUnitRows(result.items);
      state.marketSavedAt = Date.now();
      state.totalCache = {};
      state.analysisCache = {};
      await clearAnalysisStorage();
      await persistMarket();
      render();
      scheduleHideProgress();
    } catch (error) {
      if (!isAbortError(error)) {
        state.error = `商城数据读取失败：${error.message || '未知错误'}`;
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
      const params = new URLSearchParams({
        includeTagged: 'false',
        limit: '100',
        mode,
        offset: String(offset)
      });
      const page = await apiGet(`/items/${encodeURIComponent(itemName)}/offers?${params.toString()}`, signal);
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

  function hasFreshAnalysis(itemName) {
    const entry = getCurrentAnalysisCache()[itemName];
    return Boolean(entry && isFresh(entry.updatedAt));
  }

  async function ensureAnomalyAnalysis(force) {
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
    const positiveRows = state.unitRows.length ? state.unitRows : Core.buildUnitRows(state.items);
    const missing = positiveRows.filter((row) => !hasFreshAnalysis(row.itemName));
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
    let completed = positiveRows.length - missing.length;
    let writesSincePersist = 0;
    let truncatedItems = 0;
    setBusy();
    render();
    updateProgress('正在过滤异常报价', completed, positiveRows.length);

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
            updateProgress('正在过滤异常报价', completed, positiveRows.length);
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
  async function ensureTotalProfits(force) {
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

    const positiveRows = state.unitRows.length ? state.unitRows : Core.buildUnitRows(state.items);
    const missing = positiveRows.filter((row) => !hasFreshTotal(row.itemName));
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
    let completed = positiveRows.length - missing.length;
    let writesSincePersist = 0;
    let truncatedItems = 0;
    setBusy();
    render();
    updateProgress('正在计算总利润', completed, positiveRows.length);

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
            updateProgress('正在计算总利润', completed, positiveRows.length);
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

  function cancelOfferCalculation(renderAfter = true) {
    if (state.offerController) state.offerController.abort();
    state.offerRunId += 1;
    state.offerLoading = false;
    state.offerController = null;
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
    elements['mpe-cancel'].hidden = !state.offerLoading;
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
      if (!state.dataLoading && !state.offerLoading) hideProgress();
    }, 500);
  }

  function calculationNeeded() {
    if (!state.items.length) return true;
    const rows = state.unitRows.length ? state.unitRows : Core.buildUnitRows(state.items);
    if (state.anomalyMultiplier > 0 || state.portBlacklist.length > 0) {
      return rows.some((row) => !hasFreshAnalysis(row.itemName));
    }
    if (state.mode === 'total') {
      return rows.some((row) => !hasFreshTotal(row.itemName));
    }
    return false;
  }

  async function runCalculation() {
    if (state.dataLoading || state.offerLoading) return;
    state.error = '';
    if (!state.items.length) {
      await loadMarket(false);
      if (!state.items.length) return;
    }

    if (state.anomalyMultiplier > 0 || state.portBlacklist.length > 0) {
      await ensureAnomalyAnalysis(true);
      return;
    }
    if (state.mode === 'total') {
      await ensureTotalProfits(true);
      return;
    }
    render();
  }
  function setBusy() {
    if (!elements['mpe-refresh']) return;
    const busy = state.dataLoading || state.offerLoading;
    elements['mpe-refresh'].disabled = busy;
    elements['mpe-refresh'].textContent = state.dataLoading ? '读取中…' : state.offerLoading ? '计算中…' : '刷新数据';

    const calculable = state.anomalyMultiplier > 0 || state.portBlacklist.length > 0 || state.mode === 'total';
    elements['mpe-calculate'].disabled = busy || !state.items.length || !calculable;
    elements['mpe-calculate'].textContent = state.dataLoading
      ? '读取中…'
      : state.offerLoading
        ? '计算中…'
        : !calculable
          ? '无需计算'
          : calculationNeeded()
            ? '开始计算'
            : '重新计算';
  }

  function getVisibleRows() {
    const search = state.search.toLocaleLowerCase('zh-CN');
    const cache = getCurrentAnalysisCache();
    const rows = state.unitRows
      .map((row) => {
        if (state.anomalyMultiplier > 0 || state.portBlacklist.length > 0) {
          const analysis = cache[row.itemName];
          if (!analysis || !isFresh(analysis.updatedAt) || analysis.excluded) return null;
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
            outlierCount: analysis.outlierCount
          };
        }
        const total = state.totalCache[row.itemName];
        return total && isFresh(total.updatedAt) ? Core.withTotalProfit(row, total) : { ...row };
      })
      .filter((row) => {
        if (!row) return false;
        if (search && !row.itemName.toLocaleLowerCase('zh-CN').includes(search)) return false;
        if (row.sellAmount < state.minSellAmount) return false;
        const isVanilla = Boolean(row.vanillaId);
        if (state.vanillaFilter === 'vanilla' && !isVanilla) return false;
        if (state.vanillaFilter === 'non-vanilla' && isVanilla) return false;
        return true;
      });

    return Core.sortRows(rows, state.sortKey);
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

  function isMallRoute() {
    return /^\/mall(\/|$)/i.test(window.location.pathname || '');
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

  async function jumpToMallItem(itemName) {
    if (state.jumpBusy || !itemName) return;

    state.error = '';
    state.jumpNotice = '';

    if (!isMallRoute()) {
      state.error = '当前页不是商城首页（/mall），无法跳转到物品详情。';
      render();
      return;
    }

    state.jumpBusy = itemName;
    renderStatus();

    let searchInput = null;
    let previousSearch = '';

    try {
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
      closePanel();
      try {
        activateMallRow(row, itemName);
      } catch (activateError) {
        // 面板已关闭，若点击失败就把面板恢复出来，避免用户只能看到空白
        openPanel();
        throw activateError;
      }
      state.jumpNotice = calculationRunning
        ? `已在商城页面中打开「${itemName}」，后台计算仍在继续。`
        : `已在商城页面中打开「${itemName}」。`;
    } catch (error) {
      state.error = `跳转失败：${error.message || '未知错误'}`;
    } finally {
      state.jumpBusy = '';
      render();
    }
  }

  function render() {
    if (!elements['mpe-tbody']) return;
    renderMode();
    renderStatus();
    renderSummary();
    renderTable();
    elements['mpe-error'].hidden = !state.error;
    elements['mpe-error'].textContent = state.error;
    elements['mpe-search'].value = state.search;
    elements['mpe-min-sell-amount'].value = state.minSellAmount > 0 ? String(state.minSellAmount) : '';
    elements['mpe-vanilla-filter'].value = state.vanillaFilter;
    elements['mpe-anomaly-filter'].value = String(state.anomalyMultiplier);
    elements['mpe-sort'].value = state.sortKey;
    setBusy();
  }

  function renderStatus() {
    const count = state.unitRows.length;
    if (state.dataLoading) {
      elements['mpe-data-status'].textContent = '正在读取商城数据…';
    } else if (state.items.length) {
      elements['mpe-data-status'].textContent = `已读取 ${integerFormatter.format(state.items.length)} 个商品 · 更新于 ${formatTime(state.marketSavedAt)}`;
    } else {
      elements['mpe-data-status'].textContent = '尚未读取商城数据';
    }
    elements['mpe-badge'].hidden = count <= 0;
    elements['mpe-badge'].textContent = count > 999 ? '999+' : String(count);
    elements['mpe-port-count'].textContent = String(state.portBlacklist.length);

    if (elements['mpe-status-note']) {
      let note = CONFIG.defaultStatusNote;
      if (state.jumpBusy) note = `正在商城列表中定位「${state.jumpBusy}」…`;
      else if (state.storageWarning) note = state.storageWarning;
      else if (state.jumpNotice) note = state.jumpNotice;
      else if (state.truncatedCount > 0) {
        note = `有 ${integerFormatter.format(state.truncatedCount)} 个商品的报价超过上限被截断，其总利润可能偏小。`;
      }
      elements['mpe-status-note'].textContent = note;
      elements['mpe-status-note'].dataset.notice = String(note !== CONFIG.defaultStatusNote);
    }
  }

  function renderSummary() {
    const visibleRows = getVisibleRows();
    elements['mpe-stat-count'].textContent = visibleRows.length
      ? integerFormatter.format(visibleRows.length)
      : '—';

    const bestUnit = Core.sortRows(visibleRows, 'unitProfit-desc')[0];
    elements['mpe-stat-unit'].textContent = bestUnit ? formatNumber(bestUnit.unitProfit) : '—';

    const totals = visibleRows.filter((row) => Number.isFinite(row.totalProfit));
    const bestTotal = totals.sort((a, b) => b.totalProfit - a.totalProfit)[0];
    elements['mpe-stat-total'].textContent = bestTotal ? formatNumber(bestTotal.totalProfit) : '—';
  }

  function renderTable() {
    const rows = getVisibleRows();
    const columns = state.mode === 'total'
      ? ['#', '商品', '最低出售价', '最高收购价', '总利润', '可匹配数量', '单件利润', '利润率']
      : ['#', '商品', '最低出售价', '最高收购价', '单件利润', '利润率', '在售数量'];

    elements['mpe-thead'].innerHTML = `<tr>${columns.map((column) => `<th>${column}</th>`).join('')}</tr>`;

    if (!rows.length) {
      elements['mpe-tbody'].innerHTML = '';
      elements['mpe-empty'].hidden = false;
      elements['mpe-empty'].textContent = state.dataLoading
        ? '正在读取商城数据…'
        : state.offerLoading && state.anomalyMultiplier > 0
          ? '正在过滤异常报价…'
          : (state.anomalyMultiplier > 0 || state.portBlacklist.length > 0) && calculationNeeded()
            ? '已启用异常过滤，请点击开始计算。'
            : state.items.length
              ? '没有符合当前条件的正利润商品'
              : '打开面板后将自动读取商城数据';
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
      const stored = await chrome.storage.local.get([STORAGE_KEYS.market, STORAGE_KEYS.totals, STORAGE_KEYS.analyses, STORAGE_KEYS.portBlacklist]);
      const market = stored[STORAGE_KEYS.market];
      if (market && isFresh(market.savedAt) && Array.isArray(market.items)) {
        state.items = market.items.map(Core.normalizeItem).filter(Boolean);
        state.unitRows = Core.buildUnitRows(state.items);
        state.marketSavedAt = market.savedAt;
      }

      state.portBlacklist = normalizePortNames(stored[STORAGE_KEYS.portBlacklist] || []);

      const totals = stored[STORAGE_KEYS.totals];
      if (totals && totals.entries && typeof totals.entries === 'object') {
        const freshEntries = {};
        for (const [itemName, entry] of Object.entries(totals.entries)) {
          if (entry && isFresh(entry.updatedAt)) freshEntries[itemName] = entry;
        }
        state.totalCache = freshEntries;
      }

      const analyses = stored[STORAGE_KEYS.analyses];
      if (analyses && typeof analyses === 'object') {
        const freshAnalyses = {};
        for (const [multiplier, entries] of Object.entries(analyses)) {
          if (!entries || typeof entries !== 'object') continue;
          const freshEntries = {};
          for (const [itemName, entry] of Object.entries(entries)) {
            if (entry && isFresh(entry.updatedAt)) freshEntries[itemName] = entry;
          }
          if (Object.keys(freshEntries).length) freshAnalyses[multiplier] = freshEntries;
        }
        state.analysisCache = freshAnalyses;
      }
    } catch (error) {
      console.warn('[Mall Profit] 读取本地缓存失败', error);
    }
  }

  function noteStorageFailure(label, error) {
    const message = String((error && error.message) || '');
    state.storageWarning = /quota|exceed/i.test(message)
      ? '本地缓存空间不足，已跳过缓存写入；重开面板会重新读取商城数据。'
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

  async function clearAnalysisStorage() {
    try {
      await chrome.storage.local.remove(STORAGE_KEYS.analyses);
    } catch (error) {
      console.warn('[Mall Profit] 清理报价分析缓存失败', error);
    }
  }
  async function clearStoredData() {
    try {
      await chrome.storage.local.remove([STORAGE_KEYS.market, STORAGE_KEYS.totals, STORAGE_KEYS.analyses]);
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






















const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (error) {
  console.error('jsdom 未安装。请执行 npm i -D jsdom，或把 NODE_PATH 指向已含 jsdom 的 node_modules。');
  process.exit(2);
}

const EXT_DIR = path.resolve(__dirname, '..', '..', 'mall-profit-extension');

const PROFIT_CORE = fs.readFileSync(path.join(EXT_DIR, 'profit-core.js'), 'utf8');
const CONTENT_JS = fs.readFileSync(path.join(EXT_DIR, 'content.js'), 'utf8');
const CONTENT_CSS = fs.readFileSync(path.join(EXT_DIR, 'content.css'), 'utf8');

const ITEMS = [
  { itemName: '石头', minSellPrice: 1, maxBuyPrice: 2.5, sellAmount: 111610, sellOfferCount: 76, buyOfferCount: 56, totalOfferCount: 132, vanillaId: null },
  { itemName: '圆石', minSellPrice: 2, maxBuyPrice: 5, sellAmount: 500, sellOfferCount: 10, buyOfferCount: 8, totalOfferCount: 18, vanillaId: 'minecraft:cobblestone' },
  { itemName: '钻石', minSellPrice: 40, maxBuyPrice: 90, sellAmount: 30, sellOfferCount: 4, buyOfferCount: 3, totalOfferCount: 7, vanillaId: 'minecraft:diamond' },
  { itemName: '黄铁矿', minSellPrice: 3, maxBuyPrice: 8, sellAmount: 700, sellOfferCount: 6, buyOfferCount: 5, totalOfferCount: 11, vanillaId: null }
];

// 长夹具：验证「只算当前筛选结果」到底为哪几个商品拉过报价。
// 名字带两位序号，搜索词「矿石1」只匹配得到 矿石10…矿石12（匹配不到 矿石01…矿石09），
// 用它把范围从 12 条压到 3 条，断言才能看出请求集真的跟着筛选条件缩小了。
const SCOPE_ITEMS = Array.from({ length: 12 }, (unused, index) => {
  const minSellPrice = 40 + index * 5;
  return {
    itemName: `矿石${String(index + 1).padStart(2, '0')}`,
    minSellPrice,
    maxBuyPrice: minSellPrice + index + 1,
    sellAmount: 100 + index,
    sellOfferCount: 2,
    buyOfferCount: 2,
    totalOfferCount: 4,
    vanillaId: index % 2 === 0 ? null : 'minecraft:stone'
  };
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  throw new Error(`超时：${label}`);
}

function buildMallDom(dom, initialItems) {
  const document = dom.window.document;
  const root = document.getElementById('root');
  root.innerHTML = `
    <div class="mall-shell">
      <div class="mall-left">
        <p class="site-label">物品列表</p>
        <div class="relative">
          <input id="mall-search" placeholder="搜索物品名" autocomplete="off">
        </div>
      </div>
      <div data-slot="table-container" class="overflow-x-auto">
        <table data-slot="table">
          <thead data-slot="table-header">
            <tr>
              <th data-slot="table-head">物品名</th>
              <th data-slot="table-head">最低出售价</th>
              <th data-slot="table-head">最高收购价</th>
              <th data-slot="table-head">在售总数量</th>
            </tr>
          </thead>
          <tbody id="mall-tbody" data-slot="table-body"></tbody>
        </table>
      </div>
      <div class="mall-right" id="mall-detail"></div>
    </div>
  `;

  const tbody = document.getElementById('mall-tbody');
  const search = document.getElementById('mall-search');
  const detail = document.getElementById('mall-detail');
  const clickedNames = [];
  const searchHistory = [];

  function renderRows(items) {
    tbody.innerHTML = items
      .map((item) => `
        <tr data-slot="table-row" data-name="${item.itemName}">
          <td data-slot="table-cell">
            <div class="flex min-w-0 items-center gap-3">
              <span class="site-icon-tile grid size-10 shrink-0 place-items-center">
                <svg viewBox="0 0 24 24"><path d="M0 0h1v1H0z"></path></svg>
              </span>
              <span class="min-w-0">
                <span class="block truncate text-base font-black">${item.itemName}</span>
                <span class="mt-1 flex flex-wrap gap-1">
                  ${item.vanillaId ? '<span>原版</span>' : ''}
                  <span>卖 ${item.sellOfferCount}</span>
                  <span>收 ${item.buyOfferCount}</span>
                </span>
              </span>
            </div>
          </td>
          <td>${item.minSellPrice}</td>
          <td>${item.maxBuyPrice}</td>
          <td>${item.sellAmount}</td>
        </tr>`)
      .join('');
  }

  let dialog = null;

  // 真实的商城详情是挂在 body 下的模态框（data-slot="dialog-content"），照样复刻，
  // 用来验证跳转后面板不会被关掉，以及 Esc 该归谁
  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-slot', 'dialog-content');
    dialog.setAttribute('data-state', 'open');
    dialog.appendChild(detail);
    document.body.appendChild(dialog);
    return dialog;
  }

  // 忠实复现商城：真实 React onClick 挂在根节点，靠冒泡的 click 触发
  root.addEventListener('click', (event) => {
    const row = event.target.closest && event.target.closest('tr[data-name]');
    if (!row) return;
    clickedNames.push(row.dataset.name);
    detail.textContent = `物品报价 · ${row.dataset.name}`;
    ensureDialog();
  });

  // 忠实复现商城：受控 input，服务端搜索
  search.addEventListener('input', () => {
    const query = search.value.trim();
    searchHistory.push(query);
    dom.window.setTimeout(() => {
      const catalogue = dom.__items || ITEMS;
      const matched = catalogue.filter((item) => !query || item.itemName.includes(query));
      // 模拟服务端只返回匹配项；同时覆盖「列表里原本没有」的场景
      const extra = dom.window.__extraSearchItems || [];
      renderRows([...matched, ...extra.filter((item) => !query || item.itemName.includes(query))]);
    }, 30);
  });

  renderRows(initialItems);

  return {
    tbody,
    search,
    detail,
    clickedNames,
    searchHistory,
    renderRows,
    get dialog() { return dialog; },
    // 模拟用户关掉商城详情
    closeDialog() {
      if (!dialog) return;
      dialog.remove();
      dialog = null;
    }
  };
}

async function createExtensionDom(url, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });

  // seedStore 用来模拟「上一次会话留下的缓存」，例如把结果做旧来验证过期行为
  const store = options.seedStore || {};
  // items 用来在单个场景里换一套更长的商品列表，例如验证「只算前 N 条」的截断
  const items = Array.isArray(options.items) && options.items.length ? options.items : ITEMS;
  dom.__requests = [];
  dom.__items = items;
  dom.window.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const list = keys == null ? Object.keys(store) : (Array.isArray(keys) ? keys : [keys]);
          const out = {};
          for (const key of list) if (key in store) out[key] = store[key];
          return out;
        },
        set: async (values) => { Object.assign(store, values); },
        remove: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const key of list) delete store[key];
        }
      }
    }
  };

  dom.window.fetch = async (input) => {
    const target = new URL(String(input));
    const requestPath = target.pathname + target.search;
    dom.__requests.push(requestPath);
    let payload;

    if (target.pathname === '/api/mall/items') {
      const limit = Number(target.searchParams.get('limit') || 100);
      const offset = Number(target.searchParams.get('offset') || 0);
      payload = { total: items.length, items: items.slice(offset, offset + limit) };
    } else if (target.pathname === '/api/mall/ports') {
      payload = { ports: [{ portName: '星月湾', itemCount: 105 }, { portName: '五月花港', itemCount: 29 }] };
    } else if (/^\/api\/mall\/items\/.+\/offers$/.test(target.pathname)) {
      const mode = target.searchParams.get('mode');
      payload = {
        total: 2,
        offers: mode === 'buy'
          ? [{ price: 2.5, amount: 800, region: '星月湾', nearestPort: { name: '星月湾' } }]
          : [{ price: 1, amount: 2657, region: '琉球港', nearestPort: { name: '琉球港' } }]
      };
    } else {
      throw new Error(`未预期的请求 ${requestPath}`);
    }

    return { ok: true, status: 200, json: async () => payload };
  };

  dom.window.eval(PROFIT_CORE);

  // content.js 在启动时把 globalThis.MallProfitCore 存进闭包，所以必须在它之前换掉整份导出。
  // 导出对象本身是 Object.freeze 的，因此用浅拷贝包一层来做计数。
  dom.__coreStats = { sortRows: 0 };
  const realCore = dom.window.MallProfitCore;
  dom.window.MallProfitCore = {
    ...realCore,
    sortRows(...args) {
      dom.__coreStats.sortRows += 1;
      return realCore.sortRows(...args);
    }
  };

  dom.window.eval(CONTENT_JS);

  // jsdom 构造后 readyState 仍是 loading，脚本会在 DOMContentLoaded 时启动
  await new Promise((resolve) => {
    if (dom.window.document.readyState === 'complete') resolve();
    else dom.window.addEventListener('load', resolve, { once: true });
  });
  await waitFor(() => dom.window.document.getElementById('mpe-launcher'), '扩展面板注入');

  dom.__store = store;
  return dom;
}

function setViewport(dom, width, height) {
  try {
    dom.window.resizeTo(width, height);
  } catch (error) {
    // 忽略：下面兜底
  }
  if (dom.window.innerWidth !== width) {
    Object.defineProperty(dom.window, 'innerWidth', { value: width, configurable: true });
    Object.defineProperty(dom.window, 'innerHeight', { value: height, configurable: true });
  }
  return dom.window.innerWidth;
}

async function openPanelOnly(dom) {
  const document = dom.window.document;
  document.getElementById('mpe-launcher').click();
  await waitFor(
    () => document.getElementById('mpe-data-status').textContent.includes('已读取'),
    '商品列表读取完成'
  );
}

async function openPanelAndLoad(dom) {
  const document = dom.window.document;
  await openPanelOnly(dom);
  // 默认 10× 异常过滤要求先手动计算，这里关掉过滤以便直接看到数据行
  const select = document.getElementById('mpe-anomaly-filter');
  select.value = '0';
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await waitFor(
    () => document.getElementById('mpe-tbody').querySelector('button[data-mpe-item]'),
    '利润表格出现数据行'
  );
}

function panelOpen(dom) {
  return dom.window.document.getElementById('mpe-panel').dataset.open === 'true';
}

function errorText(dom) {
  const node = dom.window.document.getElementById('mpe-error');
  return node.hidden ? '' : node.textContent;
}

function statusNote(dom) {
  return dom.window.document.getElementById('mpe-status-note').textContent;
}

// 跳转后的面板状态。dockAttr/htmlDock/undockButton 用来确认 v1.7.0 的并排收窄已经彻底移除
function panelState(dom) {
  const document = dom.window.document;
  return {
    open: panelOpen(dom),
    dockAttr: document.getElementById('mpe-panel').dataset.dock,
    htmlDock: document.documentElement.classList.contains('mpe-dock'),
    undockButton: Boolean(document.getElementById('mpe-undock')),
    keepPanelToggle: Boolean(document.getElementById('mpe-keep-panel')),
    backdropHidden: document.getElementById('mpe-backdrop').hidden,
    scrollLocked: document.documentElement.classList.contains('mpe-panel-open'),
    mallDialogOpen: Boolean(document.querySelector('body > [data-slot="dialog-content"]'))
  };
}

// 从 CSS 文本里取出某个选择器块里声明的 z-index 数值
function cssZIndex(selector) {
  const start = CONTENT_CSS.indexOf(selector);
  assert.ok(start >= 0, `content.css 里应存在规则 ${selector}`);
  const open = CONTENT_CSS.indexOf('{', start);
  const close = CONTENT_CSS.indexOf('}', open);
  const block = CONTENT_CSS.slice(open, close);
  const found = /z-index:\s*([0-9]+)/.exec(block);
  assert.ok(found, `${selector} 应声明 z-index`);
  return Number(found[1]);
}

function clickItemName(dom, itemName) {
  const document = dom.window.document;
  const buttons = [...document.querySelectorAll('#mpe-tbody button[data-mpe-item]')];
  const button = buttons.find((node) => node.dataset.mpeItem === itemName);
  assert.ok(button, `利润表格里应存在「${itemName}」这一行`);
  button.click();
  return button;
}

// content.js 的输入防抖是 220ms，等长一点再断言
const INPUT_SETTLE_MS = 450;

function rowNames(dom) {
  return [...dom.window.document.querySelectorAll('#mpe-tbody button[data-mpe-item]')]
    .map((node) => node.dataset.mpeItem);
}

function calcButtonText(dom) {
  return dom.window.document.getElementById('mpe-calculate').textContent;
}

function retryButton(dom) {
  return dom.window.document.getElementById('mpe-retry');
}

// 模拟真实输入：受控输入框必须走原生 value setter，再派发冒泡的 input 事件，
// 直接改 value 或只派发 change 都不会触发监听
function typeInto(dom, element, value) {
  const descriptor = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value');
  if (descriptor && descriptor.set) descriptor.set.call(element, value);
  else element.value = value;
  element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

// 报价接口带 query（?mode=buy&limit=…），所以只能按包含判断，不能用 endsWith
function offerRequestCount(dom) {
  return dom.__requests.filter((requestPath) => requestPath.includes('/offers')).length;
}

// 报价请求碰过哪些商品。路径里的中文是百分号编码的，必须解码后再比对
function requestedOfferItems(dom) {
  const names = new Set();
  for (const requestPath of dom.__requests) {
    const matched = requestPath.match(/\/items\/([^/]+)\/offers/);
    if (matched) names.add(decodeURIComponent(matched[1]));
  }
  return names;
}

// 下拉和数字框都靠 change 事件生效，这里把「设值 + 派发冒泡 change」合成一步
function commitChange(dom, id, value) {
  const element = dom.window.document.getElementById(id);
  element.value = value;
  element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

// ---- 表头排序相关 ----
function headerButtons(dom) {
  return [...dom.window.document.querySelectorAll('#mpe-thead .mpe-th-button')];
}

function headerState(dom) {
  const document = dom.window.document;
  const active = document.querySelector('#mpe-thead th[data-active="true"]');
  return {
    columns: document.querySelectorAll('#mpe-thead th').length,
    sortable: headerButtons(dom).length,
    plain: [...document.querySelectorAll('#mpe-thead th.mpe-th-plain')]
      .map((cell) => cell.textContent.trim()),
    activeLabel: active ? active.querySelector('.mpe-th-label').textContent : '',
    arrow: active ? active.querySelector('.mpe-th-arrow').textContent : '',
    ariaSort: active ? active.getAttribute('aria-sort') : ''
  };
}

function rowNames(dom) {
  return [...dom.window.document.querySelectorAll('#mpe-tbody button[data-mpe-item]')]
    .map((button) => button.dataset.mpeItem);
}

function clickHeader(dom, label) {
  const button = headerButtons(dom)
    .find((node) => node.querySelector('.mpe-th-label').textContent === label);
  assert.ok(button, `表头应有可点击的「${label}」列`);
  button.click();
  return button;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function scenarioFastPath() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/mall');
  // 商城列表当前已经包含目标物品
  const mall = buildMallDom(dom, ITEMS);
  await openPanelAndLoad(dom);

  clickItemName(dom, '石头');
  await sleep(200);

  record('快路径：商城列表已有该物品时直接点击该行',
    mall.clickedNames.includes('石头'), `clicked=${JSON.stringify(mall.clickedNames)}`);
  record('快路径：不修改商城搜索框',
    mall.search.value === '' && mall.searchHistory.length === 0,
    `search="${mall.search.value}" history=${JSON.stringify(mall.searchHistory)}`);
  const state = panelState(dom);
  record('快路径：跳转后面板保持打开，不再自动关闭',
    state.open === true, JSON.stringify(state));
  record('快路径：跳转不再收窄面板（并排残留已清除）',
    state.dockAttr === undefined && state.htmlDock === false && state.undockButton === false,
    JSON.stringify(state));
  record('快路径：面板自己的遮罩与页面滚动锁保持原样',
    state.backdropHidden === false && state.scrollLocked === true, JSON.stringify(state));
  record('快路径：页脚的「跳转后保留面板」开关已移除',
    state.keepPanelToggle === false, JSON.stringify(state));
  record('快路径：商城的物品详情仍挂在 body 下（供 CSS 抬到面板之上）',
    state.mallDialogOpen === true, JSON.stringify(state));
  record('快路径：状态栏说明面板保持打开',
    statusNote(dom).includes('面板保持打开'), statusNote(dom));
  record('快路径：商城详情显示该物品',
    mall.detail.textContent.includes('石头'), mall.detail.textContent);
  dom.window.close();
}

async function scenarioSearchPath() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/mall');
  // 商城列表当前只显示「石头」，目标物品「钻石」不在其中
  const mall = buildMallDom(dom, [ITEMS[0]]);
  await openPanelAndLoad(dom);

  assert.ok(!mall.tbody.textContent.includes('钻石'), '前置条件：商城列表里初始没有钻石');
  clickItemName(dom, '钻石');
  await waitFor(() => mall.clickedNames.includes('钻石'), '搜索后点击钻石行', 4000);

  record('搜索路径：目标不在列表时写入商城搜索框并命中',
    mall.clickedNames.includes('钻石'), `clicked=${JSON.stringify(mall.clickedNames)}`);
  record('搜索路径：搜索框保留物品名便于继续查看',
    mall.search.value === '钻石', `search="${mall.search.value}"`);
  record('搜索路径：跳转后面板同样保持打开',
    panelOpen(dom) === true, JSON.stringify(panelState(dom)));
  dom.window.close();
}

async function scenarioNoSubstringMismatch() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/mall');
  // 「圆石」「黄铁矿」同时存在，确认不会因为包含「石」而点错行
  const mall = buildMallDom(dom, ITEMS);
  await openPanelAndLoad(dom);

  clickItemName(dom, '圆石');
  await sleep(200);

  record('精确匹配：点击「圆石」不会误点「石头」或「黄铁矿」',
    mall.clickedNames.length === 1 && mall.clickedNames[0] === '圆石',
    `clicked=${JSON.stringify(mall.clickedNames)}`);
  dom.window.close();
}

async function scenarioNotFound() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/mall');
  const mall = buildMallDom(dom, [ITEMS[0]]);
  await openPanelAndLoad(dom);

  // 预先让商城搜索框就等于该物品名，走「已搜索过」的 600ms 分支，返回失败
  mall.search.value = '钻石';
  clickItemName(dom, '钻石');
  await sleep(900);

  record('失败路径：商城找不到该物品时报错',
    errorText(dom).includes('跳转失败') && errorText(dom).includes('钻石'), errorText(dom));
  record('失败路径：面板保持打开', panelOpen(dom) === true);
  record('失败路径：恢复商城搜索框原值',
    mall.search.value === '钻石', `search="${mall.search.value}"`);
  dom.window.close();
}

async function scenarioMissingSearchBox() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/mall');
  // 有物品表、但没有搜索框，且目标物品不在当前列表里
  const mall = buildMallDom(dom, [ITEMS[0]]);
  mall.search.remove();
  await openPanelAndLoad(dom);

  clickItemName(dom, '钻石');
  await waitFor(() => errorText(dom).includes('跳转失败'), '缺少搜索框时的提示', 6000);

  record('失败路径：有物品表但缺搜索框时给出提示',
    errorText(dom).includes('搜索框'), errorText(dom));
  record('失败路径：面板保持打开', panelOpen(dom) === true);
  dom.window.close();
}

// 回归：商城首页在 `/` 与 `/mall` 都会渲染，跳转不能拿 URL 路径当判据
async function scenarioRootPathAlsoWorks() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/');
  const mall = buildMallDom(dom, ITEMS);
  await openPanelAndLoad(dom);

  clickItemName(dom, '石头');
  await waitFor(() => mall.clickedNames.includes('石头'), '根路径下点击商城行', 6000);

  record('回归：从根路径 `/` 进入商城也能跳转',
    mall.clickedNames.includes('石头'), `clicked=${JSON.stringify(mall.clickedNames)}`);
  record('回归：根路径跳转后面板保持打开',
    panelOpen(dom) === true, JSON.stringify(panelState(dom)));
  record('回归：根路径跳转不报错', errorText(dom) === '', errorText(dom));
  record('回归：根路径跳转不碰搜索框',
    mall.search.value === '' && mall.searchHistory.length === 0,
    `search="${mall.search.value}" history=${JSON.stringify(mall.searchHistory)}`);
  dom.window.close();
}

// 页面里既没有商城物品表也没有搜索框时才拒绝
async function scenarioNoMallUi() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/help');
  dom.window.document.getElementById('root').innerHTML = '<div id="mall-detail">帮助中心</div>';
  await openPanelAndLoad(dom);

  clickItemName(dom, '石头');
  await waitFor(() => errorText(dom).includes('跳转失败'), '商城 DOM 缺失时的提示', 6000);

  record('失败路径：页面没有商城物品表时拒绝并说明原因',
    errorText(dom).includes('没有商城物品列表'), errorText(dom));
  record('失败路径：无商城 DOM 时面板保持打开', panelOpen(dom) === true);
  dom.window.close();
}

async function scenarioNoCalculationTriggered() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/mall');
  const mall = buildMallDom(dom, ITEMS);
  await openPanelAndLoad(dom);

  const requests = [];
  const originalFetch = dom.window.fetch;
  dom.window.fetch = async (input, init) => {
    requests.push(String(input));
    return originalFetch(input, init);
  };

  clickItemName(dom, '石头');
  await sleep(250);

  const offerRequests = requests.filter((url) => url.includes('/offers'));
  const itemRequests = requests.filter((url) => /\/api\/mall\/items\?/.test(url));
  record('不冲突：跳转不会触发任何报价抓取（保持手动计算语义）',
    offerRequests.length === 0, `requests=${JSON.stringify(requests)}`);
  record('不冲突：跳转不会重新抓取商品列表',
    itemRequests.length === 0, `requests=${JSON.stringify(requests)}`);
  record('不冲突：跳转期间计算按钮状态未被改动',
    dom.window.document.getElementById('mpe-calculate').textContent === '无需计算',
    dom.window.document.getElementById('mpe-calculate').textContent);
  dom.window.close();
}

async function scenarioManualCalculationStillManual() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/mall');
  buildMallDom(dom, ITEMS);
  // 保持默认 10× 异常过滤，不点击开始计算
  await openPanelOnly(dom);

  const rowsWithFilter = dom.window.document.getElementById('mpe-tbody').textContent;
  const calculate = dom.window.document.getElementById('mpe-calculate');

  record('回归：默认 10× 过滤下仍不自动计算',
    rowsWithFilter.trim() === '' && calculate.textContent.startsWith('开始计算'),
    `empty="${rowsWithFilter.trim()}" button="${calculate.textContent}"`);

  // 关闭再打开面板，不应触发计算
  dom.window.document.getElementById('mpe-close').click();
  await sleep(30);
  dom.window.document.getElementById('mpe-launcher').click();
  await sleep(120);

  record('回归：重开面板不触发计算',
    calculate.textContent.startsWith('开始计算') && panelOpen(dom) === true,
    `button="${calculate.textContent}"`);
  dom.window.close();
}

// 核心诉求：跳转后不再收窄面板，而是让商城的物品详情显示在面板之上。
// jsdom 不做层叠计算，所以这里把「CSS 层级声明」和「DOM 行为」分开断言。
async function scenarioMallDialogStacksAbovePanel() {
  const panelZ = cssZIndex('.mpe-panel {');
  const backdropZ = cssZIndex('.mpe-backdrop {');
  const launcherZ = cssZIndex('.mpe-launcher {');
  const mallDialogZ = cssZIndex('body > [data-slot="dialog-content"]');

  record('层级：商城物品详情的层级高于利润面板',
    mallDialogZ > panelZ, `mallDialog=${mallDialogZ} panel=${panelZ}`);
  record('层级：面板仍高于插件自己的遮罩与启动按钮',
    panelZ > backdropZ && backdropZ === launcherZ,
    `panel=${panelZ} backdrop=${backdropZ} launcher=${launcherZ}`);

  const ruleStart = CONTENT_CSS.indexOf('body > [data-slot="dialog-overlay"]');
  const ruleEnd = CONTENT_CSS.indexOf('}', ruleStart);
  const selectors = CONTENT_CSS.slice(ruleStart, ruleEnd)
    .split('{')[0].trim().split(',').map((selector) => selector.trim());
  record('层级：抬升规则只作用于 body 直属的商城弹层',
    selectors.length === 3 && selectors.every((selector) => selector.startsWith('body > ')),
    selectors.join(' | '));

  const dom = await createExtensionDom('https://mall.vesego.xyz/mall');
  const mall = buildMallDom(dom, ITEMS);
  await openPanelAndLoad(dom);

  clickItemName(dom, '石头');
  await waitFor(() => Boolean(mall.dialog), '商城详情弹出', 4000);

  const state = panelState(dom);
  record('叠层：跳转后商城详情弹出，面板既不关闭也不收窄',
    state.open === true && state.mallDialogOpen === true && state.dockAttr === undefined,
    JSON.stringify(state));
  record('叠层：插件不去挪动商城弹层（交给 CSS 层级处理）',
    mall.dialog.style.left === '' && mall.dialog.style.width === '',
    `left="${mall.dialog.style.left}" width="${mall.dialog.style.width}"`);
  dom.window.close();
}

// 源码里不应再残留并排收窄那一套
function scenarioNoDockLeftovers() {
  record('清理：content.js 不再包含并排收窄与界面偏好逻辑',
    !/mpe-undock|mpe-keep-panel|keepPanelOnJump|panelDocked|canDockPanel|minDockWidth|mpe-dock/.test(CONTENT_JS),
    '相关关键字全部消失');
  record('清理：content.css 不再包含并排样式',
    !/mpe-dock|data-dock|footer-toggle/.test(CONTENT_CSS), '相关关键字全部消失');
}

// v1.7.0 里窄窗口会退回「跳转即关闭面板」，现在不再有收窄这回事，窄窗口也保持打开
async function scenarioNarrowWindowKeepsPanel() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/mall');
  buildMallDom(dom, ITEMS);
  await openPanelAndLoad(dom);

  assert.equal(setViewport(dom, 800, 700), 800, '前置条件：jsdom 视口宽度应能被改小');

  clickItemName(dom, '石头');
  await sleep(200);

  record('窄窗口：视口不足 900px 时面板同样保持打开',
    panelOpen(dom) === true, JSON.stringify(panelState(dom)));
  dom.window.close();
}

// Esc 冲突：商城的详情盖在面板之上时，Esc 该关详情而不是连面板一起关
async function scenarioEscapeBelongsToMallDialog() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/mall');
  const mall = buildMallDom(dom, ITEMS);
  await openPanelAndLoad(dom);

  clickItemName(dom, '石头');
  await waitFor(() => Boolean(mall.dialog), '商城详情弹出', 4000);

  const press = () => dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );

  press();
  await sleep(60);
  record('Esc 归属：商城详情开着时按 Esc 不会连带关掉利润面板',
    panelOpen(dom) === true, JSON.stringify(panelState(dom)));

  mall.closeDialog();
  press();
  await sleep(60);
  record('Esc 归属：详情关掉后 Esc 正常关闭面板',
    panelOpen(dom) === false, JSON.stringify(panelState(dom)));
  dom.window.close();
}

// 表头排序：每一列都能点，同列再点反转方向；排序只重排表格，绝不能触发计算
async function scenarioHeaderSort() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/mall');
  buildMallDom(dom, ITEMS);
  await openPanelAndLoad(dom);

  const requests = [];
  const originalFetch = dom.window.fetch;
  dom.window.fetch = async (input, init) => {
    requests.push(String(input));
    return originalFetch(input, init);
  };
  const calculate = dom.window.document.getElementById('mpe-calculate');
  const calculateBefore = calculate.textContent;

  // ITEMS 的单件利润：钻石 50 > 黄铁矿 5 > 圆石 3 > 石头 1.5
  record('表头排序：默认排序列是单件利润且箭头向下',
    headerState(dom).activeLabel === '单件利润'
      && headerState(dom).arrow === '▼'
      && headerState(dom).ariaSort === 'descending',
    JSON.stringify(headerState(dom)));
  record('表头排序：默认顺序就是单件利润从高到低',
    rowNames(dom).join('>') === '钻石>黄铁矿>圆石>石头', rowNames(dom).join('>'));

  record('表头排序：只有 # 序号列不可点，其余列都能点',
    headerState(dom).columns === 7
      && headerState(dom).sortable === 6
      && headerState(dom).plain.join('') === '#',
    JSON.stringify(headerState(dom)));
  record('表头排序：工具栏原来的排序下拉已经移除',
    dom.window.document.getElementById('mpe-sort') === null
      && dom.window.document.querySelector('.mpe-sort-field') === null);

  // 换一列：数值列第一次点按降序（在售数量 石头 111610 > 黄铁矿 700 > 圆石 500 > 钻石 30）
  clickHeader(dom, '在售数量');
  await sleep(30);
  record('表头排序：换到「在售数量」时第一次点是降序',
    rowNames(dom).join('>') === '石头>黄铁矿>圆石>钻石'
      && headerState(dom).activeLabel === '在售数量'
      && headerState(dom).arrow === '▼',
    `${headerState(dom).activeLabel}${headerState(dom).arrow} ${rowNames(dom).join('>')}`);

  // 同一列再点一次：反转
  clickHeader(dom, '在售数量');
  await sleep(30);
  record('表头排序：同一列再点一次反转为升序',
    rowNames(dom).join('>') === '钻石>圆石>黄铁矿>石头'
      && headerState(dom).arrow === '▲'
      && headerState(dom).ariaSort === 'ascending',
    `${headerState(dom).arrow} ${rowNames(dom).join('>')}`);

  // 文本列第一次点按名称升序，而不是降序
  clickHeader(dom, '商品');
  await sleep(30);
  const expectedNameAsc = ITEMS.map((item) => item.itemName)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .join('>');
  record('表头排序：商品列第一次点按名称升序',
    rowNames(dom).join('>') === expectedNameAsc && headerState(dom).arrow === '▲',
    `${rowNames(dom).join('>')} vs ${expectedNameAsc}`);

  record('表头排序：搜索与数量过滤条件不受排序影响',
    dom.window.document.getElementById('mpe-search').value === ''
      && dom.window.document.getElementById('mpe-min-sell-amount').value === '');

  // 红线：点表头既不该抓报价，也不该把「计算」变成自动的
  record('表头排序：点表头不会触发任何报价抓取',
    requests.filter((url) => url.includes('/offers')).length === 0,
    `requests=${JSON.stringify(requests)}`);
  record('表头排序：点表头不会改动计算按钮状态',
    calculate.textContent === calculateBefore && calculateBefore === '无需计算',
    `before="${calculateBefore}" after="${calculate.textContent}"`);

  // 总利润模式列变多，默认排序跟着切；切回单件模式时列已不存在，应自动回落
  dom.window.document.querySelector('.mpe-segment[data-mode="total"]').click();
  await sleep(40);
  record('表头排序：切到总利润模式后表头变 8 列、可点 7 列、默认排总利润',
    headerState(dom).columns === 8
      && headerState(dom).sortable === 7
      && headerState(dom).activeLabel === '总利润',
    JSON.stringify(headerState(dom)));

  clickHeader(dom, '可匹配数量');
  await sleep(30);
  record('表头排序：总利润模式下的「可匹配数量」同样可点',
    headerState(dom).activeLabel === '可匹配数量' && headerState(dom).arrow === '▼',
    JSON.stringify(headerState(dom)));

  dom.window.document.querySelector('.mpe-segment[data-mode="unit"]').click();
  await sleep(40);
  record('表头排序：切回单件模式时已不存在的排序列自动回落到默认',
    headerState(dom).activeLabel === '单件利润' && headerState(dom).arrow === '▼',
    JSON.stringify(headerState(dom)));

  dom.window.close();
}

// 渲染效率（v1.10.0）：输入防抖，且一次渲染里可见行只算一遍。
// 用 sortRows 的调用次数当探针：content.js 里只有 getVisibleRows 会调它，
// 一次渲染出现的次数就等于可见行被计算的次数（改之前是 3 —— 摘要 2 次 + 表头默认排序）。
async function scenarioRenderEfficiency() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/mall');
  buildMallDom(dom, ITEMS);
  await openPanelAndLoad(dom);

  const document = dom.window.document;
  const search = document.getElementById('mpe-search');
  const minSell = document.getElementById('mpe-min-sell-amount');

  const searchBaseline = dom.__coreStats.sortRows;
  typeInto(dom, search, '石');
  typeInto(dom, search, '石头');
  typeInto(dom, search, '石头石');
  typeInto(dom, search, '石头');
  record('渲染效率：连敲键盘期间不做任何全表重排',
    dom.__coreStats.sortRows === searchBaseline,
    `sortRows=${dom.__coreStats.sortRows} baseline=${searchBaseline}`);

  await sleep(INPUT_SETTLE_MS);
  const searchDelta = dom.__coreStats.sortRows - searchBaseline;
  record('渲染效率：停止输入后只重排一次（可见行不再被算两遍）',
    searchDelta === 1, `sortRows 增量=${searchDelta}`);
  record('渲染效率：防抖结束后筛选结果正确',
    rowNames(dom).join(',') === '石头', rowNames(dom).join(','));

  typeInto(dom, search, '石头 ');
  await sleep(INPUT_SETTLE_MS);
  record('渲染效率：输入框里的尾随空格不会被写回逻辑吃掉',
    search.value === '石头 ', JSON.stringify(search.value));
  record('渲染效率：尾随空格不影响筛选（只在筛选前 trim）',
    rowNames(dom).join(',') === '石头', rowNames(dom).join(','));

  const minBaseline = dom.__coreStats.sortRows;
  typeInto(dom, minSell, '1');
  typeInto(dom, minSell, '10');
  await sleep(INPUT_SETTLE_MS);
  const minDelta = dom.__coreStats.sortRows - minBaseline;
  record('渲染效率：最低在售数量同样只重排一次',
    minDelta === 1, `sortRows 增量=${minDelta}`);
  dom.window.close();
}

// 过期缓存（v1.10.0）：超过 5 分钟有效期的结果继续显示并说明已过期，而不是整表变空
async function scenarioStaleCacheKeepsRows() {
  const url = 'https://mall.vesego.xyz/mall';
  const domA = await createExtensionDom(url);
  buildMallDom(domA, ITEMS);
  await openPanelOnly(domA);

  record('过期缓存前置：默认 10× 过滤下按钮显示开始计算',
    calcButtonText(domA).startsWith('开始计算'), calcButtonText(domA));

  domA.window.document.getElementById('mpe-calculate').click();
  await waitFor(() => rowNames(domA).length > 0, '异常过滤结果写入表格', 8000);

  const analyses = domA.__store['mallProfit.analyses.v1'];
  const staleAt = Date.now() - 10 * 60 * 1000;
  let aged = 0;
  for (const entries of Object.values(analyses || {})) {
    for (const entry of Object.values(entries)) {
      entry.updatedAt = staleAt;
      aged += 1;
    }
  }
  record('过期缓存前置：结果已写入本地缓存并做旧',
    aged > 0, `aged=${aged} rows=${rowNames(domA).length}`);
  domA.window.close();

  // 用同一份（已经过期的）缓存重新打开页面
  const domB = await createExtensionDom(url, { seedStore: domA.__store });
  buildMallDom(domB, ITEMS);
  await openPanelOnly(domB);
  await sleep(60);

  record('过期缓存：重开页面后过期结果仍然显示，不再凭空变空',
    rowNames(domB).length > 0, `rows=${rowNames(domB).length}`);
  record('过期缓存：状态栏说明数据已过有效期',
    statusNote(domB).includes('有效期'), statusNote(domB));
  record('过期缓存：计算按钮改成重新计算，与提示一致',
    calcButtonText(domB).startsWith('重新计算'), calcButtonText(domB));
  record('过期缓存：过期本身不会自动触发重算',
    offerRequestCount(domB) === 0, `offers=${offerRequestCount(domB)}`);
  domB.window.close();
}

// 失败项重试（v1.10.0）：失败的商品不会被写进缓存，一键重试只补它们
async function scenarioRetryFailedItems() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/mall');
  buildMallDom(dom, ITEMS);
  await openPanelOnly(dom);

  const originalFetch = dom.window.fetch;
  let failing = true;
  dom.window.fetch = async (input, init) => {
    const target = new URL(String(input));
    if (failing && target.pathname.endsWith('/offers') && decodeURIComponent(target.pathname).includes('石头')) {
      throw new Error('模拟报价接口失败');
    }
    return originalFetch(input, init);
  };

  dom.window.document.getElementById('mpe-calculate').click();
  await waitFor(() => rowNames(dom).length > 0, '其余商品完成计算', 12000);

  const retry = retryButton(dom);
  record('失败重试：出现「重试失败项」按钮并标出数量',
    retry.hidden === false && retry.textContent.includes('1'),
    `hidden=${retry.hidden} text=${retry.textContent}`);
  record('失败重试：失败的商品不会混进结果里',
    !rowNames(dom).includes('石头'), rowNames(dom).join(','));

  const succeededRows = rowNames(dom).length;
  const offersBeforeRetry = offerRequestCount(dom);
  // 切原始请求数组要用总条数，不能用过滤后的报价条数
  const requestsBeforeRetry = dom.__requests.length;
  failing = false;
  retry.click();
  await waitFor(() => rowNames(dom).includes('石头'), '重试后补齐失败商品', 12000);

  const offersUsed = offerRequestCount(dom) - offersBeforeRetry;
  // 只看重试这一轮碰了哪些商品，比数请求条数更贴近契约（翻页会让条数随夹具变化）
  const retriedItems = new Set(dom.__requests.slice(requestsBeforeRetry).map((requestPath) => {
    const matched = requestPath.match(/\/items\/([^/]+)\/offers/);
    return matched ? decodeURIComponent(matched[1]) : requestPath;
  }));
  record('失败重试：重试后失败商品被补齐', rowNames(dom).includes('石头'), rowNames(dom).join(','));
  record('失败重试：只重新请求失败的那一个商品，已算好的结果不重算',
    retriedItems.size === 1 && retriedItems.has('石头'),
    `重试涉及=${[...retriedItems].join(',')} offers=${offersUsed}`);
  record('失败重试：其余商品的结果没有被清掉',
    rowNames(dom).length === succeededRows + 1,
    `${succeededRows} → ${rowNames(dom).length}`);
  record('失败重试：重试成功后按钮自动隐藏',
    retryButton(dom).hidden === true, `hidden=${retryButton(dom).hidden}`);
  dom.window.close();
}

// 计算范围（v1.10.0）：把范围收窄成「当前筛选结果的前 N 条」之后，
// 只该为这 N 个商品拉报价，范围外的商品一个请求都不许发。
// 计算范围（v1.10.0）：选「当前筛选结果」后，只有筛选出来的那部分商品会去拉报价。
async function scenarioScopeLimitedCalculation() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/mall', { items: SCOPE_ITEMS });
  buildMallDom(dom, SCOPE_ITEMS);
  // 保持默认 10x 异常过滤：这样「点计算」才真的会去拉报价，正好用来数请求
  await openPanelOnly(dom);
  const document = dom.window.document;

  record('计算范围：默认算全部商品，按钮标出条数',
    document.getElementById('mpe-calc-scope').value === 'all'
      && calcButtonText(dom) === `开始计算（${SCOPE_ITEMS.length} 条）`,
    `scope=${document.getElementById('mpe-calc-scope').value} button=${calcButtonText(dom)}`);

  commitChange(dom, 'mpe-calc-scope', 'filtered');
  await sleep(30);
  record('计算范围：切到当前筛选结果后算的是筛选结果的全部',
    calcButtonText(dom) === `开始计算（${SCOPE_ITEMS.length} 条）`,
    `button=${calcButtonText(dom)}`);

  // 搜索把范围压到 3 条：只有这 3 个商品会去拉报价
  typeInto(dom, document.getElementById('mpe-search'), '矿石1');
  await sleep(INPUT_SETTLE_MS);
  record('计算范围：范围跟着筛选条件走，按钮条数同步收窄',
    calcButtonText(dom) === '开始计算（3 条）', calcButtonText(dom));
  record('计算范围：状态栏常驻说明当前范围',
    statusNote(dom).includes('计算范围：当前筛选结果（3 条）'), statusNote(dom));

  dom.__requests.length = 0;
  document.getElementById('mpe-calculate').click();
  await waitFor(() => rowNames(dom).length >= 3, '范围内的商品算完', 12000);

  const touched = [...requestedOfferItems(dom)].sort();
  record('计算范围：只为筛选结果里的 3 个商品拉报价，其余一个请求都没发',
    touched.length === 3 && ['矿石10', '矿石11', '矿石12'].every((name) => touched.includes(name)),
    `touched=${touched.join(',')}`);
  record('计算范围：表格里也只有这 3 条结果',
    rowNames(dom).length === 3, `rows=${rowNames(dom).length}`);

  // 清掉搜索：范围恢复全量，已经算好的 3 条结果不受影响
  typeInto(dom, document.getElementById('mpe-search'), '');
  await sleep(INPUT_SETTLE_MS);
  record('计算范围：清掉搜索后范围恢复全量，已算好的结果不动',
    calcButtonText(dom).includes(`（${SCOPE_ITEMS.length} 条）`) && rowNames(dom).length === 3,
    `button=${calcButtonText(dom)} rows=${rowNames(dom).length}`);

  dom.window.close();
}

(async () => {
  await scenarioFastPath();
  await scenarioSearchPath();
  await scenarioMallDialogStacksAbovePanel();
  await scenarioNoDockLeftovers();
  await scenarioNarrowWindowKeepsPanel();
  await scenarioEscapeBelongsToMallDialog();
  await scenarioHeaderSort();
  await scenarioNoSubstringMismatch();
  await scenarioNotFound();
  await scenarioMissingSearchBox();
  await scenarioRootPathAlsoWorks();
  await scenarioNoMallUi();
  await scenarioNoCalculationTriggered();
  await scenarioManualCalculationStillManual();
  await scenarioRenderEfficiency();
  await scenarioStaleCacheKeepsRows();
  await scenarioRetryFailedItems();
  await scenarioScopeLimitedCalculation();

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
})().catch((error) => {
  console.error('验证脚本异常：', error);
  process.exitCode = 1;
});

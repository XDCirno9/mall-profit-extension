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

const ITEMS = [
  { itemName: '石头', minSellPrice: 1, maxBuyPrice: 2.5, sellAmount: 111610, sellOfferCount: 76, buyOfferCount: 56, totalOfferCount: 132, vanillaId: null },
  { itemName: '圆石', minSellPrice: 2, maxBuyPrice: 5, sellAmount: 500, sellOfferCount: 10, buyOfferCount: 8, totalOfferCount: 18, vanillaId: 'minecraft:cobblestone' },
  { itemName: '钻石', minSellPrice: 40, maxBuyPrice: 90, sellAmount: 30, sellOfferCount: 4, buyOfferCount: 3, totalOfferCount: 7, vanillaId: 'minecraft:diamond' },
  { itemName: '黄铁矿', minSellPrice: 3, maxBuyPrice: 8, sellAmount: 700, sellOfferCount: 6, buyOfferCount: 5, totalOfferCount: 11, vanillaId: null }
];

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
  // 用来验证并排模式下插件不去压暗/锁住商城，以及 Esc 该归谁
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
      const matched = ITEMS.filter((item) => !query || item.itemName.includes(query));
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

async function createExtensionDom(url) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });

  const store = {};
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
    let payload;

    if (target.pathname === '/api/mall/items') {
      const limit = Number(target.searchParams.get('limit') || 100);
      const offset = Number(target.searchParams.get('offset') || 0);
      payload = { total: ITEMS.length, items: ITEMS.slice(offset, offset + limit) };
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

function dockState(dom) {
  const document = dom.window.document;
  return {
    open: panelOpen(dom),
    dock: document.getElementById('mpe-panel').dataset.dock,
    htmlDock: document.documentElement.classList.contains('mpe-dock'),
    backdropHidden: document.getElementById('mpe-backdrop').hidden,
    undockHidden: document.getElementById('mpe-undock').hidden,
    scrollLocked: document.documentElement.classList.contains('mpe-panel-open'),
    keepPanelChecked: document.getElementById('mpe-keep-panel').checked
  };
}

function clickItemName(dom, itemName) {
  const document = dom.window.document;
  const buttons = [...document.querySelectorAll('#mpe-tbody button[data-mpe-item]')];
  const button = buttons.find((node) => node.dataset.mpeItem === itemName);
  assert.ok(button, `利润表格里应存在「${itemName}」这一行`);
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
  const dock = dockState(dom);
  record('快路径：跳转后面板保持打开，不再自动关闭',
    dock.open === true && dock.dock === 'true', JSON.stringify(dock));
  record('快路径：进入并排模式，并给商城模态框腾出右侧空间',
    dock.htmlDock === true, JSON.stringify(dock));
  record('快路径：并排模式下不再用遮罩压暗商城、也不锁页面滚动',
    dock.backdropHidden === true && dock.scrollLocked === false, JSON.stringify(dock));
  record('快路径：头部出现「展开面板」按钮', dock.undockHidden === false, JSON.stringify(dock));
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
  record('搜索路径：跳转后面板同样保持打开（并排模式）',
    panelOpen(dom) === true && dockState(dom).dock === 'true', JSON.stringify(dockState(dom)));
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
  record('回归：根路径跳转后面板保持打开（并排模式）',
    panelOpen(dom) === true && dockState(dom).dock === 'true', JSON.stringify(dockState(dom)));
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
    rowsWithFilter.trim() === '' && calculate.textContent === '开始计算',
    `empty="${rowsWithFilter.trim()}" button="${calculate.textContent}"`);

  // 关闭再打开面板，不应触发计算
  dom.window.document.getElementById('mpe-close').click();
  await sleep(30);
  dom.window.document.getElementById('mpe-launcher').click();
  await sleep(120);

  record('回归：重开面板不触发计算',
    calculate.textContent === '开始计算' && panelOpen(dom) === true,
    `button="${calculate.textContent}"`);
  dom.window.close();
}

// 并排模式可以随时退出：点「展开面板」回到原来的全屏浮层
async function scenarioUndockRestoresPanel() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/mall');
  const mall = buildMallDom(dom, ITEMS);
  await openPanelAndLoad(dom);

  clickItemName(dom, '石头');
  await waitFor(() => dockState(dom).dock === 'true', '进入并排模式', 4000);

  dom.window.document.getElementById('mpe-undock').click();
  await sleep(60);

  const dock = dockState(dom);
  record('并排退出：点「展开面板」后回到浮层模式',
    dock.open === true && dock.dock === 'false' && dock.htmlDock === false, JSON.stringify(dock));
  record('并排退出：恢复遮罩与页面滚动锁',
    dock.backdropHidden === false && dock.scrollLocked === true, JSON.stringify(dock));
  record('并排退出：商城详情仍开着，不被插件关掉', Boolean(mall.dialog), `dialog=${Boolean(mall.dialog)}`);
  dom.window.close();
}

// 页脚的开关可以让整个行为退回「跳转即关闭面板」
async function scenarioKeepPanelDisabledClosesPanel() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/mall');
  buildMallDom(dom, ITEMS);
  await openPanelAndLoad(dom);

  const toggle = dom.window.document.getElementById('mpe-keep-panel');
  toggle.checked = false;
  toggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await sleep(40);

  record('可关闭：取消勾选本身不会收起面板', panelOpen(dom) === true);

  clickItemName(dom, '石头');
  await sleep(200);

  record('可关闭：关掉选项后跳转回到「自动关闭面板」的老行为',
    panelOpen(dom) === false, JSON.stringify(dockState(dom)));
  record('可关闭：勾选状态写入本地存储',
    Boolean(dom.__store['mallProfit.prefs.v1']) && dom.__store['mallProfit.prefs.v1'].keepPanelOnJump === false,
    JSON.stringify(dom.__store['mallProfit.prefs.v1']));
  dom.window.close();
}

// 窄窗口左右并排没有意义，应退回「跳转即关闭面板」
async function scenarioNarrowWindowClosesPanel() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/mall');
  buildMallDom(dom, ITEMS);
  await openPanelAndLoad(dom);

  assert.equal(setViewport(dom, 800, 700), 800, '前置条件：jsdom 视口宽度应能被改小');

  clickItemName(dom, '石头');
  await sleep(200);

  record('窄窗口：视口不足 900px 时退回「跳转即关闭面板」',
    panelOpen(dom) === false, JSON.stringify(dockState(dom)));
  dom.window.close();
}

// Esc 冲突：并排模式下商城的详情也开着，Esc 该关详情而不是连面板一起关
async function scenarioEscapeBelongsToMallDialog() {
  const dom = await createExtensionDom('https://mall.vesego.xyz/mall');
  const mall = buildMallDom(dom, ITEMS);
  await openPanelAndLoad(dom);

  clickItemName(dom, '石头');
  await waitFor(() => dockState(dom).dock === 'true', '进入并排模式', 4000);

  const press = () => dom.window.document.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );

  press();
  await sleep(60);
  record('Esc 归属：商城详情开着时按 Esc 不会连带关掉利润面板',
    panelOpen(dom) === true && dockState(dom).dock === 'true', JSON.stringify(dockState(dom)));

  mall.closeDialog();
  press();
  await sleep(60);
  record('Esc 归属：详情关掉后 Esc 正常关闭面板并解除并排状态',
    panelOpen(dom) === false && dockState(dom).htmlDock === false, JSON.stringify(dockState(dom)));
  dom.window.close();
}

(async () => {
  await scenarioFastPath();
  await scenarioSearchPath();
  await scenarioUndockRestoresPanel();
  await scenarioKeepPanelDisabledClosesPanel();
  await scenarioNarrowWindowClosesPanel();
  await scenarioEscapeBelongsToMallDialog();
  await scenarioNoSubstringMismatch();
  await scenarioNotFound();
  await scenarioMissingSearchBox();
  await scenarioRootPathAlsoWorks();
  await scenarioNoMallUi();
  await scenarioNoCalculationTriggered();
  await scenarioManualCalculationStillManual();

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
})().catch((error) => {
  console.error('验证脚本异常：', error);
  process.exitCode = 1;
});

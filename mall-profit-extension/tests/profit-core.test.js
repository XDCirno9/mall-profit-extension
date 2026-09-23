const assert = require('node:assert/strict');
require('../profit-core.js');

const Core = globalThis.MallProfitCore;

const unitRows = Core.buildUnitRows([
  { itemName: '有利润', minSellPrice: 2, maxBuyPrice: 5, vanillaId: 'minecraft:stone' },
  { itemName: '无利润', minSellPrice: 5, maxBuyPrice: 5 },
  { itemName: '负利润', minSellPrice: 8, maxBuyPrice: 3 },
  { itemName: '缺失价格', minSellPrice: null, maxBuyPrice: 4 },
  { itemName: '零价格', minSellPrice: 0, maxBuyPrice: 4 }
]);

assert.deepEqual(unitRows.map((row) => row.itemName), ['有利润']);
assert.equal(unitRows[0].unitProfit, 3);
assert.equal(unitRows[0].profitRate, 150);
assert.equal(unitRows[0].vanillaId, 'minecraft:stone');

const matched = Core.calculateMatchedProfit(
  [
    { price: 10, amount: 5 },
    { price: 3, amount: 7 }
  ],
  [
    { price: 4, amount: 7 },
    { price: 2, amount: 4 }
  ]
);
assert.equal(matched.matchedQty, 5);
assert.equal(matched.totalProfit, 38);
assert.equal(matched.totalCost, 12);
assert.equal(matched.totalRevenue, 50);

const multiLevel = Core.calculateMatchedProfit(
  [{ price: 5, amount: 10 }],
  [
    { price: 1, amount: 3 },
    { price: 3, amount: 4 }
  ]
);
assert.equal(multiLevel.matchedQty, 7);
assert.equal(multiLevel.totalProfit, 20);

const filteredBuy = Core.filterOutlierOffers(
  [{ price: 1, amount: 1 }, { price: 10000, amount: 1 }],
  10,
  'buy'
);
assert.deepEqual(filteredBuy.offers.map((offer) => offer.price), [1]);
assert.equal(filteredBuy.outliers.length, 1);

const filteredSell = Core.filterOutlierOffers(
  [{ price: 1, amount: 1 }, { price: 450, amount: 2 }, { price: 500, amount: 3 }],
  10,
  'sell'
);
assert.deepEqual(filteredSell.offers.map((offer) => offer.price), [450, 500]);
assert.equal(filteredSell.outliers.length, 1);

const offerAnalysis = Core.buildOfferAnalysis(
  [{ price: 1, amount: 5 }, { price: 10000, amount: 5 }],
  [{ price: 450, amount: 3 }, { price: 500, amount: 4 }, { price: 88888, amount: 1 }],
  10
);
assert.equal(offerAnalysis.maxBuyPrice, 1);
assert.equal(offerAnalysis.minSellPrice, 450);
assert.equal(offerAnalysis.excluded, true);
assert.equal(offerAnalysis.outlierCount, 2);
const portFiltered = Core.filterBlacklistedOffers(
  [
    { price: 5, amount: 2, region: '港口甲' },
    { price: 6, amount: 3, nearestPort: { name: '港口乙' } }
  ],
  ['港口甲']
);
assert.deepEqual(portFiltered.offers.map((offer) => offer.port), ['港口乙']);
assert.equal(portFiltered.blocked.length, 1);

const portAnalysis = Core.buildOfferAnalysis(
  [{ price: 10, amount: 5, region: '港口甲' }, { price: 8, amount: 5, region: '港口乙' }],
  [{ price: 2, amount: 10, region: '港口乙' }],
  0,
  ['港口甲']
);
assert.equal(portAnalysis.maxBuyPrice, 8);
assert.equal(portAnalysis.blacklistedOfferCount, 1);
const parsedObject = Core.parsePortBlacklistText(JSON.stringify({
  format: 'mall-profit-port-blacklist',
  version: 1,
  exportedAt: '2026-09-22T00:00:00.000Z',
  ports: ['星月湾', '五月花港']
}));
assert.equal(parsedObject.ok, true);
assert.deepEqual(parsedObject.ports, ['星月湾', '五月花港']);

const parsedArray = Core.parsePortBlacklistText('["星月湾","五月花港"]');
assert.deepEqual(parsedArray, { ok: true, ports: ['星月湾', '五月花港'] });

const parsedLines = Core.parsePortBlacklistText('星月湾\n五月花港\r\n  \n星月湾');
assert.deepEqual(parsedLines, { ok: true, ports: ['星月湾', '五月花港'] });

const parsedCsv = Core.parsePortBlacklistText('星月湾, 五月花港,,中城港');
assert.deepEqual(parsedCsv, { ok: true, ports: ['星月湾', '五月花港', '中城港'] });

const parsedScalar = Core.parsePortBlacklistText('123');
assert.deepEqual(parsedScalar, { ok: true, ports: ['123'] });

const parsedBadObject = Core.parsePortBlacklistText('{"format":"mall-profit-port-blacklist"}');
assert.equal(parsedBadObject.ok, false);
assert.equal(parsedBadObject.error, 'JSON 中缺少 ports 数组');

const parsedBadArray = Core.parsePortBlacklistText('[{"portName":"星月湾"}]');
assert.equal(parsedBadArray.ok, false);

const parsedEmpty = Core.parsePortBlacklistText('   ');
assert.equal(parsedEmpty.ok, false);
assert.equal(parsedEmpty.error, '没有解析到任何港口名称');

const parsedEmptyObject = Core.parsePortBlacklistText('{}');
assert.equal(parsedEmptyObject.ok, false);

const sorted = Core.sortRows([
  { itemName: 'A', unitProfit: 1, totalProfit: null },
  { itemName: 'B', unitProfit: 3, totalProfit: null },
  { itemName: 'C', unitProfit: 2, totalProfit: null }
], 'unitProfit-desc');
assert.deepEqual(sorted.map((row) => row.itemName), ['B', 'C', 'A']);

// ---- 表头排序：每一列都能升 / 降序 ----
const sortFixture = [
  { itemName: '圆石', minSellPrice: 30, maxBuyPrice: 40, unitProfit: 10, profitRate: 33.3, sellAmount: 5, totalProfit: 100, matchedQty: 10 },
  { itemName: '木头', minSellPrice: 10, maxBuyPrice: 25, unitProfit: 15, profitRate: 150, sellAmount: 40, totalProfit: 300, matchedQty: 20 },
  { itemName: '石头', minSellPrice: 20, maxBuyPrice: 22, unitProfit: 2, profitRate: 10, sellAmount: 12, totalProfit: 20, matchedQty: 30 }
];
const names = (rows) => rows.map((row) => row.itemName);

const numericFields = [
  'minSellPrice', 'maxBuyPrice', 'unitProfit', 'profitRate', 'sellAmount', 'totalProfit', 'matchedQty'
];
for (const field of numericFields) {
  const expectedAsc = sortFixture
    .slice()
    .sort((a, b) => a[field] - b[field])
    .map((row) => row.itemName);
  assert.deepEqual(names(Core.sortRows(sortFixture, `${field}-asc`)), expectedAsc, `${field} 升序`);
  assert.deepEqual(
    names(Core.sortRows(sortFixture, `${field}-desc`)),
    expectedAsc.slice().reverse(),
    `${field} 降序`
  );
}

const expectedNameAsc = sortFixture
  .slice()
  .sort((a, b) => a.itemName.localeCompare(b.itemName, 'zh-CN'))
  .map((row) => row.itemName);
assert.deepEqual(names(Core.sortRows(sortFixture, 'itemName-asc')), expectedNameAsc, '商品名称升序');
assert.deepEqual(
  names(Core.sortRows(sortFixture, 'itemName-desc')),
  expectedNameAsc.slice().reverse(),
  '商品名称降序'
);

// 旧键形式继续可用；非法键、缺失键一律退回默认的「单件利润 高 → 低」
const defaultValue = ['木头', '圆石', '石头'];
for (const key of ['unitProfit-desc', 'bogus', 'nope-asc', '', null, undefined, 42]) {
  assert.deepEqual(names(Core.sortRows(sortFixture, key)), defaultValue, `非法键 ${String(key)} 应退回默认`);
}

// 解析结果：合法键带类型，非法键 valid=false
assert.deepEqual(Core.parseSortKey('sellAmount-asc'), {
  field: 'sellAmount', direction: 'asc', type: 'number', valid: true
});
assert.equal(Core.parseSortKey('itemName-desc').type, 'text');
assert.equal(Core.parseSortKey('nope-asc').valid, false);
assert.equal(Core.parseSortKey(42).valid, false);
assert.equal(Core.sortFields.sellAmount, 'number');
assert.equal(Core.sortFields.itemName, 'text');

// 空值排最后，且同值时按商品名兜底，方向不影响兜底顺序
const withNulls = [
  { itemName: 'X', unitProfit: null },
  { itemName: 'Y', unitProfit: 5 },
  { itemName: 'Z', unitProfit: null }
];
assert.deepEqual(names(Core.sortRows(withNulls, 'unitProfit-desc')), ['Y', 'X', 'Z']);
assert.deepEqual(names(Core.sortRows(withNulls, 'unitProfit-asc')), ['Y', 'X', 'Z']);

// 排序不能改原数组
const beforeSort = JSON.parse(JSON.stringify(sortFixture));
Core.sortRows(sortFixture, 'unitProfit-asc');
assert.deepEqual(sortFixture, beforeSort);

// 价格倍率上限：给 SMCShop 那种「聚合极值」数据源用的噪声判据。它的两个价格都是全站极值，
// 而真实行商物品的倍率都在 10 倍以内，乱标价的挂单能把极值撑到十几万倍
// （实测抓到的原值：成书卖价 1 → 收价 125000、骨头卖价 1 → 收价 99999）
assert.equal(Core.withinPriceRatio(125000, 1, 10), false);
assert.equal(Core.withinPriceRatio(99999, 1, 10), false);
assert.equal(Core.withinPriceRatio(90, 40, 10), true);
// 判据是「超过」上限才拦，恰好等于算通过
assert.equal(Core.withinPriceRatio(100, 10, 10), true);
assert.equal(Core.withinPriceRatio(100.1, 10, 10), false);
// limit <= 0 表示不设上限（商城的 features.priceRatioFilter 就是关的）
assert.equal(Core.withinPriceRatio(125000, 1, 0), true);
assert.equal(Core.withinPriceRatio(125000, 1, null), true);
assert.equal(Core.withinPriceRatio(125000, 1, undefined), true);
// 卖价缺失、非正或不是有限数时没有可比的基准，宁可放行也不要凭空误杀
assert.equal(Core.withinPriceRatio(5, 0, 10), true);
assert.equal(Core.withinPriceRatio(5, null, 10), true);
assert.equal(Core.withinPriceRatio(5, -1, 10), true);
assert.equal(Core.withinPriceRatio(5, Number.NaN, 10), true);
assert.equal(Core.withinPriceRatio(null, 5, 10), true);

// 库存核对：SMCShop 的挂单可以「标了价但没有货」（amount 为 0），
// 服务端聚合出的最低卖价经常就是这些空挂单的价，所以只在有货的挂单里取极值。
// 下面这几条用的是实测抓到的原值：破碎王冠摘要 10000（那条挂单 amount=0）→ 有货其实要 80000，
// 而最高收价只有 66666，也就是说这件物品按有货价算是负利润。
const crown = Core.resolveInStockPrices([
  { item: '破碎王冠', type: 'SELL', price: 10000, amount: 0 },
  { item: '破碎王冠', type: 'SELL', price: 80000, amount: 1 },
  { item: '破碎王冠', type: 'SELL', price: 84500, amount: 0 },
  { item: '破碎王冠', type: 'BUY', price: 66666, amount: 54 }
], '破碎王冠', { cap: 200 });
assert.equal(crown.minSellPrice, 80000);
assert.equal(crown.maxBuyPrice, 66666);
assert.equal(crown.sellCount, 1);
assert.equal(crown.buyCount, 1);
assert.equal(crown.outOfStockCount, 2);
assert.equal(crown.truncated, false);
assert.equal(crown.unknownShape, false);

// 卖单全是空挂单 ⇒ 买不到（发酵桶实测就是这样：2 条卖单 amount 都是 0）
const barrel = Core.resolveInStockPrices([
  { item: '发酵桶', type: 'SELL', price: 15000, amount: 0 },
  { item: '发酵桶', type: 'SELL', price: 31000, amount: 0 },
  { item: '发酵桶', type: 'BUY', price: 30000, amount: 128 }
], '发酵桶', { cap: 200 });
assert.equal(barrel.minSellPrice, null);
assert.equal(barrel.maxBuyPrice, 30000);
assert.equal(barrel.outOfStockCount, 2);

// 服务端是 LIKE 模糊匹配：查「圆石」会带回「深板岩圆石」，必须按 item 精确相等筛
const fuzzy = Core.resolveInStockPrices([
  { item: '深板岩圆石', type: 'SELL', price: 0.01, amount: 999 },
  { item: '圆石', type: 'SELL', price: 0.5, amount: 100 },
  { item: '圆石台阶', type: 'BUY', price: 9, amount: 999 }
], '圆石', { cap: 200 });
assert.equal(fuzzy.minSellPrice, 0.5);
assert.equal(fuzzy.maxBuyPrice, null);
assert.equal(fuzzy.sellCount, 1);
assert.equal(fuzzy.buyCount, 0);

// 一次最多返回 cap 条。达到上限时数组里可能整段缺一类挂单
// （实测查「圆石」200 条全是卖单，买单一条都没有），这时不能断定「没人收」
const capped = Core.resolveInStockPrices(
  Array.from({ length: 200 }, (_, index) => ({ item: '圆石', type: 'SELL', price: 0.01 * index, amount: 1 })),
  '圆石',
  { cap: 200 }
);
assert.equal(capped.truncated, true);
assert.equal(capped.maxBuyPrice, null);

// 有精确匹配的行却一条都没有 amount 字段 ⇒ 接口形状变了，
// 不能把「读不到库存」当成「全都没货」（那样整张表会凭空变空）
const shape = Core.resolveInStockPrices([
  { item: '钻石', type: 'SELL', price: 40 },
  { item: '钻石', type: 'BUY', price: 90 }
], '钻石', { cap: 200 });
assert.equal(shape.unknownShape, true);
assert.equal(shape.missingAmount, 2);
// 只有一部分行缺字段时不算形状异常（按缺货处理，保守）
const partial = Core.resolveInStockPrices([
  { item: '钻石', type: 'SELL', price: 40 },
  { item: '钻石', type: 'SELL', price: 45, amount: 3 }
], '钻石', { cap: 200 });
assert.equal(partial.unknownShape, false);
assert.equal(partial.minSellPrice, 45);

// 空数组、非数组、没匹配上时都不能抛错，交回 null 让调用方处理
assert.deepEqual(Core.resolveInStockPrices([], '石头', { cap: 200 }).minSellPrice, null);
assert.equal(Core.resolveInStockPrices(null, '石头', { cap: 200 }).truncated, false);
assert.equal(Core.resolveInStockPrices([{ item: '沙子', type: 'SELL', price: 3, amount: 1 }], '石头').sellCount, 0);
// 没给 cap 就不判截断
assert.equal(Core.resolveInStockPrices([{ item: '石头', type: 'SELL', price: 1, amount: 1 }], '石头').truncated, false);

console.log('profit-core tests passed');






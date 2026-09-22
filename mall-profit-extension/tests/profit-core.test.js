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

console.log('profit-core tests passed');






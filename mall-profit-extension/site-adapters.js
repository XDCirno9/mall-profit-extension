/*
 * 站点适配描述。每个商城一份「纯数据 + 纯函数映射」，不放 DOM 操作——
 * 需要碰页面的部分（跳转）按 `jump.kind` 留在 content.js，这样这个文件可以单独在
 * jsdom 里 require 进来做单测，也能一眼看出两个站点到底差在哪。
 *
 * 「单件利润」在两个站点上含义相同：同物品的最低卖价 vs 最高收价。
 * 区别在数据来源——商城卖的是服务端报价，SMCShop 收录的是玩家商店的挂单观测。
 */
(function attachSiteAdapters(global) {
  'use strict';

  const MALL = Object.freeze({
    id: 'mall',
    host: 'mall.vesego.xyz',
    title: '商城利润筛选器',
    tagline: '比较最低出售价与最高收购价，筛选正利润商品',
    dataSource: '商城公开报价接口',
    apiBase: 'https://mall.vesego.xyz/api/mall',
    catalog: Object.freeze({
      kind: 'paged',
      pageSize: 100,
      listField: 'items',
      totalField: 'total',
      path(offset, size) {
        const params = new URLSearchParams({
          includeTagged: 'false',
          limit: String(size),
          offset: String(offset)
        });
        return `/items?${params.toString()}`;
      }
    }),
    offers: Object.freeze({
      path(itemName, mode, offset, size) {
        const params = new URLSearchParams({
          includeTagged: 'false',
          limit: String(size),
          mode,
          offset: String(offset)
        });
        return `/items/${encodeURIComponent(itemName)}/offers?${params.toString()}`;
      }
    }),
    jump: Object.freeze({ kind: 'mall' }),
    features: Object.freeze({
      totalProfit: true,
      anomalyFilter: true,
      portBlacklist: true,
      vanillaFilter: true,
      manualCalculation: true
    }),
    labels: Object.freeze({
      minSell: '最低出售价',
      maxBuy: '最高收购价',
      sellAmount: '在售数量',
      minSellFilter: '最低在售数量',
      statusNote: '忽略路程与运输成本 · 自动隐藏标记商店',
      unitRule: '单件利润 = 最高收购价 − 最低出售价。只显示大于 0 的商品。',
      totalRule: '总利润会把最低出售报价与最高收购报价按数量匹配，忽略港口和运输成本。'
    })
  });

  const SMCSHOP = Object.freeze({
    id: 'smcshop',
    host: 'shop.whalemc.com',
    title: 'SMCShop 利润筛选器',
    tagline: '比较玩家商店的最低卖价与最高收价，筛选正利润物品',
    dataSource: 'SMCShop 收录的玩家商店挂单',
    // 同源，直接相对路径
    catalog: Object.freeze({
      kind: 'single',
      // item 留空时服务端会把全库聚合成 summaries 一次返回（8700+ 个物品，约 680KB），
      // 所以这里一个请求就能拿到完整排行，不需要逐个物品去查
      path: '/api/shops?item=&type=&limit=100',
      listField: 'summaries'
    }),
    // summaries 的形状是 { item, count, minSellPrice, maxBuyPrice }，
    // count 是「收录到多少家商店有这件物品的挂单」，拿来当在售规模的近似
    toItem(summary) {
      return {
        itemName: summary.item,
        minSellPrice: summary.minSellPrice,
        maxBuyPrice: summary.maxBuyPrice,
        sellAmount: summary.count,
        sellOfferCount: summary.count,
        buyOfferCount: 0,
        totalOfferCount: summary.count,
        updatedAt: null,
        vanillaId: null
      };
    },
    jump: Object.freeze({
      kind: 'smcshop',
      searchInput: '#item',
      searchForm: '#search-form',
      results: '#results',
      card: 'button.item-card',
      details: '#details'
    }),
    // 明细接口一次最多 200 条且是模糊匹配（查「圆石」会被「深板岩圆石」占满名额），
    // 所以依赖逐物品取明细的总利润 / 异常过滤 / 港口黑名单在这里都算不准，直接不提供。
    // 数据里也没有 vanillaId，版本筛选无从判断。
    features: Object.freeze({
      totalProfit: false,
      anomalyFilter: false,
      portBlacklist: false,
      vanillaFilter: false,
      manualCalculation: false
    }),
    labels: Object.freeze({
      minSell: '最低卖价',
      maxBuy: '最高收价',
      sellAmount: '商店数',
      minSellFilter: '最少商店数',
      statusNote: '数据由玩家客户端贡献，可能滞后',
      unitRule: '单件利润 = 最高收价 − 最低卖价。只显示大于 0 的物品。',
      totalRule: ''
    })
  });

  const ALL = Object.freeze([MALL, SMCSHOP]);

  function forLocation(location) {
    const host = String((location && location.hostname) || '').toLowerCase();
    for (const site of ALL) {
      if (site.host === host) return site;
    }
    return null;
  }

  global.MallProfitSites = Object.freeze({ all: ALL, mall: MALL, smcshop: SMCSHOP, forLocation });
})(globalThis);

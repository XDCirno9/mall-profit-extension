(function attachProfitCore(global) {
  'use strict';

  function toFiniteNumber(value) {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function toPositiveNumber(value) {
    const number = toFiniteNumber(value);
    return number !== null && number > 0 ? number : null;
  }

  // 「最高收价 ÷ 最低卖价」是否落在合理倍率内。limit <= 0 表示不设上限。
  // 这是给 SMCShop 这种「聚合极值」数据源用的判据：它的两个价格都是全站极值，
  // 而极值最容易被乱标的挂单占满（卖价 1 元的占位、收价 125000 的假收购），
  // 倍率是识别它们最干净的特征——真实行商物品都在 10 倍以内，噪声是几百到十几万倍。
  // 卖价缺失、非正或不是有限数时不判定：没有可比的基准，宁可放行也不要凭空误杀。
  function withinPriceRatio(maxBuyPrice, minSellPrice, limit) {
    const cap = toFiniteNumber(limit);
    if (!(cap > 0)) return true;
    const buy = toFiniteNumber(maxBuyPrice);
    const sell = toFiniteNumber(minSellPrice);
    if (buy === null || sell === null || !(sell > 0)) return true;
    return buy / sell <= cap;
  }

  // 从某个物品的挂单明细里算出「真的有货」的两个极值价。
  //
  // SMCShop 的挂单允许「标了价但库存为 0」，服务端聚合 summaries 时把这些空挂单一起算进去了，
  // 于是聚合出来的最低卖价常常是空挂单的价。实测：破碎王冠摘要 10000，而那条挂单 amount=0，
  // 真要有货最低得 80000——收价才 66666，实际是负利润；发酵桶更是所有卖单都无货。
  // 所以判据是「只在 amount > 0 的挂单里取极值」，两边都要看，缺任何一边就买不到或卖不掉。
  //
  // 两个必须交给调用方处理的边界：
  //   1. 服务端是 LIKE 模糊匹配（查「圆石」会带回「深板岩圆石」），必须按 item 精确相等筛；
  //   2. 一次最多返回 cap 条。截断时数组里可能整段缺一类挂单（实测查「圆石」200 条全是卖单），
  //      而且返回顺序并不保证按价格，所以截断时不能断定「没货」。
  function resolveInStockPrices(listings, itemName, options) {
    const rows = Array.isArray(listings) ? listings : [];
    const cap = toFiniteNumber(options && options.cap);
    const name = String(itemName ?? '');
    const result = {
      minSellPrice: null,
      maxBuyPrice: null,
      sellCount: 0,
      buyCount: 0,
      outOfStockCount: 0,
      missingAmount: 0,
      truncated: cap !== null && rows.length >= cap,
      unknownShape: false
    };
    let exactRows = 0;

    for (const row of rows) {
      if (!row || String(row.item ?? '') !== name) continue;
      const price = toPositiveNumber(row.price);
      if (price === null) continue;
      exactRows += 1;

      const amount = 'amount' in row ? toPositiveNumber(row.amount) : null;
      if (amount === null) {
        // 0 或负数是「标了价但没有货」；连字段都没有则是接口形状变了，两种要分开记
        if ('amount' in row) result.outOfStockCount += 1;
        else result.missingAmount += 1;
        continue;
      }

      const type = String(row.type || '').toUpperCase();
      if (type === 'SELL') {
        result.sellCount += 1;
        if (result.minSellPrice === null || price < result.minSellPrice) result.minSellPrice = price;
      } else if (type === 'BUY') {
        result.buyCount += 1;
        if (result.maxBuyPrice === null || price > result.maxBuyPrice) result.maxBuyPrice = price;
      }
    }

    // 有精确匹配的行、却一条都没有 amount 字段 ⇒ 读不到库存，不能把「读不到」当成「全都没货」
    result.unknownShape = result.missingAmount > 0 && result.missingAmount === exactRows;
    return result;
  }

  function normalizeItem(item) {
    if (!item || typeof item !== 'object') return null;
    const itemName = String(item.itemName || '').trim();
    if (!itemName) return null;
    return {
      itemName,
      minSellPrice: toFiniteNumber(item.minSellPrice),
      maxBuyPrice: toFiniteNumber(item.maxBuyPrice),
      sellAmount: toFiniteNumber(item.sellAmount) || 0,
      sellOfferCount: toFiniteNumber(item.sellOfferCount) || 0,
      buyOfferCount: toFiniteNumber(item.buyOfferCount) || 0,
      totalOfferCount: toFiniteNumber(item.totalOfferCount) || 0,
      updatedAt: item.updatedAt || null,
      vanillaId: item.vanillaId || null
    };
  }

  function buildUnitRows(items) {
    const rows = [];
    for (const source of Array.isArray(items) ? items : []) {
      const item = normalizeItem(source);
      if (!item) continue;
      const minSellPrice = toPositiveNumber(item.minSellPrice);
      const maxBuyPrice = toPositiveNumber(item.maxBuyPrice);
      if (minSellPrice === null || maxBuyPrice === null) continue;
      const unitProfit = maxBuyPrice - minSellPrice;
      if (!(unitProfit > 0)) continue;
      rows.push({
        ...item,
        minSellPrice,
        maxBuyPrice,
        unitProfit,
        profitRate: (unitProfit / minSellPrice) * 100,
        totalProfit: null,
        matchedQty: null
      });
    }
    return rows;
  }

  function normalizeOffers(offers) {
    if (!Array.isArray(offers)) return [];
    return offers
      .map((offer) => ({
        price: toPositiveNumber(offer && offer.price),
        amount: toPositiveNumber(offer && offer.amount),
        port: String((offer && (offer.region || (offer.nearestPort && offer.nearestPort.name))) || '').trim() || null
      }))
      .filter((offer) => offer.price !== null && offer.amount !== null);
  }

  function filterBlacklistedOffers(offers, blacklist) {
    const normalized = normalizeOffers(offers);
    const blocked = new Set(
      (Array.isArray(blacklist) ? blacklist : [])
        .map((port) => String(port || '').trim())
        .filter(Boolean)
    );
    if (!blocked.size) return { offers: normalized, blocked: [] };

    const kept = [];
    const excluded = [];
    for (const offer of normalized) {
      if (offer.port && blocked.has(offer.port)) excluded.push(offer);
      else kept.push(offer);
    }
    return { offers: kept, blocked: excluded };
  }

  function parsePortBlacklistText(text) {
    const source = String(text === undefined || text === null ? '' : text);
    let parsed = null;
    let isJson = false;

    try {
      parsed = JSON.parse(source);
      isJson = true;
    } catch {
      isJson = false;
    }

    let raw = null;
    if (isJson) {
      if (Array.isArray(parsed)) {
        raw = parsed;
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.ports)) {
        raw = parsed.ports;
      } else if (typeof parsed === 'string' || typeof parsed === 'number') {
        raw = source.split(/[\r\n,]+/);
      } else {
        return { ok: false, error: 'JSON 中缺少 ports 数组' };
      }
    } else {
      raw = source.split(/[\r\n,]+/);
    }

    const ports = [];
    const seen = new Set();
    for (const value of raw) {
      if (value && typeof value === 'object') continue;
      const name = String(value === undefined || value === null ? '' : value).trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      ports.push(name);
    }

    if (!ports.length) return { ok: false, error: '没有解析到任何港口名称' };
    return { ok: true, ports };
  }

  function median(values) {
    const sorted = values
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function filterOutlierOffers(offers, multiplier, mode) {
    const normalized = normalizeOffers(offers);
    const factor = toPositiveNumber(multiplier);
    if (!factor || factor <= 1 || normalized.length <= 1) {
      return { offers: normalized, outliers: [], medianPrice: normalized[0]?.price ?? null };
    }

    const prices = normalized.map((offer) => offer.price);
    const baseline = median(prices);
    if (!baseline) return { offers: normalized, outliers: [], medianPrice: null };

    if (normalized.length <= 4) {
      const sortedPrices = [...prices].sort((a, b) => a - b);
      let largestGapIndex = -1;
      let largestGapRatio = 1;
      for (let index = 0; index < sortedPrices.length - 1; index += 1) {
        const ratio = sortedPrices[index + 1] / sortedPrices[index];
        if (ratio > largestGapRatio) {
          largestGapRatio = ratio;
          largestGapIndex = index;
        }
      }

      if (largestGapIndex >= 0 && largestGapRatio >= factor) {
        const leftCount = largestGapIndex + 1;
        const rightCount = sortedPrices.length - leftCount;
        let removeSide = null;
        if (leftCount < rightCount) removeSide = 'left';
        else if (rightCount < leftCount) removeSide = 'right';
        else removeSide = mode === 'sell' ? 'left' : 'right';

        const boundary = removeSide === 'left'
          ? sortedPrices[largestGapIndex]
          : sortedPrices[largestGapIndex + 1];
        const kept = [];
        const outliers = [];
        for (const offer of normalized) {
          const shouldRemove = removeSide === 'left'
            ? offer.price <= boundary
            : offer.price >= boundary;
          if (shouldRemove) outliers.push(offer);
          else kept.push(offer);
        }
        if (kept.length) return { offers: kept, outliers, medianPrice: baseline };
      }
    }

    const lower = baseline / factor;
    const upper = baseline * factor;
    const kept = [];
    const outliers = [];

    for (const offer of normalized) {
      if (offer.price < lower || offer.price > upper) outliers.push(offer);
      else kept.push(offer);
    }

    if (!kept.length) {
      return { offers: normalized, outliers: [], medianPrice: baseline };
    }

    return { offers: kept, outliers, medianPrice: baseline };
  }

  function sumOfferAmounts(offers) {
    return offers.reduce((total, offer) => total + offer.amount, 0);
  }

  function buildOfferAnalysis(buyOffers, sellOffers, multiplier, portBlacklist) {
    const buyPortResult = filterBlacklistedOffers(buyOffers, portBlacklist);
    const sellPortResult = filterBlacklistedOffers(sellOffers, portBlacklist);
    const buyResult = filterOutlierOffers(buyPortResult.offers, multiplier, "buy");
    const sellResult = filterOutlierOffers(sellPortResult.offers, multiplier, "sell");
    const buyPrices = buyResult.offers.map((offer) => offer.price);
    const sellPrices = sellResult.offers.map((offer) => offer.price);
    const maxBuyPrice = buyPrices.length ? Math.max(...buyPrices) : null;
    const minSellPrice = sellPrices.length ? Math.min(...sellPrices) : null;
    const totalResult = calculateMatchedProfit(buyResult.offers, sellResult.offers);
    const unitProfit = maxBuyPrice !== null && minSellPrice !== null
      ? maxBuyPrice - minSellPrice
      : null;

    return {
      minSellPrice,
      maxBuyPrice,
      sellAmount: sumOfferAmounts(sellResult.offers),
      sellOfferCount: sellResult.offers.length,
      buyOfferCount: buyResult.offers.length,
      unitProfit,
      profitRate: unitProfit !== null && minSellPrice > 0 ? (unitProfit / minSellPrice) * 100 : null,
      totalProfit: totalResult.totalProfit,
      totalCost: totalResult.totalCost,
      totalRevenue: totalResult.totalRevenue,
      matchedQty: totalResult.matchedQty,
      outlierCount: buyResult.outliers.length + sellResult.outliers.length,
      buyOutlierCount: buyResult.outliers.length,
      sellOutlierCount: sellResult.outliers.length,
      blacklistedOfferCount: buyPortResult.blocked.length + sellPortResult.blocked.length,
      buyBlacklistedCount: buyPortResult.blocked.length,
      sellBlacklistedCount: sellPortResult.blocked.length,
      excluded: unitProfit === null || !(unitProfit > 0)
    };
  }
  function calculateMatchedProfit(buyOffers, sellOffers) {
    const demand = normalizeOffers(buyOffers)
      .map((offer) => ({ ...offer, remaining: offer.amount }))
      .sort((a, b) => b.price - a.price);
    const supply = normalizeOffers(sellOffers)
      .map((offer) => ({ ...offer, remaining: offer.amount }))
      .sort((a, b) => a.price - b.price);

    let demandIndex = 0;
    let supplyIndex = 0;
    let totalProfit = 0;
    let totalCost = 0;
    let totalRevenue = 0;
    let matchedQty = 0;

    while (demandIndex < demand.length && supplyIndex < supply.length) {
      const buy = demand[demandIndex];
      const sell = supply[supplyIndex];
      if (buy.price <= sell.price) break;

      const quantity = Math.min(buy.remaining, sell.remaining);
      if (quantity > 0) {
        const cost = quantity * sell.price;
        const revenue = quantity * buy.price;
        totalProfit += revenue - cost;
        totalCost += cost;
        totalRevenue += revenue;
        matchedQty += quantity;
        buy.remaining -= quantity;
        sell.remaining -= quantity;
      }

      if (buy.remaining <= 1e-9) demandIndex += 1;
      if (sell.remaining <= 1e-9) supplyIndex += 1;
    }

    return {
      totalProfit,
      totalCost,
      totalRevenue,
      matchedQty
    };
  }

  function withTotalProfit(row, totalResult) {
    if (!row || !totalResult || !Number.isFinite(totalResult.totalProfit)) return { ...row };
    return {
      ...row,
      totalProfit: totalResult.totalProfit,
      matchedQty: Number.isFinite(totalResult.matchedQty) ? totalResult.matchedQty : null,
      totalCost: Number.isFinite(totalResult.totalCost) ? totalResult.totalCost : null,
      totalRevenue: Number.isFinite(totalResult.totalRevenue) ? totalResult.totalRevenue : null
    };
  }

  function compareNullable(a, b, direction) {
    const aValid = Number.isFinite(a);
    const bValid = Number.isFinite(b);
    if (!aValid && !bValid) return 0;
    if (!aValid) return 1;
    if (!bValid) return -1;
    return direction === 'asc' ? a - b : b - a;
  }

  // 表头每一列都能点：字段类型决定比较方式，方向上由 `${field}-${direction}` 里的后缀决定，
  // 所以这里不再逐个枚举排序键，新增列只要往 SORT_FIELDS 里加一行。
  const SORT_FIELDS = Object.freeze({
    itemName: 'text',
    minSellPrice: 'number',
    maxBuyPrice: 'number',
    unitProfit: 'number',
    profitRate: 'number',
    sellAmount: 'number',
    totalProfit: 'number',
    matchedQty: 'number'
  });

  const DEFAULT_SORT_KEY = 'unitProfit-desc';

  function parseSortKey(sortKey) {
    const match = typeof sortKey === 'string' ? /^([A-Za-z]+)-(asc|desc)$/.exec(sortKey) : null;
    if (match && SORT_FIELDS[match[1]]) {
      return { field: match[1], direction: match[2], type: SORT_FIELDS[match[1]], valid: true };
    }
    const fallback = /^([A-Za-z]+)-(asc|desc)$/.exec(DEFAULT_SORT_KEY);
    return {
      field: fallback[1],
      direction: fallback[2],
      type: SORT_FIELDS[fallback[1]],
      valid: false
    };
  }

  function compareByField(a, b, field, direction) {
    if (SORT_FIELDS[field] === 'text') {
      const result = String(a[field] ?? '').localeCompare(String(b[field] ?? ''), 'zh-CN');
      return direction === 'asc' ? result : -result;
    }
    return compareNullable(a[field], b[field], direction);
  }

  function sortRows(rows, sortKey) {
    const result = Array.isArray(rows) ? [...rows] : [];
    const { field, direction } = parseSortKey(sortKey);
    // 同值时统一按商品名兜底，保证每次排序结果稳定
    return result.sort((a, b) => compareByField(a, b, field, direction)
      || String(a.itemName ?? '').localeCompare(String(b.itemName ?? ''), 'zh-CN'));
  }

  global.MallProfitCore = Object.freeze({
    normalizeItem,
    withinPriceRatio,
    resolveInStockPrices,
    buildUnitRows,
    median,
    parsePortBlacklistText,
    filterOutlierOffers,
    filterBlacklistedOffers,
    buildOfferAnalysis,
    calculateMatchedProfit,
    withTotalProfit,
    sortRows,
    sortFields: SORT_FIELDS,
    parseSortKey
  });
})(globalThis);

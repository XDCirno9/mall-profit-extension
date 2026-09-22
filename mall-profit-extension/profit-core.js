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

  function sortRows(rows, sortKey) {
    const result = Array.isArray(rows) ? [...rows] : [];
    const comparators = {
      'unitProfit-desc': (a, b) => compareNullable(a.unitProfit, b.unitProfit, 'desc'),
      'unitProfit-asc': (a, b) => compareNullable(a.unitProfit, b.unitProfit, 'asc'),
      'totalProfit-desc': (a, b) => compareNullable(a.totalProfit, b.totalProfit, 'desc'),
      'totalProfit-asc': (a, b) => compareNullable(a.totalProfit, b.totalProfit, 'asc'),
      'profitRate-desc': (a, b) => compareNullable(a.profitRate, b.profitRate, 'desc'),
      'minSellPrice-asc': (a, b) => compareNullable(a.minSellPrice, b.minSellPrice, 'asc'),
      'itemName-asc': (a, b) => a.itemName.localeCompare(b.itemName, 'zh-CN')
    };
    const comparator = comparators[sortKey] || comparators['unitProfit-desc'];
    return result.sort((a, b) => comparator(a, b) || a.itemName.localeCompare(b.itemName, 'zh-CN'));
  }

  global.MallProfitCore = Object.freeze({
    normalizeItem,
    buildUnitRows,
    median,
    filterOutlierOffers,
    filterBlacklistedOffers,
    buildOfferAnalysis,
    calculateMatchedProfit,
    withTotalProfit,
    sortRows
  });
})(globalThis);





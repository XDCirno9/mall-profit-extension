/*
 * SMCShop driver ("the same extension, a second shop").
 *
 * The jsdom harness proves the selection and jump logic against a fixture; this
 * one proves it against the real page, the real summary payload (currently
 * ~60000 items / ~6MB) and the real DOM, which is where a wrong selector or a
 * wrong relative URL would only show up:
 *   1. the panel opens with this site's own title and column names;
 *   2. the features this shop cannot support are hidden, not greyed out;
 *   3. the ranking is there as soon as the panel opens — no "calculate" step,
 *      because the server already aggregates min sell / max buy per item;
 *   4. the price-ratio cap drops the rows whose extremes are player junk
 *      (real site: 成书 sell 1 → buy 125000, 骨头 sell 1 → buy 99999). Toggling
 *      the cap off and on again shows exactly which rows it removes;
 *   5. the stock check that follows it is the expensive half: it queries the
 *      listing detail of every visible item, one request each, and keeps only
 *      the extremes that still have stock. This is where the site's real answer
 *      comes from — the summaries aggregate min-sell/max-buy over listings that
 *      may have amount 0, so an item can look hugely profitable while the cheap
 *      listing is an empty placeholder. Measured here, not just asserted;
 *   6. clicking an item name opens its shop detail *and* collapses the panel,
 *      since the detail is page content rather than an overlay;
 *   7. the item opened is the exact one clicked, not a fuzzy-match neighbour.
 *
 * The flow pauses at phase `measured` so the shell can take a screenshot:
 *   agent-browser eval 'window.__MPE_CONTINUE = true'
 */
(function () {
  var R = {};
  window.__R = R;
  R.phase = 'running';

  function itemButtons() {
    return Array.prototype.slice.call(document.querySelectorAll('#mpe-tbody .mpe-item-link'));
  }
  function names() {
    return itemButtons().map(function (node) { return node.getAttribute('data-mpe-item'); });
  }
  // 真实站点上实测到的「乱标价」样本：卖价 1 元的占位挂单配一个十几万的收价
  var NOISY = ['成书', '骨头'];
  function note(id) {
    var el = document.getElementById(id);
    return el ? (el.textContent || '').trim() : null;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function waitFor(fn, timeout, step) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      var iv = setInterval(function () {
        var v = null;
        try { v = fn(); } catch (e) { v = null; }
        if (v) { clearInterval(iv); resolve(v); return; }
        if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(null); }
      }, step || 100);
    });
  }
  function isHidden(selector) {
    var node = document.querySelector(selector);
    return Boolean(node) && node.classList.contains('mpe-hidden');
  }
  // 插件发出去的挂单核对请求都记在注入脚本的 fetch 日志里，用它数请求条数；
  // item= 留空的那次是全库 summaries，不算核对请求
  function stockRequests() {
    return (window.__mpeFetchLog || []).filter(function (url) {
      return url.indexOf('/api/shops?') !== -1 && url.indexOf('item=&') === -1;
    });
  }
  // 资源计时里能顺带拿到这一批请求占用的总时长
  function stockRequestMs() {
    return Math.round(performance.getEntriesByType('resource').reduce(function (sum, entry) {
      return entry.name.indexOf('item=&') === -1 && entry.name.indexOf('/api/shops?item=') !== -1
        ? sum + entry.duration
        : sum;
    }, 0));
  }
  function explainerNumber(pattern) {
    var matched = pattern.exec(note('mpe-explainer') || '');
    return matched ? Number(matched[1].replace(/,/g, '')) : 0;
  }
  function headerLabels() {
    return Array.prototype.slice.call(document.querySelectorAll('#mpe-thead th')).map(function (th) {
      return (th.textContent || '').replace(/[\u21c5\u25b2\u25bc]/g, '').trim();
    });
  }

  Promise.resolve().then(function () {
    // inject.js 只定义钩子，必须由驱动脚本显式启动
    R.boot = window.__mpeBoot ? window.__mpeBoot() : 'no-boot-hook';
    var launcher = document.getElementById('mpe-launcher');
    if (!launcher) { R.phase = 'no-launcher'; return null; }
    var openedAt = Date.now();
    R.openedAt = openedAt;
    launcher.click();
    // 真实的全库 summaries 有 6 万条、约 6MB，第一次要等一会儿
    return waitFor(function () { return itemButtons().length > 0; }, 90000, 300);
  }).then(function (loaded) {
    if (R.phase !== 'running') return null;
    if (!loaded) { R.phase = 'no-rows'; R.errorText = note('mpe-error'); return null; }

    R.title = (document.querySelector('.mpe-heading h2') || {}).textContent;
    R.headerLabels = headerLabels();
    R.explainer = note('mpe-explainer');
    R.rowCount = itemButtons().length;
    R.dataStatus = note('mpe-data-status');
    R.statusNote = note('mpe-status-note');
    R.hiddenControls = ['.mpe-segmented', '.mpe-anomaly-field', '.mpe-version-field',
      '.mpe-scope-field', '#mpe-port-manager', '#mpe-calculate'].filter(isHidden);
    R.collapsedRows = document.querySelectorAll('#mpe-thead th').length
      ? document.querySelectorAll('#mpe-tbody tr').length
      : 0;
    R.errorText = note('mpe-error');
    // 第一段（读 summaries）到这里就够了，这时表里是聚合值，还没核对过库存
    R.firstPaintMs = Date.now() - R.openedAt;
    R.rowsBeforeStockCheck = R.rowCount;

    // 第二段：挂单库存核对是自动跑的，一个物品一个请求。等它核完（条数不再变、进度条收起）
    // 再看榜，那才是用户最终看到的结果
    var previous = -1;
    return waitFor(function () {
      var checked = explainerNumber(/已按挂单库存核对 ([\d,]+) 个物品/);
      var stable = checked > 0 && checked === previous;
      previous = checked;
      var progressHidden = document.getElementById('mpe-progress').hidden;
      return stable && progressHidden ? checked : null;
    }, 300000, 500).then(function (checked) {
      R.stockChecked = checked;
      R.stockDone = checked !== null;
      R.stockMs = Date.now() - R.openedAt;
      R.stockRequests = stockRequests().length;
      R.stockRequestMs = stockRequestMs();
      R.stockHidden = explainerNumber(/隐藏 ([\d,]+) 个缺货或价差为负的/);
      R.stockUncertain = explainerNumber(/另有 ([\d,]+) 个物品挂单超过 200 条/);
      R.explainer = note('mpe-explainer');
      R.rowCountAfterStock = itemButtons().length;
      R.statusNoteAfterStock = note('mpe-status-note');
      R.errorText = note('mpe-error');
      R.topRows = Array.prototype.slice.call(document.querySelectorAll('#mpe-tbody tr'))
        .slice(0, 6)
        .map(function (row) {
          return Array.prototype.slice.call(row.querySelectorAll('td')).map(function (cell) {
            return (cell.textContent || '').trim();
          }).join(' | ');
        });
    });
  }).then(function () {
    if (R.phase !== 'running') return null;

    // 价格倍率上限：默认 10 倍，判据全部来自已经加载完的 summaries 快照。
    // 关掉它再数一遍，两边一减就知道它到底拦了什么
    var ratioSelect = document.getElementById('mpe-price-ratio-filter');
    R.ratioSelectPresent = Boolean(ratioSelect);
    R.ratioSelectValue = ratioSelect ? ratioSelect.value : null;
    R.ratioHiddenCount = (function () {
      var m = /(\d+(?:,\d+)*)\s*个/.exec(note('mpe-explainer') || '');
      return m ? m[1] : null;
    })();

    var withRatio = names();
    var withoutRatio = withRatio.slice();
    if (ratioSelect) {
      ratioSelect.value = '0';
      ratioSelect.dispatchEvent(new Event('change', { bubbles: true }));
      withoutRatio = names();
      ratioSelect.value = '10';
      ratioSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    R.rowsWithRatio = withRatio.length;
    R.rowsWithoutRatio = withoutRatio.length;
    R.removedByRatio = withoutRatio.filter(function (name) {
      return withRatio.indexOf(name) === -1;
    }).slice(0, 8);
    R.noisyGoneWithRatio = NOISY.filter(function (name) { return withRatio.indexOf(name) === -1; });
    R.noisyBackWithoutRatio = NOISY.filter(function (name) { return withoutRatio.indexOf(name) !== -1; });
    R.rowsAfterRestore = names().length;

    var first = itemButtons()[0];
    var target = first.getAttribute('data-mpe-item');
    R.jumpTarget = target;
    R.jumpTargetIsTop = true;
    first.click();

    return waitFor(function () {
      var details = document.getElementById('details');
      return details && !details.hidden;
    }, 30000, 200).then(function (opened) {
      R.detailOpened = Boolean(opened);
      // 详情是页面正文，插件在确认详情真的打开之后才收起面板——这里要等它收完再看，
      // 否则读到的是「正在定位…」那一刻的状态，看起来像面板没收
      return waitFor(function () {
        return document.getElementById('mpe-panel').dataset.open === 'false';
      }, 20000, 200).then(function (collapsed) {
        R.panelCollapsedAfterJump = Boolean(collapsed);
      });
    }).then(function () {
      var details = document.getElementById('details');
      var heading = details ? details.querySelector('h2') : null;
      R.detailHeading = heading ? heading.textContent.trim() : null;
      R.shopSearchInput = document.getElementById('item') ? document.getElementById('item').value : null;
      R.panelOpenAfterJump = document.getElementById('mpe-panel').dataset.open === 'true';
      R.statusNoteAfterJump = note('mpe-status-note');
      R.errorTextAfterJump = note('mpe-error');
      R.phase = 'measured';
    });
  }).then(function () {
    if (R.phase !== 'measured') return null;
    return waitFor(function () { return window.__MPE_CONTINUE; }, 120000, 200);
  }).then(function () {
    if (R.phase === 'measured') R.phase = 'done';
  }).catch(function (error) {
    R.phase = 'error';
    R.errorText = String((error && error.message) || error);
  });
})();

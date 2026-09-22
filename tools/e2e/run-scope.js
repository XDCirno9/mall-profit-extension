/*
 * Scope driver ("only calculate the first N rows of the current filter").
 *
 * The jsdom harness proves the selection logic against a fixture; this one
 * proves the same contract against the real mall page with the real UI
 * controls, which is where a wrong event (`input` instead of `change` on the
 * number box, say) would silently do nothing:
 *   1. the scope controls exist and the limit box is disabled while the scope
 *      is "all";
 *   2. switching to "current filter" makes the limit box usable and the
 *      calculate button names the row count for this run;
 *   3. clicking calculate touches exactly N items' offers endpoints — not the
 *      whole positive-profit set;
 *   4. the status line says which scope is in effect;
 *   5. going back to "all" restores the full row count on the button.
 *
 * The flow pauses at phase `measured` so the shell can take a screenshot:
 *   agent-browser eval 'window.__MPE_CONTINUE = true'
 */
(function () {
  var R = {};
  window.__R = R;
  R.phase = 'running';

  var SCOPE_LIMIT = 3;

  function itemButtons() {
    return Array.prototype.slice.call(document.querySelectorAll('#mpe-tbody .mpe-item-link'));
  }
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
  // 下拉和数字框都靠 change 事件生效；受控 input 必须走原生 value setter
  function setControl(el, value) {
    var proto = el.tagName === 'SELECT'
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
    var d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 数一数这次计算到底碰了哪些商品的报价接口。只统计商品名，不数请求条数——
  // 报价接口会翻页，条数随夹具变化，商品名才是「算了几条」的契约。
  var offersSeen = {};
  R.offersSeen = offersSeen;
  (function hookFetch() {
    var previous = window.fetch;
    window.fetch = function (input, init) {
      var url = String(input && input.url ? input.url : input);
      var matched = /\/items\/([^/]+)\/offers/.exec(url);
      if (matched) {
        var name = decodeURIComponent(matched[1]);
        offersSeen[name] = (offersSeen[name] || 0) + 1;
      }
      return previous.call(this, input, init);
    };
  })();

  Promise.resolve().then(function () {
    // inject.js 只定义钩子，必须由驱动脚本显式启动，否则页面里根本没有插件 UI
    R.boot = window.__mpeBoot ? window.__mpeBoot() : 'no-boot-hook';
    var launcher = document.getElementById('mpe-launcher');
    if (!launcher) { R.phase = 'no-launcher'; return null; }
    launcher.click();
    var scope = document.getElementById('mpe-calc-scope');
    var limit = document.getElementById('mpe-scope-limit');
    R.scopeOptions = scope ? Array.prototype.map.call(scope.options, function (option) { return option.value; }) : null;
    R.defaultScope = scope ? scope.value : null;
    R.limitDisabledAtAll = limit ? limit.disabled : null;
    R.limitMaxAttribute = limit ? limit.getAttribute('max') : null;
    R.limitPlaceholder = limit ? limit.getAttribute('placeholder') : null;

    // 先关掉异常过滤拿到完整行数：这样不用计算就有数据行，也才知道「全部商品」是多少条
    setControl(document.getElementById('mpe-anomaly-filter'), '0');
    return waitFor(function () { return itemButtons().length > 0; }, 60000, 200);
  }).then(function (loaded) {
    if (R.phase !== 'running') return null;
    if (!loaded) { R.phase = 'no-rows'; R.errorText = note('mpe-error'); return null; }

    R.totalRows = itemButtons().length;
    R.buttonAtAllScope = note('mpe-calculate');

    // 收窄范围：只算当前筛选结果的前 3 条
    setControl(document.getElementById('mpe-calc-scope'), 'filtered');
    setControl(document.getElementById('mpe-scope-limit'), String(SCOPE_LIMIT));
    R.limitDisabledAtFiltered = document.getElementById('mpe-scope-limit').disabled;

    // 打开异常过滤：这样「开始计算」才真的会去拉报价，正好用来数它碰了几个商品
    setControl(document.getElementById('mpe-anomaly-filter'), '10');
    R.buttonScoped = note('mpe-calculate');
    return waitFor(function () { return itemButtons().length === 0; }, 10000, 100);
  }).then(function () {
    if (R.phase !== 'running') return null;
    var before = Object.keys(offersSeen).length;
    document.getElementById('mpe-calculate').click();
    return waitFor(function () {
      return itemButtons().length > 0 && Object.keys(offersSeen).length > before;
    }, 60000, 200).then(function () {
      // 再等一小会儿，确认没有第二批请求跟着补上来（补上来就说明范围没生效）
      return sleep(1200);
    });
  }).then(function () {
    if (R.phase !== 'running') return null;
    R.touchedItemCount = Object.keys(offersSeen).length;
    R.touchedNames = Object.keys(offersSeen);
    R.rowsAfterScopedRun = itemButtons().length;
    R.statusNote = note('mpe-status-note');
    R.statCount = note('mpe-stat-count');
    R.buttonAfterScopedRun = note('mpe-calculate');
    R.errorText = note('mpe-error');

    // 切回「全部商品」：范围限制解除，按钮重新标出全量条数
    setControl(document.getElementById('mpe-calc-scope'), 'all');
    R.buttonBackToAll = note('mpe-calculate');
    R.limitDisabledBackToAll = document.getElementById('mpe-scope-limit').disabled;
    R.phase = 'measured';
  }).then(function () {
    if (R.phase !== 'measured') return null;
    return waitFor(function () { return window.__MPE_CONTINUE; }, 120000, 200);
  }).then(function () {
    if (R.phase === 'measured') R.phase = 'done';
  }).catch(function (error) {
    R.phase = 'error';
    R.errorText = String(error && error.message || error);
  });
})();

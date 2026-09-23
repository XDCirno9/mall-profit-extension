/*
 * SMCShop driver ("the same extension, a second shop").
 *
 * The jsdom harness proves the selection and jump logic against a fixture; this
 * one proves it against the real page, the real 8700-item summary payload and
 * the real DOM, which is where a wrong selector or a wrong relative URL would
 * only show up:
 *   1. the panel opens with this site's own title and column names;
 *   2. the features this shop cannot support are hidden, not greyed out;
 *   3. the ranking is there as soon as the panel opens — no "calculate" step,
 *      because the server already aggregates min sell / max buy per item;
 *   4. clicking an item name opens its shop detail *and* collapses the panel,
 *      since the detail is page content rather than an overlay;
 *   5. the item opened is the exact one clicked, not a fuzzy-match neighbour.
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
    launcher.click();
    // 真实的全库 summaries 有 8700 多条、约 680KB，第一次要等一会儿
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

    var first = itemButtons()[0];
    var target = first.getAttribute('data-mpe-item');
    R.jumpTarget = target;
    R.jumpTargetIsTop = true;
    first.click();

    return waitFor(function () {
      var details = document.getElementById('details');
      return details && !details.hidden;
    }, 30000, 200).then(function (opened) {
      var details = document.getElementById('details');
      var heading = details ? details.querySelector('h2') : null;
      R.detailOpened = Boolean(opened);
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

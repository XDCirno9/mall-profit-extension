/*
 * Port-manager driver. Store progress on window.__R and poll window.__R.phase.
 *
 *   agent-browser eval "$(cat tools/e2e/run-ports.js)"
 *
 * Covers the three regressions that were fixed in v1.6.0:
 *   1. toggling a checkbox must not rebuild the list and reset scrollTop;
 *   2. an unusable import file must report a reason and keep the draft;
 *   3. a usable JSON import must replace the draft.
 */
(function () {
  var R = {};
  window.__R = R;
  R.phase = 'running';

  var ERR_PREFIX = '\u5bfc\u5165\u5931\u8d25';

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function note(id) {
    var el = document.getElementById(id);
    return el ? (el.textContent || '').trim() : null;
  }
  function waitFor(fn, timeout, step) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      var iv = setInterval(function () {
        var v = null;
        try { v = fn(); } catch (e) { v = null; }
        if (v) { clearInterval(iv); resolve(v); return; }
        if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(null); }
      }, step || 150);
    });
  }
  function list() { return document.getElementById('mpe-port-list'); }
  function boxes() {
    var l = list();
    return l ? Array.prototype.slice.call(l.querySelectorAll('input[data-port]')) : [];
  }
  function checkedCount() {
    return boxes().filter(function (b) { return b.checked; }).length;
  }
  function importFile(name, content) {
    var input = document.getElementById('mpe-port-import');
    var dt = new DataTransfer();
    dt.items.add(new File([content], name, { type: 'application/json' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  Promise.resolve().then(function () {
    R.boot = window.__mpeBoot();
    document.getElementById('mpe-launcher').click();
    return waitFor(function () {
      var tb = document.getElementById('mpe-tbody');
      return tb && tb.children.length > 0;
    }, 40000, 200);
  }).then(function (ok) {
    R.panelRowsLoaded = !!ok;
    document.getElementById('mpe-port-manager').click();
    return waitFor(function () {
      return (note('mpe-port-status') || '').indexOf('\u5171') !== -1;
    }, 25000, 200);
  }).then(function (loaded) {
    R.portsLoaded = !!loaded;
    R.modalHidden = document.getElementById('mpe-port-modal').hidden;
    R.boxCount = boxes().length;
    if (!R.boxCount) { R.phase = 'no-ports'; return null; }

    var l = list();
    R.listScrollHeight = l.scrollHeight;
    R.listClientHeight = l.clientHeight;
    l.scrollTop = 240;
    R.scrollBefore = l.scrollTop;

    var box = boxes()[Math.min(30, R.boxCount - 1)];
    R.targetPort = box.getAttribute('data-port');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return sleep(350).then(function () {
      R.selectedCountAfterCheck = note('mpe-port-selected-count');
      R.scrollAfterCheck = list().scrollTop;
      R.checkedAfterCheck = checkedCount();
      R.baseline = R.checkedAfterCheck;
    });
  }).then(function () {
    if (R.phase !== 'running') return null;
    importFile('bad-object.json', '{"foo":1,"bar":[1,2]}');
    return sleep(1200);
  }).then(function () {
    if (R.phase !== 'running') return null;
    var s = note('mpe-port-status') || '';
    R.badObjectIsError = s.indexOf(ERR_PREFIX) !== -1;
    R.badObjectStatus = s;
    R.badObjectKeptSelection = checkedCount() === R.baseline;
    importFile('bad-array.json', '[{"a":1},{"b":2}]');
    return sleep(1200);
  }).then(function () {
    if (R.phase !== 'running') return null;
    var s = note('mpe-port-status') || '';
    R.badArrayIsError = s.indexOf(ERR_PREFIX) !== -1;
    R.badArrayStatus = s;
    R.badArrayKeptSelection = checkedCount() === R.baseline;
    importFile('good.json', '{"format":"mall-profit-port-blacklist","version":1,"ports":["Alpha","Beta"]}');
    return sleep(1200);
  }).then(function () {
    if (R.phase !== 'running') return null;
    R.goodStatus = note('mpe-port-status');
    R.goodChecked = checkedCount();
    R.phase = 'done';
    return null;
  }).catch(function (e) {
    R.phase = 'error';
    R.err = String((e && e.message) || e);
  });

  return 'kicked';
})()

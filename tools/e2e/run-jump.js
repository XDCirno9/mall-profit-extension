/*
 * Item-jump driver. Store progress on window.__R and poll window.__R.phase
 * from the shell; a single eval call cannot observe an async jump.
 *
 * Set the mode first:
 *   agent-browser eval 'window.__MPE_MODE="fast"; "ok"'
 *   agent-browser eval 'window.__MPE_MODE="search"; "ok"'
 * then:
 *   agent-browser eval "$(cat tools/e2e/run-jump.js)"
 *
 * Modes:
 *   fast   - target is already rendered in the mall list, so the search box
 *            must never be touched.
 *   search - target is not in the first page, so the mall's own search has to
 *            run first.
 */
(function () {
  var MODE = window.__MPE_MODE === 'search' ? 'search' : 'fast';
  var R = {};
  window.__R = R;
  R.mode = MODE;
  R.phase = 'running';

  var SHIPIN = '\u7269\u54c1\u540d';

  function itemButtons() {
    return Array.prototype.slice.call(document.querySelectorAll('#mpe-tbody .mpe-item-link'));
  }
  function extNames() {
    return itemButtons().map(function (b) { return b.getAttribute('data-mpe-item'); });
  }
  function mallTable() {
    var tables = document.querySelectorAll('table');
    for (var i = 0; i < tables.length; i += 1) {
      if (tables[i].closest('#mpe-root')) continue;
      var head = tables[i].querySelector('thead');
      if (head && head.textContent.indexOf(SHIPIN) !== -1) return tables[i];
    }
    return null;
  }
  function mallRowNames() {
    var t = mallTable();
    if (!t) return [];
    var out = [];
    var rows = t.querySelectorAll('tbody tr');
    for (var i = 0; i < rows.length; i += 1) {
      var first = rows[i].firstElementChild;
      out.push(first ? (first.innerText || '').split('\n')[0].trim() : '');
    }
    return out;
  }
  // Every leaf text present in the mall's rendered rows. Mirrors the
  // extension's own matching so '\u77f3\u5934' cannot stand in for '\u5706\u77f3'.
  function mallLeafTextSet() {
    var t = mallTable();
    var set = [];
    if (!t) return set;
    var rows = t.querySelectorAll('tbody tr');
    for (var i = 0; i < rows.length; i += 1) {
      var all = [rows[i]].concat(Array.prototype.slice.call(rows[i].querySelectorAll('*')));
      for (var j = 0; j < all.length; j += 1) {
        if (all[j].children.length) continue;
        var tx = (all[j].textContent || '').trim();
        if (tx && set.indexOf(tx) === -1) set.push(tx);
      }
    }
    return set;
  }
  function mallSearchBox() {
    var inputs = document.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i += 1) {
      if (inputs[i].closest('#mpe-root')) continue;
      if ((inputs[i].getAttribute('placeholder') || '').indexOf('\u7269\u54c1') !== -1) return inputs[i];
    }
    return null;
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
  function setNative(input, value) {
    var d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (d && d.set) d.set.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function setSelect(el, value) {
    var d = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
    if (d && d.set) d.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  Promise.resolve().then(function () {
    R.boot = window.__mpeBoot();
    var launcher = document.getElementById('mpe-launcher');
    R.launcherFound = !!launcher;
    if (!launcher) { R.phase = 'no-launcher'; return null; }
    launcher.click();
    // Must happen before the table renders: the default 10x anomaly filter
    // hides every row, which makes the panel look empty and the driver stall.
    var af = document.getElementById('mpe-anomaly-filter');
    if (af) setSelect(af, '0');
    R.fetchLogBeforeJump = window.__mpeFetchLog.slice();
    return waitFor(function () { return extNames().length > 0; }, 40000, 200);
  }).then(function (loaded) {
    R.panelRowsLoaded = !!loaded;
    if (!loaded) {
      R.dataStatus = note('mpe-data-status');
      R.errorText = note('mpe-error');
      R.fetchLog = window.__mpeFetchLog.slice();
      R.phase = 'no-rows';
      return null;
    }
    return sleep(500);
  }).then(function () {
    if (R.phase !== 'running') return null;
    var ext = extNames();
    var visible = mallLeafTextSet();
    R.extCount = ext.length;
    R.extSample = ext.slice(0, 8);
    R.mallVisibleRowNames = mallRowNames();
    R.mallVisibleCount = R.mallVisibleRowNames.length;

    var want = null;
    for (var i = 0; i < ext.length; i += 1) {
      var inList = visible.indexOf(ext[i]) !== -1;
      if (MODE === 'fast' && inList) { want = ext[i]; break; }
      if (MODE === 'search' && !inList) { want = ext[i]; break; }
    }
    R.target = want;
    if (!want) { R.phase = 'no-target'; return null; }

    var btn = null;
    var btns = itemButtons();
    for (var j = 0; j < btns.length; j += 1) {
      if (btns[j].getAttribute('data-mpe-item') === want) { btn = btns[j]; break; }
    }
    R.buttonFound = !!btn;
    if (!btn) { R.phase = 'no-button'; return null; }

    R.targetInMallListBefore = visible.indexOf(want) !== -1;
    R.searchBoxValueBeforeJump = mallSearchBox() ? mallSearchBox().value : null;
    R.fetchLogAtClick = window.__mpeFetchLog.slice();

    btn.click();

    // Panel close and row click happen back to back, so sample fast.
    var highlightSeen = false;
    var hl = setInterval(function () {
      if (document.querySelectorAll('.mpe-jump-target').length > 0) highlightSeen = true;
    }, 25);

    return waitFor(function () {
      var p = document.getElementById('mpe-panel');
      return p && p.dataset.open === 'false';
    }, 25000, 50).then(function (closed) {
      R.panelClosed = !!closed;
      R.highlightSeenDuringJump = highlightSeen;
      clearInterval(hl);
      return sleep(1600);
    });
  }).then(function () {
    if (R.phase !== 'running') return null;
    R.highlightSeenAfter = document.querySelectorAll('.mpe-jump-target').length > 0;
    R.panelOpenAfter = document.getElementById('mpe-panel').dataset.open;
    R.errorText = note('mpe-error');
    R.statusNote = note('mpe-status-note');
    R.mallRowCountAfter = mallRowNames().length;
    R.mallTableExistsAfter = !!mallTable();
    R.searchBoxAfter = mallSearchBox() ? mallSearchBox().value : null;
    R.newFetches = window.__mpeFetchLog.slice(R.fetchLogAtClick.length);
    R.offersRequests = R.newFetches.filter(function (u) { return u.indexOf('/offers') !== -1; });
    R.searchRequests = R.newFetches.filter(function (u) { return u.indexOf('q=') !== -1; });
    R.url = location.href;
    R.phase = 'done';
    return null;
  }).catch(function (e) {
    R.phase = 'error';
    R.err = String((e && e.message) || e);
  });

  return 'kicked';
})()

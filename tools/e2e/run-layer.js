/*
 * Layered-driver ("detail on top of the panel").
 *
 * Proves the contract behind "open an item without losing the panel":
 *   1. the jump no longer closes the panel and no longer narrows it;
 *   2. the mall's own detail modal is painted ABOVE the panel, so the detail
 *      is fully usable and the panel waits underneath;
 *   3. no leftovers of the old side-by-side mode (data-dock / html.mpe-dock /
 *      the "展开面板" button / the footer toggle);
 *   4. Escape goes to the mall dialog first, and only closes the panel when
 *      there is no mall dialog left.
 *
 * The flow pauses at phase `stacked` so the shell can take a screenshot:
 *   agent-browser eval 'window.__MPE_CONTINUE = true'
 */
(function () {
  var R = {};
  window.__R = R;
  R.phase = 'running';

  var WUPIN = '\u7269\u54c1\u540d';

  function panel() {
    return document.getElementById('mpe-panel');
  }
  function mallDialog() {
    return document.querySelector('body > [data-slot="dialog-content"], body > [role="dialog"]:not([id^="mpe-"])');
  }
  function mallOverlay() {
    return document.querySelector('body > [data-slot="dialog-overlay"]');
  }
  function dialogAlive() {
    var dlg = mallDialog();
    return !!dlg && dlg.getAttribute('data-state') !== 'closed';
  }
  function describe(el) {
    if (!el) return null;
    var name = el.tagName ? el.tagName.toLowerCase() : String(el);
    if (el.id) name += '#' + el.id;
    if (typeof el.className === 'string' && el.className.trim()) {
      name += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    }
    return name;
  }
  function rect(el) {
    var r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  }
  function zIndexOf(el) {
    if (!el) return null;
    var value = window.getComputedStyle(el).zIndex;
    return value === 'auto' ? 'auto' : Number(value);
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
  function setSelect(el, value) {
    var d = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
    if (d && d.set) d.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function itemButtons() {
    return Array.prototype.slice.call(document.querySelectorAll('#mpe-tbody .mpe-item-link'));
  }
  function buttonFor(name) {
    var buttons = itemButtons();
    for (var i = 0; i < buttons.length; i += 1) {
      if (buttons[i].getAttribute('data-mpe-item') === name) return buttons[i];
    }
    return null;
  }
  function mallTable() {
    var tables = document.querySelectorAll('table');
    for (var i = 0; i < tables.length; i += 1) {
      if (tables[i].closest('#mpe-root')) continue;
      var head = tables[i].querySelector('thead');
      if (head && head.textContent.indexOf(WUPIN) !== -1) return tables[i];
    }
    return null;
  }
  function leafTextSet() {
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
  function pressEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
    }));
  }
  function measureLayer() {
    var p = panel();
    var pr = p.getBoundingClientRect();
    var dlg = mallDialog();
    var ov = mallOverlay();

    R.panelOpen = p.dataset.open;
    R.panelRect = rect(p);
    R.panelZ = zIndexOf(p);
    R.viewport = [window.innerWidth, window.innerHeight];
    R.dockAttr = p.dataset.dock === undefined ? null : p.dataset.dock;
    R.htmlDock = document.documentElement.classList.contains('mpe-dock');
    R.undockButton = !!document.getElementById('mpe-undock');
    R.footerToggle = !!document.getElementById('mpe-keep-panel');
    R.backdropHidden = document.getElementById('mpe-backdrop').hidden;
    R.scrollLocked = document.documentElement.classList.contains('mpe-panel-open');

    if (!dlg) { R.dialogFound = false; return; }
    var dr = dlg.getBoundingClientRect();
    R.dialogFound = true;
    R.dialogRect = rect(dlg);
    R.dialogState = dlg.getAttribute('data-state');
    R.dialogZ = zIndexOf(dlg);
    R.overlayZ = zIndexOf(ov);
    R.dialogHead = (dlg.innerText || '').split('\n').slice(0, 2).join(' | ');
    R.overlapWidth = Math.max(0, Math.min(pr.right, dr.right) - Math.max(pr.left, dr.left));
    R.overlapHeight = Math.max(0, Math.min(pr.bottom, dr.bottom) - Math.max(pr.top, dr.top));

    // 最硬的证据：在面板正中心取一个点，看浏览器真正命中的是谁
    var x = Math.round(pr.left + pr.width / 2);
    var y = Math.round(pr.top + pr.height / 2);
    var top = document.elementFromPoint(x, y);
    R.probePoint = [x, y];
    R.topElement = describe(top);
    R.topIsOwnUi = !!(top && top.closest && top.closest('#mpe-root'));
    R.topIsMallDialog = !!(dlg && top && (top === dlg || dlg.contains(top)));
    R.topIsMallOverlay = !!(ov && top && (top === ov || ov.contains(top)));
  }

  Promise.resolve().then(function () {
    R.boot = window.__mpeBoot();
    var launcher = document.getElementById('mpe-launcher');
    if (!launcher) { R.phase = 'no-launcher'; return null; }
    launcher.click();
    var af = document.getElementById('mpe-anomaly-filter');
    if (af) setSelect(af, '0');
    return waitFor(function () { return itemButtons().length > 0; }, 40000, 200);
  }).then(function (loaded) {
    if (R.phase !== 'running') return null;
    if (!loaded) { R.phase = 'no-rows'; R.errorText = note('mpe-error'); return null; }
    var visible = leafTextSet();
    var buttons = itemButtons();
    R.target = null;
    for (var i = 0; i < buttons.length; i += 1) {
      var name = buttons[i].getAttribute('data-mpe-item');
      if (visible.indexOf(name) !== -1) { R.target = name; break; }
    }
    if (!R.target) { R.phase = 'no-target'; return null; }
    R.searchBoxBeforeJump = mallSearchBox() ? mallSearchBox().value : null;
    buttonFor(R.target).click();
    return waitFor(function () { return dialogAlive(); }, 25000, 50);
  }).then(function (opened) {
    if (R.phase !== 'running') return null;
    R.dialogOpened = !!opened;
    if (!opened) { R.phase = 'no-dialog'; R.errorText = note('mpe-error'); return null; }
    return sleep(900);
  }).then(function () {
    if (R.phase !== 'running') return null;
    measureLayer();
    R.statusNote = note('mpe-status-note');
    R.errorText = note('mpe-error');
    R.searchBoxAfterJump = mallSearchBox() ? mallSearchBox().value : null;
    R.phase = 'stacked';
    return waitFor(function () { return window.__MPE_CONTINUE === true; }, 120000, 100);
  }).then(function (go) {
    if (!go) { R.phase = 'error'; R.err = '等待外壳继续超时'; return null; }
    window.__MPE_CONTINUE = false;
    R.phase = 'running2';
    pressEscape();
    return sleep(900);
  }).then(function () {
    if (R.phase !== 'running2') return null;
    R.esc1PanelOpen = panel().dataset.open;
    R.esc1DialogAlive = dialogAlive();
    R.esc1BackdropHidden = document.getElementById('mpe-backdrop').hidden;
    R.esc1ScrollLocked = document.documentElement.classList.contains('mpe-panel-open');
    pressEscape();
    return sleep(400);
  }).then(function () {
    if (R.phase !== 'running2') return null;
    R.esc2PanelOpen = panel().dataset.open;
    R.esc2BackdropHidden = document.getElementById('mpe-backdrop').hidden;
    R.esc2ScrollLocked = document.documentElement.classList.contains('mpe-panel-open');
    R.phase = 'done';
    return null;
  }).catch(function (e) {
    R.phase = 'error';
    R.err = String((e && e.message) || e);
  });

  return 'kicked';
})()

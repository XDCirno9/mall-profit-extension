/*
 * Render-efficiency driver ("typing must not rebuild the table per keystroke").
 *
 * Proves against the real mall DOM, the real dataset and real timers that:
 *   1. a burst of search keystrokes causes ZERO table rebuilds — the input is
 *      debounced instead of re-sorting the whole list per character;
 *   2. exactly one rebuild happens after the burst settles, ~220ms after the
 *      last keystroke, and the filter result is correct;
 *   3. a single keystroke likewise rebuilds once, and the rebuild waits for the
 *      debounce window before it runs;
 *   4. the summary stat stays consistent with the table after a rebuild, which
 *      means summary and table share one visible-rows pass;
 *   5. no failure-retry button shows up on a healthy run.
 *
 * This is the only place that can measure the debounce honestly: jsdom cannot
 * tell you how expensive a rebuild of the real ~thousands-row table is, and the
 * rebuild is counted by observing `#mpe-tbody` instead of trusting a clock.
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
  function setSelect(el, value) {
    var d = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
    if (d && d.set) d.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  // 搜索框是受控 input，必须走原生 setter 再派发冒泡的 input 事件
  function setInput(el, value) {
    var d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (d && d.set) d.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // inject.js 为了让别的驱动不用等 82 页，会把 /items 的响应改写成 total = items.length(100)。
  // 那会让这里的行数只有真实值的百分之一，量出来的耗时完全没有参考价值，
  // 所以先换回 inject.js 保存下来的那份未被改写的 fetch 再启动。
  // （别用 about:blank iframe 去取原生 fetch：它的 contentWindow 跟父页面共用同一套内建，
  //   拿到的还是被改写过的那个函数。）
  function installNativeFetch() {
    if (!window.__mpeOriginalFetch) return 'no-original-fetch-exposed';
    if (typeof window.__mpeFetchLog === 'undefined') return 'harness-fetch-absent';
    window.fetch = window.__mpeOriginalFetch;
    return 'original-fetch-restored';
  }

  Promise.resolve().then(function () {
    R.fetchMode = installNativeFetch();
    // 先确认复原成功：探针拿到的 total 必须是真实的商品总数，而不是被改写的 100
    return window.fetch('/api/mall/items?includeTagged=false&limit=100&offset=0')
      .then(function (response) { return response.json(); })
      .then(function (data) {
        R.probeTotal = data.total;
        R.probeItems = (data.items || []).length;
      }, function (error) {
        R.probeError = String((error && error.message) || error);
      });
  }).then(function () {
    // inject.js 只定义钩子，必须由驱动脚本显式启动，否则页面里根本没有插件 UI
    R.boot = window.__mpeBoot ? window.__mpeBoot() : 'no-boot-hook';
    var launcher = document.getElementById('mpe-launcher');
    if (!launcher) { R.phase = 'no-launcher'; return null; }
    launcher.click();
    // 关掉异常过滤：这样不用手动计算就有数据行，而且行数最多、重排最贵
    var af = document.getElementById('mpe-anomaly-filter');
    if (af) setSelect(af, '0');
    return waitFor(function () { return itemButtons().length > 0; }, 60000, 200);
  }).then(function (loaded) {
    if (R.phase !== 'running') return null;
    if (!loaded) { R.phase = 'no-rows'; R.errorText = note('mpe-error'); return null; }

    R.rowCount = itemButtons().length;
    // 「已读取 N 个商品」= 商城商品总数；表格行数 = 其中正利润的那部分，两者别混
    R.dataStatus = note('mpe-data-status');
    R.retryHidden = document.getElementById('mpe-retry').hidden;
    R.statusNote = note('mpe-status-note');

    // 数 tbody 被整体重建了几次：renderTable 每次都重写 tbody.innerHTML
    var tbody = document.getElementById('mpe-tbody');
    var rebuilds = 0;
    var lastRebuildAt = 0;
    var observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        if (records[i].type === 'childList') {
          rebuilds += 1;
          lastRebuildAt = performance.now();
        }
      }
    });
    observer.observe(tbody, { childList: true });

    // 逐字输入某个真实商品名的前缀，每一档都是合法筛选条件，按键间隔小于防抖窗口
    var firstName = itemButtons()[0].getAttribute('data-mpe-item') || '';
    var progressive = firstName.slice(0, Math.max(2, Math.min(4, firstName.length)));
    var steps = [];
    for (var i = 1; i <= progressive.length; i += 1) steps.push(progressive.slice(0, i));
    R.typed = steps.join(' → ');

    var search = document.getElementById('mpe-search');
    var lastKeystrokeAt = 0;
    return (function type(index) {
      if (index >= steps.length) return Promise.resolve();
      setInput(search, steps[index]);
      lastKeystrokeAt = performance.now();
      return sleep(60).then(function () { return type(index + 1); });
    })(0).then(function () {
      R.rebuildsWhileTyping = rebuilds;
      return sleep(600);
    }).then(function () {
      R.rebuildsAfterSettle = rebuilds;
      R.settleDelayMs = lastRebuildAt ? Math.round(lastRebuildAt - lastKeystrokeAt) : null;
      R.filteredRows = itemButtons().length;
      R.filteredNames = itemButtons().slice(0, 5).map(function (button) {
        return button.getAttribute('data-mpe-item');
      });

      // 清掉搜索回到完整数据集，量一次单次按键的防抖延迟
      setInput(search, '');
      return sleep(600);
    }).then(function () {
      R.rowsAfterClear = itemButtons().length;

      var beforeSingle = rebuilds;
      var keystrokeAt = performance.now();
      setInput(search, progressive);
      return sleep(600).then(function () {
        R.singleKeystrokeRebuilds = rebuilds - beforeSingle;
        R.singleKeystrokeRebuildsTotal = rebuilds;
        R.singleKeystrokeDelayMs = lastRebuildAt ? Math.round(lastRebuildAt - keystrokeAt) : null;
      });
    }).then(function () {
      // 把搜索清掉回到完整数据集，再量「一次完整重排」的耗时——带着筛选量出来的数字没有意义
      setInput(search, '');
      return sleep(600);
    }).then(function () {
      // 一次渲染的同步耗时：renderTable 会重写 tbody.innerHTML，所以点表头就是一次全量重排
      var header = document.querySelector('#mpe-thead .mpe-th-button');
      var before = rebuilds;
      var t0 = performance.now();
      if (header) header.click();
      R.headerRenderMs = Math.round((performance.now() - t0) * 100) / 100;
      R.headerClickRebuilds = rebuilds - before;
      R.rowsAtMeasure = itemButtons().length;
      R.msPerRow = R.rowsAtMeasure
        ? Math.round((R.headerRenderMs / R.rowsAtMeasure) * 10000) / 10000
        : null;
      // 摘要的「筛选结果」必须和表格行数一致：说明摘要和表格共用同一份可见行
      R.statCount = note('mpe-stat-count');
      R.rowCountAfterSort = itemButtons().length;
      observer.disconnect();
      R.errorText = note('mpe-error');
      R.phase = 'measured';
    });
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

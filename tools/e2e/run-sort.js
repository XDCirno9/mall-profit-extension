/*
 * Header-sort driver ("the table header is the sort control").
 *
 * Proves against the real mall DOM and the real stylesheet that:
 *   1. every column except `#` renders a clickable header button, and the old
 *      toolbar <select> is gone;
 *   2. a numeric column sorts descending on the first click and reverses on the
 *      second, with the arrow + aria-sort tracking the active column;
 *   3. the item-name column starts ascending;
 *   4. the header cell is really hit-testable (elementFromPoint returns the
 *      button inside it) and is not collapsed by the padding change;
 *   5. clicking a header fires no /offers request.
 *
 * The flow pauses at phase `sorted` so the shell can take a screenshot:
 *   agent-browser eval 'window.__MPE_CONTINUE = true'
 */
(function () {
  var R = {};
  window.__R = R;
  R.phase = 'running';

  // 单件利润模式的列下标：0 # / 1 商品 / 2 最低出售价 / 3 最高收购价 / 4 单件利润 / 5 利润率 / 6 在售数量
  var SELL_AMOUNT_COLUMN = 6;

  function panel() {
    return document.getElementById('mpe-panel');
  }
  function headers() {
    return Array.prototype.slice.call(document.querySelectorAll('#mpe-thead .mpe-th-button'));
  }
  function headerLabels() {
    return headers().map(function (button) {
      var label = button.querySelector('.mpe-th-label');
      return label ? (label.textContent || '').trim() : '';
    });
  }
  function allHeaderLabels() {
    return Array.prototype.slice.call(document.querySelectorAll('#mpe-thead th')).map(function (cell) {
      return (cell.textContent || '').trim();
    });
  }
  function headerByLabel(label) {
    var list = headers();
    for (var i = 0; i < list.length; i += 1) {
      var node = list[i].querySelector('.mpe-th-label');
      if (node && (node.textContent || '').trim() === label) return list[i];
    }
    return null;
  }
  function activeHeader() {
    var cell = document.querySelector('#mpe-thead th[data-active="true"]');
    if (!cell) return null;
    var label = cell.querySelector('.mpe-th-label');
    var arrow = cell.querySelector('.mpe-th-arrow');
    return {
      label: label ? (label.textContent || '').trim() : '',
      arrow: arrow ? (arrow.textContent || '').trim() : '',
      ariaSort: cell.getAttribute('aria-sort')
    };
  }
  function itemButtons() {
    return Array.prototype.slice.call(document.querySelectorAll('#mpe-tbody .mpe-item-link'));
  }
  function rowNames(limit) {
    var list = itemButtons();
    var out = [];
    for (var i = 0; i < Math.min(list.length, limit || 6); i += 1) {
      out.push(list[i].getAttribute('data-mpe-item'));
    }
    return out;
  }
  // 读出按当前顺序排列的某一列数值，用来判断真的排好了而不是看着像
  function columnNumbers(index, limit) {
    var rows = document.querySelectorAll('#mpe-tbody tr');
    var out = [];
    for (var i = 0; i < Math.min(rows.length, limit || 6); i += 1) {
      var cell = rows[i].children[index];
      if (!cell) continue;
      var digits = (cell.textContent || '').replace(/[^0-9.]/g, '');
      out.push(digits === '' ? null : Number(digits));
    }
    return out;
  }
  function isMonotonic(values, direction) {
    for (var i = 1; i < values.length; i += 1) {
      if (values[i] === null || values[i - 1] === null) return false;
      if (direction === 'asc' ? values[i] < values[i - 1] : values[i] > values[i - 1]) return false;
    }
    return true;
  }
  function offersSeen() {
    var entries = performance.getEntriesByType('resource');
    var count = 0;
    for (var i = 0; i < entries.length; i += 1) {
      if (entries[i].name.indexOf('/offers') !== -1) count += 1;
    }
    return count;
  }
  function rect(el) {
    var r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  }
  function describe(el) {
    if (!el) return null;
    var name = el.tagName ? el.tagName.toLowerCase() : String(el);
    if (typeof el.className === 'string' && el.className.trim()) {
      name += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    }
    return name;
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
  // 搜索框是受控 input，必须用原生 setter 再派发冒泡的 input 事件
  function setInput(el, value) {
    var d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (d && d.set) d.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function snapshot() {
    return {
      active: activeHeader(),
      rows: rowNames(6),
      sellAmounts: columnNumbers(SELL_AMOUNT_COLUMN, 6)
    };
  }

  Promise.resolve().then(function () {
    // inject.js 只定义钩子，必须由驱动脚本显式启动（否则页面里根本没有插件 UI）
    R.boot = window.__mpeBoot ? window.__mpeBoot() : 'no-boot-hook';
    var launcher = document.getElementById('mpe-launcher');
    if (!launcher) { R.phase = 'no-launcher'; return null; }
    launcher.click();
    // 关掉异常过滤，这样表格不用等手动计算就有数据行
    var af = document.getElementById('mpe-anomaly-filter');
    if (af) setSelect(af, '0');
    return waitFor(function () { return itemButtons().length > 0; }, 60000, 200);
  }).then(function (loaded) {
    if (R.phase !== 'running') return null;
    if (!loaded) { R.phase = 'no-rows'; R.errorText = note('mpe-error'); return null; }

    R.rowsTotal = itemButtons().length;
    // 行数很多时整表重排太慢，先用搜索把行数压到可观测的规模；行数本来就不多就不筛选，
    // 样本越大越能说明排序方向（排序的契约本身不受行数影响）
    var search = document.getElementById('mpe-search');
    if (search && R.rowsTotal > 120) {
      var keyword = (itemButtons()[0].getAttribute('data-mpe-item') || '').slice(0, 1);
      R.filterKeyword = keyword;
      if (keyword) setInput(search, keyword);
      return sleep(900);
    }
    return null;
  }).then(function () {
    if (R.phase !== 'running') return null;
    R.rowsFiltered = itemButtons().length;

    R.headerLabels = headerLabels();
    R.sortableHeaders = headers().length;
    R.allColumns = allHeaderLabels().length;
    R.oldSortSelect = !!document.getElementById('mpe-sort');
    R.oldSortField = !!document.querySelector('.mpe-sort-field');
    R.offersBefore = offersSeen();
    R.initial = snapshot();

    // 表头格真的能点：在当前排序列的格中心取点，看浏览器命中谁
    var target = headerByLabel('\u5728\u552e\u6570\u91cf');
    var probeCell = document.querySelector('#mpe-thead th[data-active="true"]');
    if (probeCell) {
      R.activeHeaderRect = rect(probeCell);
      var r = probeCell.getBoundingClientRect();
      var hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      R.headerHit = describe(hit);
      R.headerHitIsButton = !!(hit && hit.closest
        && hit.closest('.mpe-th-button') === probeCell.querySelector('.mpe-th-button'));
    }
    R.rowHeight = (function () {
      var row = document.querySelector('#mpe-tbody tr');
      return row ? Math.round(row.getBoundingClientRect().height) : null;
    })();

    if (!target) { R.phase = 'no-target-header'; return null; }
    target.click();
    return sleep(700);
  }).then(function () {
    if (R.phase !== 'running') return null;
    R.afterFirstClick = snapshot();
    R.firstClickDescending = isMonotonic(R.afterFirstClick.sellAmounts, 'desc');

    // 同一列再点一次 → 应该反转成升序
    var again = headerByLabel('\u5728\u552e\u6570\u91cf');
    if (!again) { R.phase = 'no-target-header'; return null; }
    again.click();
    return sleep(700);
  }).then(function () {
    if (R.phase !== 'running') return null;
    R.afterSecondClick = snapshot();
    R.secondClickAscending = isMonotonic(R.afterSecondClick.sellAmounts, 'asc');

    // 商品列第一次点应该是名称升序
    var nameHeader = headerByLabel('\u5546\u54c1');
    if (!nameHeader) { R.phase = 'no-target-header'; return null; }
    nameHeader.click();
    return sleep(700);
  }).then(function () {
    if (R.phase !== 'running') return null;
    R.afterNameClick = snapshot();
    R.offersAfter = offersSeen();
    R.offersDelta = R.offersAfter - R.offersBefore;
    R.statusNote = note('mpe-status-note');
    R.errorText = note('mpe-error');

    // 总利润模式：列变多，默认排序跟着切
    var totalSegment = document.querySelector('.mpe-segment[data-mode="total"]');
    if (!totalSegment) { R.phase = 'no-mode-segment'; return null; }
    totalSegment.click();
    return sleep(500);
  }).then(function () {
    if (R.phase !== 'running') return null;
    R.totalModeLabels = allHeaderLabels();
    R.totalModeSortable = headers().length;
    R.totalModeActive = activeHeader();

    var unitSegment = document.querySelector('.mpe-segment[data-mode="unit"]');
    if (unitSegment) unitSegment.click();
    return sleep(500);
  }).then(function () {
    if (R.phase !== 'running') return null;
    // 回到单件模式后默认排序应回落到单件利润
    R.unitModeActive = activeHeader();
    R.phase = 'sorted';
    return waitFor(function () { return window.__MPE_CONTINUE === true; }, 120000, 100);
  }).then(function (go) {
    if (!go) { R.phase = 'error'; R.err = '等待外壳继续超时'; return null; }
    window.__MPE_CONTINUE = false;
    R.panelOpen = panel().dataset.open;
    R.phase = 'done';
    return null;
  }).catch(function (e) {
    R.phase = 'error';
    R.err = String((e && e.message) || e);
  });

  return 'kicked';
})()

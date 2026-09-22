# Browser verification harness

Optional helpers for verifying DOM-facing behavior of the extension against the
live mall. Nothing here ships in `mall-profit-extension.zip`, and nothing here
is required to load the extension.

There are two layers:

- `jsdom-harness.js` — headless, fast, no browser. Fakes the mall page and asserts
  the jump contract. Run this on every change.
- `run-*.js` + `inject.js` — real Chromium against the live mall. Slower, but it is
  the only way to prove the jump against the real React build, the real table
  rebuild, and the real search API.

The mall serves the same SPA shell on every path, so `https://mall.vesego.xyz/` and
`https://mall.vesego.xyz/mall` are both the mall home page. Verify against both.

## 1. Headless (jsdom)

```bash
npm i -D jsdom          # once; jsdom is intentionally not a project dependency
node tools/e2e/jsdom-harness.js
```

Prints `PASS`/`FAIL` per assertion and `n/80 通过` at the end. Covers:

- fast path: row already rendered, search box untouched, panel stays open on top of
  the mall detail, and the mall dialog is still a `body`-level child;
- search path: search box written, row found, name kept in the box;
- layering: the mall dialog's `z-index` is higher than the panel's, the panel is still
  higher than the extension's own backdrop/launcher, and the elevation rule only
  targets `body >` children;
- cleanup: no leftovers of the old side-by-side mode (`data-dock`, `html.mpe-dock`,
  the enlarge button, the footer checkbox) in `content.js` or `content.css`;
- narrow window: the panel stays open even below 900px;
- header sort: every column except `#` is clickable, the arrow and `aria-sort` track
  the active column, a numeric column sorts descending on first click and reverses on
  the second, the item-name column starts ascending, the old toolbar `<select>` is
  gone, switching modes re-seeds the sort when the column disappears, and clicking a
  header neither fetches `/offers` nor touches the calculate button;
- Escape: while a mall dialog is open the panel survives; once it is gone, Escape
  closes the panel;
- exact matching: `圆石` does not select `石头` or `黄铁矿`;
- regression: the jump works from the root path `/` too, not just `/mall`;
- failure paths: item absent, table present but search box missing, page with no
  mall UI at all — panel stays open, search box restored, reason shown;
- non-conflict: no `/offers` request, no market refetch, calculate button untouched;
- regression: the default `10x` filter still does not auto-calculate;
- render efficiency: a burst of input events causes no re-sort at all and exactly one
  after it settles, and one render sorts exactly once. The probe is
  `MallProfitCore.sortRows`, wrapped by the harness before `content.js` captures the
  namespace — `getVisibleRows()` is the only caller, so the call count *is* the number
  of visible-rows passes per render. It must be `1`, not `2`/`3`. Also asserts the
  search box keeps a trailing space and that filtering still trims;
- stale cache: aging the persisted analysis entries by 10 minutes and reopening the
  page must still show the rows, add a `有效期` notice to the status line, switch the
  calculate button to `重新计算`, and issue **no** `/offers` request on its own;
- failed-item retry: one item's `/offers` is made to throw; the retry button must
  appear with a count of `1`, the failing item must be absent from the table, and
  clicking retry must touch **only** that item (asserted on the item names in the
  retried requests, not on a request count, because `fetchAllOffers` pages).
- calculation scope: with a 12-item fixture whose unit-profit order is deliberately
  the *reverse* of its name order, scoping to `filtered` with a limit of `5` must
  request offers for `矿石12…矿石08` and **not** for `矿石01…矿石05` — that mismatch is
  what makes the assertion able to tell "picked by unit profit" apart from "picked by
  name". Also covers the fallback when the sort column has no values yet (total-profit
  mode), the button label carrying the row count, the limit box being disabled outside
  `filtered`, the scope shrinking to 3 rows when a search narrows the filter below the
  limit, and the two error paths (`0` and `> max`) rolling back explicitly.

If `jsdom` cannot be resolved, the script exits with code 2 and a hint. You can
also point `NODE_PATH` at any `node_modules` that contains it.

## 2. Real browser (agent-browser)

Needs `agent-browser` (a Playwright-core wrapper) on `PATH`.

### 2.1 Build the injection script

```bash
python tools/e2e/gen-inject.py
```

This inlines the real `content.css`, `profit-core.js` and `content.js` into
`tools/e2e/inject.js` (gitignored — regenerate after every source change). The
script is registered with `--init-script`, so it runs before the mall bundle and
only defines helpers:

- `window.__mpeBoot()` — injects the styles and evaluates the extension sources,
  with `chrome.storage.local` backed by an in-memory object so nothing persists;
- `window.__mpeFetchLog` — every request the page or the extension made;
- `window.__mpeOriginalFetch` — the untouched `fetch`, kept reachable so a driver can
  opt out of the `/items` rewrite (see `run-perf.js`). The rewrite replaces the
  response body with `{ total: items.length, items }` so drivers never wait on 82
  pages, which also means every driver except `run-perf.js` sees a 100-item mall.
  `run-scope.js` keeps the rewrite on purpose — it needs the scoped and unscoped runs
  to differ visibly, not a realistic dataset size.

The extension is injected this way rather than loaded as a real extension
because `--extension` makes `agent-browser` navigate the target tab to
`about:blank`.

### 2.2 Run the jump driver

```bash
agent-browser open https://mall.vesego.xyz/mall --init-script tools/e2e/inject.js
agent-browser wait 8000

# fast path: pick an item that is already in the mall's first page
agent-browser eval 'window.__MPE_MODE="fast"; "ok"'
agent-browser eval "$(cat tools/e2e/run-jump.js)"

# ...poll window.__R.phase until it is "done", then:
agent-browser eval 'JSON.stringify(window.__R)'

# search path: pick an item that is NOT in the mall's first page
agent-browser close --all
agent-browser open https://mall.vesego.xyz/mall --init-script tools/e2e/inject.js
agent-browser wait 8000
agent-browser eval 'window.__MPE_MODE="search"; "ok"'
agent-browser eval "$(cat tools/e2e/run-jump.js)"
```

`run-jump.js` returns `'kicked'` immediately and stores progress on `window.__R`.
Poll `window.__R.phase` until it leaves `"running"`, then read the whole object.

The result object answers, for the chosen target:

| Field | Meaning |
| --- | --- |
| `target`, `targetInMallListBefore` | what the driver picked, and why |
| `panelSettled` / `dockAttrAfter` | the panel stayed open and was not narrowed |
| `overlapWidth` / `mallDialogFound` | the mall detail opened as a `body`-level modal |
| `errorText` | must be empty |
| `statusNote` | the user-visible confirmation |
| `newFetches` / `offersRequests` | an `/offers` request proves the mall detail opened |
| `searchRequests` | empty on the fast path; one `q=` request on the search path |
| `searchBoxAfter` | `""` on the fast path; the item name on the search path |
| `highlightSeenDuringJump` / `highlightSeenAfter` | `.mpe-jump-target` was applied |

### 2.3 Run the layering driver

```bash
agent-browser open https://mall.vesego.xyz/mall --init-script tools/e2e/inject.js
agent-browser set viewport 1600 900
agent-browser wait 9000
agent-browser eval "$(cat tools/e2e/run-layer.js)"

# the driver pauses at phase "stacked" so you can look at the page:
agent-browser screenshot ./stacked.png
agent-browser eval 'window.__MPE_CONTINUE = true; "go"'

# ...poll until phase "done", then:
agent-browser eval 'JSON.stringify(window.__R)'
```

`run-layer.js` is the only place that can prove the stacking order, because it needs
a real layout engine. The decisive field is `topAtPanelCenter` / `topIsOwnUi`: it
calls `document.elementFromPoint()` at the centre of the panel, so if the mall detail
really paints above the panel, the hit must land on the mall dialog or its overlay —
`topIsOwnUi` must be `false`, `topIsMallDialog` or `topIsMallOverlay` must be `true`.
Also check `panelZ < dialogZ`, `dockAttr === null`, `undockButton === false`,
`footerToggle === false`, and the `esc*` fields: `esc1PanelOpen` must stay `"true"`
while the mall dialog is open, and `esc2PanelOpen` must become `"false"` once it is
gone.

### 2.4 Run the port-manager driver

```bash
agent-browser open https://mall.vesego.xyz/mall --init-script tools/e2e/inject.js
agent-browser wait 8000
agent-browser eval "$(cat tools/e2e/run-ports.js)"
# poll window.__R.phase, then:
agent-browser eval 'JSON.stringify(window.__R)'
```

Asserts that toggling a checkbox keeps `scrollTop` and does not rebuild the list,
that `{"foo":1}` and `[{"a":1}]` both report `导入失败：…` while keeping the
current selection, and that a well-formed export imports cleanly.

### 2.5 Run the header-sort driver

```bash
agent-browser open https://mall.vesego.xyz/mall --init-script tools/e2e/inject.js
agent-browser set viewport 1600 900
agent-browser wait 9000
agent-browser eval "$(cat tools/e2e/run-sort.js)"

# the driver pauses at phase "sorted" for a screenshot:
agent-browser screenshot ./header-sort.png
agent-browser eval 'window.__MPE_CONTINUE = true; "go"'
# ...poll until phase "done", then:
agent-browser eval 'JSON.stringify(window.__R)'
```

`run-sort.js` proves that the table header is now the sort control:

| Field | Must be |
| --- | --- |
| `sortableHeaders` / `allColumns` | `6` / `7` — only `#` is not clickable |
| `oldSortSelect` / `oldSortField` | `false` — the toolbar `<select>` is gone |
| `initial.active` | `单件利润` with arrow `▼` and `aria-sort="descending"` |
| `firstClickDescending` | `true` — a numeric column sorts high→low on the first click |
| `secondClickAscending` | `true` — clicking the same column again reverses it |
| `afterNameClick.active.label` | `商品`, arrow `▲` — text starts ascending |
| `headerHitIsButton` / `headerHit` | `true` / `button.mpe-th-button.is-active` — hit-test proves the header cell is really clickable |
| `activeHeaderRect[3]` / `rowHeight` | `38` / `46` — the padding change did not collapse the header or rows |
| `offersDelta` | `0` — sorting never triggers a fetch |
| `unitModeActive` | the sort falls back to `单件利润` after the column disappears |

`columnNumbers()` reads the rendered cells, so `firstClickDescending` /
`secondClickAscending` verify the actual order rather than just the arrow. With
more than 120 rows the driver narrows the table through the search box first,
purely to keep the re-render fast.

### 2.6 Run the render-efficiency driver

```bash
agent-browser open https://mall.vesego.xyz/mall --init-script tools/e2e/inject.js
agent-browser set viewport 1600 900
agent-browser wait 9000
agent-browser eval "$(cat tools/e2e/run-perf.js)"

# the driver pauses at phase "measured" for a screenshot:
agent-browser screenshot ./perf.png
agent-browser eval 'window.__MPE_CONTINUE = true; "go"'
# ...poll until phase "done", then:
agent-browser eval 'JSON.stringify(window.__R)'
```

This is the only place where the debounce can be measured honestly, because it needs
real timers and the real dataset. It counts `#mpe-tbody` rebuilds with a
`MutationObserver` instead of trusting a clock, types a real item-name prefix one
character every 60ms, and reads:

| Field | Must be |
| --- | --- |
| `fetchMode` / `probeTotal` | `original-fetch-restored` / `8230` — the driver must first undo the harness's `/items` rewrite, otherwise every number below is measured against a 100-item mall |
| `rebuildsWhileTyping` | `0` — no rebuild happens during the burst |
| `rebuildsAfterSettle` | `1` — exactly one, after it settles |
| `settleDelayMs` | ~`222` — the wait matches the 220ms debounce window |
| `singleKeystrokeRebuilds` / `singleKeystrokeDelayMs` | `1` / ~`222` |
| `headerRenderMs` / `msPerRow` | cost of one full render and per rendered row |
| `statCount` vs `rowCountAfterSort` | must match — summary and table share one visible-rows pass |
| `retryHidden` / `errorText` | `true` / `""` |

Note that `rebuildsAfterHeaderClick`-style counts read synchronously right after a
click are always `0`: `MutationObserver` callbacks are microtasks, so the count only
catches up after a tick. `headerRenderMs` is still valid because `render()` is
synchronous.

### 2.7 Run the calculation-scope driver

```bash
agent-browser open https://mall.vesego.xyz/mall --init-script tools/e2e/inject.js
agent-browser set viewport 1600 900
agent-browser wait 9000
agent-browser eval "$(cat tools/e2e/run-scope.js)"

# the driver pauses at phase "measured" for a screenshot:
agent-browser screenshot ./scope-panel.png
agent-browser eval 'window.__MPE_CONTINUE = true; "go"'
# ...poll until phase "measured", then:
agent-browser eval 'JSON.stringify(window.__R)'
```

`run-scope.js` wraps `window.fetch` to record *which item names* were asked for
`/offers` — item names, not a request count, because the endpoint pages. It switches
the anomaly filter off to learn the full row count, points the scope at `filtered`
with a limit of `3`, switches the filter back on and clicks calculate:

| Field | Observed |
| --- | --- |
| `scopeOptions` / `defaultScope` | `["all","filtered"]` / `all` |
| `limitDisabledAtAll` / `limitDisabledAtFiltered` | `true` / `false` |
| `limitMaxAttribute` / `limitPlaceholder` | `3000` / `100` — injected from `CONFIG`, not duplicated in the HTML |
| `totalRows` | `38` — positive-profit rows out of the 100-item fixture |
| `buttonScoped` | `开始计算（3 条）` |
| `touchedItemCount` / `touchedNames` | `3` / the three names the scope picked |
| `rowsAfterScopedRun` / `statCount` | `3` / `3` |
| `statusNote` | starts with `计算范围：当前筛选结果的前 3 条` |
| `buttonBackToAll` | `重新计算（38 条）` |

Unlike `run-perf.js`, this driver deliberately keeps the harness's `/items` rewrite: it
is not measuring cost, it only needs a dataset where "scoped to 3" and "scoped to all"
differ visibly, and 100 items (38 rows) is plenty.

## Gotchas that cost time

- **`inject.js` only defines hooks — it does not inject anything by itself.** Every
  driver must call `window.__mpeBoot()` as its first step (it returns `'booted'`,
  `'already'`, `'failed'` or `'no-boot-hook'`). Skip it and the page simply has no
  `#mpe-root`, which looks like "the panel never opened" rather than an error.
- **Never pipe `agent-browser` output into another command inside a chained driver
  run.** `agent-browser open ... | tail -3` kills the whole script: empty stdout, exit
  code 1, `SIGTERM`, no error text — indistinguishable from "the page never loaded".
  Redirect to `/dev/null` or a file instead. Also separate the steps with `;` rather
  than `&&`, because `agent-browser eval` exits 1 whenever the expression evaluates to
  a falsy value (an IIFE driver returns `undefined`), which would abort an `&&` chain.
- **The scope-limit box listens on `change`, not `input`.** Typing a value without
  blurring never commits it, and a driver that dispatches only `input` will silently
  measure the default limit of 100 instead of the value it thought it set.
- **The mall's item detail is a body-level modal.** Clicking a row inserts
  `body > div[role="dialog"][data-slot="dialog-content"][data-state="open"]`
  (radix, `w-[calc(100%-2rem)]` centered with `left-1/2 -translate-x-1/2`) plus a
  full-screen `[data-slot="dialog-overlay"]`, and sets `body{overflow:hidden}`.
  It covers ~the whole viewport while the extension panel sits at `z-index`
  `2147482100`, so left alone the panel hides the detail completely. The fix is to
  elevate exactly this pair to `2147483000` — do not narrow the panel, and do not
  touch the modal's `left`/`width`, which is what the old side-by-side mode did.
  Match it by `data-slot`, not by radix's generated `#radix-_r_N_` id, and keep the
  selector limited to `body >` children so the extension's own overlays (inside
  `#mpe-root`) are unaffected.
- **Never gate the jump on `location.pathname`.** The mall serves the same SPA shell
  on `/`, `/mall`, `/mall/` and even unknown paths, so any path check rejects real
  users. Detect the mall by its DOM — the item table whose `thead` contains `物品名`,
  or the search input — and poll briefly before declaring failure.
- **One shell command per scenario.** The `agent-browser` daemon dies when the
  shell that started it exits, so the page is gone by the next tool call. Chain
  `open`, the driver eval and the polling loop in a single command.
- **`window` state does survive between CLI invocations**, as long as the daemon
  and the page are still alive.
- **Do not wait on a `MutationObserver` bound to the mall table.** Searching makes
  the mall unmount and rebuild the whole table, killing the observer. Poll instead.
- **Set `#mpe-anomaly-filter` to `0` before waiting for rows.** The default `10x`
  filter hides every row and the panel looks empty.
- **Pass Chinese script text as `\uXXXX` escapes** when going through a shell, to
  sidestep Windows encoding issues.
- **`agent-browser eval` fails on a falsy result** (exit code 1). Return a string
  such as `'ok'` from setup evals.
- **`inject.js` rewrites the `/items` response to a single page.** It returns
  `{ total: items.length, items }`, so the extension reads 100 items instead of the
  real 8230 and the table holds 38 rows instead of 430. That is deliberate (no driver
  wants to wait on 82 pages) but it silently invalidates any measurement of cost, and
  it cost real time chasing a phantom "the extension only reads 100 items" bug. Use
  `window.__mpeOriginalFetch` when the catalogue size matters.
- **An `about:blank` iframe does not give you a clean realm.** `iframe.contentWindow.fetch`
  returns the *parent's* patched `fetch` — the same intrinsics — so "get a native fetch
  from an iframe" silently does nothing. Expose the original from the injection script
  instead.
- **Reading a count right after an action misses `MutationObserver` updates.** The
  observer callback runs as a microtask, so `rebuilds` is still the old value on the
  next line. `await` a tick before asserting.
- **Check what the harness fakes before blaming the extension.** Two separate "bugs"
  in this session (100 items instead of 8230, and a request count of 4 instead of 2)
  were both the harness, not the extension: the `/items` rewrite, and a paginating
  `fetchAllOffers` against a fixture that reports `total: 2` but returns one offer.

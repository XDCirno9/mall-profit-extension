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

Prints `PASS`/`FAIL` per assertion and `n/39 通过` at the end. Covers:

- fast path: row already rendered, search box untouched, panel stays open on top of
  the mall detail, and the mall dialog is still a `body`-level child;
- search path: search box written, row found, name kept in the box;
- layering: the mall dialog's `z-index` is higher than the panel's, the panel is still
  higher than the extension's own backdrop/launcher, and the elevation rule only
  targets `body >` children;
- cleanup: no leftovers of the old side-by-side mode (`data-dock`, `html.mpe-dock`,
  the enlarge button, the footer checkbox) in `content.js` or `content.css`;
- narrow window: the panel stays open even below 900px;
- Escape: while a mall dialog is open the panel survives; once it is gone, Escape
  closes the panel;
- exact matching: `圆石` does not select `石头` or `黄铁矿`;
- regression: the jump works from the root path `/` too, not just `/mall`;
- failure paths: item absent, table present but search box missing, page with no
  mall UI at all — panel stays open, search box restored, reason shown;
- non-conflict: no `/offers` request, no market refetch, calculate button untouched;
- regression: the default `10x` filter still does not auto-calculate.

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
- `window.__mpeFetchLog` — every request the page or the extension made.

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

## Gotchas that cost time

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

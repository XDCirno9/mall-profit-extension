# Project Instructions

## Goal

Maintain the Chrome Manifest V3 extension in `mall-profit-extension/`. The UI is Chinese and targets `https://mall.vesego.xyz/`.

Current version: `1.6.0`.

## Required Behavior

- Do not start expensive offer calculations automatically.
- Opening the panel may load the market item list, but only the "开始计算" / "重新计算" button may start offer analysis.
- Clicking the calculate button performs a forced recalculation for the active mode and filter settings.
- Reopening the panel must display fresh cached results without recalculating.
- Preserve manual behavior when changing profit mode, anomaly filter, vanilla filter, or port blacklist.
- The extension must remain Chrome Manifest V3 compatible and work as an unpacked extension.
- Keep all user-facing UI text in Chinese unless the user asks otherwise.
- Clicking an item name in the profit table must open that item in the mall page itself. The mall has no per-item URL, so this is done by driving the mall's own UI; never navigate the page, reload it, or open a new tab for this.
- Never let a failure be silent. Interface shape changes, truncated offer lists, unparsable blacklist files and storage write failures must all surface a visible message.

## Source Layout

- `manifest.json`: extension manifest.
- `content.js`: page UI, API requests, caching, filters, port blacklist import/export, mall item jump.
- `profit-core.js`: pure profit, outlier, port-filter and blacklist-parsing algorithms.
- `content.css`: injected UI styles.
- `tests/profit-core.test.js`: Node tests for pure algorithms.
- `tools/e2e/`: optional real-browser harness, see below.

## Mall Item Jump

The mall is a single-page app at `/mall` with **no per-item route**: `mall-home` never reads `window.location`, so an item deep link does not exist. The jump therefore has to drive the mall's own DOM:

- The mall's item table is found by its `thead` text (`物品名`), re-located on every poll so a rebuilt table is picked up.
- The row is found by matching an exact leaf text anywhere in the row, so `石头` can never select `圆石`.
- The row click is a real bubbling `MouseEvent`, because React attaches its `onClick` at the root.
- The mall searches server side, so if the row is not currently rendered the extension writes to the search input (`placeholder="搜索物品名"`) using the native value setter plus an `input` event, then waits by polling (`setInterval`, 120 ms).
- Never wait with a `MutationObserver` bound to the table: changing the search query makes the mall unmount and rebuild the whole table, which kills the observer and silently breaks the jump.
- Failures (not on `/mall`, search box missing, item absent) must keep the panel open and show a message. Restore the search box first, re-locating the input because the mall may have remounted it.
- Keep the jump single-flight and leave `.mpe-jump-target` as a best-effort highlight on the row the jump landed on.
- Never scroll the page or reload it — only `scrollIntoView` on the matched row.

## Test Commands

Run from the repository root:

```powershell
node --check .\mall-profit-extension\profit-core.js
node --check .\mall-profit-extension\content.js
node .\mall-profit-extension\tests\profit-core.test.js
```

After changing calculation or filtering logic, also test against the live public API or load the extension in Chrome and verify:

1. Open the mall panel.
2. Confirm no automatic calculation starts.
3. Click "开始计算".
4. Verify progress, result count, sorting and cache behavior.
5. Close and reopen the panel; confirm results appear without calculating again.

For DOM-facing changes (jump, port manager, table rendering), prefer the harness in `tools/e2e/` over manual clicking — see `tools/e2e/README.md`. It injects the real `content.css`, `profit-core.js` and `content.js` into the live mall page with a stubbed `chrome.storage.local`, records the fetch log and returns a JSON result object.

Harness gotchas worth remembering:

- UI text is Chinese, so when passing script text through a shell use `\uXXXX` escapes rather than literal characters.
- The default `10x` anomaly filter hides every row. Set `#mpe-anomaly-filter` to `0` before waiting for `#mpe-tbody` rows, otherwise the panel looks empty.
- A single eval call cannot observe the whole jump. Kick off an async driver that stores progress on `window.__R` and poll `window.__R.phase` from the shell.

## Important Data Rules

- `minSellPrice`, `maxBuyPrice`, and `sellAmount` come from the market item list API.
- Offer details come from `/api/mall/items/{itemName}/offers`.
- Use `includeTagged=false`.
- A vanilla item is identified by a non-empty `vanillaId`.
- A port is resolved from `offer.region` or `offer.nearestPort.name`.
- Port blacklists change the analysis cache key. Never reuse a cache entry after the blacklist changes.
- The default anomaly multiplier is `10`; allowed options are `0`, `5`, `10`, `20`.
- Caches expire after five minutes, but expiry must never trigger an automatic calculation.

## Change Discipline

- Keep calculations deterministic and place pure algorithms in `profit-core.js`.
- Add or update Node tests for algorithm changes.
- Do not add npm dependencies unless necessary.
- Do not commit browser profiles, temporary test files, credentials, PEM keys or CRX files.
- Preserve imported/exported port blacklist compatibility.
- Update `manifest.json` version and `README.md` when user-visible behavior changes.

# Project Handoff

## Objective

Build and maintain a Chrome extension that filters profitable items in the SimMC mall at `https://mall.vesego.xyz/`.

The extension is injected into the mall page and provides a custom profit-ranking panel. It is not a server application and has no build step.

## Current User Requirements

- Compare highest buy price with lowest sell price.
- Show only positive-profit items by default.
- Support both per-unit profit and maximum executable total profit.
- Ignore port distance and transportation costs.
- Hide tagged/invalid shops by requesting `includeTagged=false`.
- Support minimum sale quantity filtering.
- Filter vanilla and non-vanilla items using `vanillaId`.
- Filter statistically abnormal same-item offers.
- Block specified ports from all buy/sell offers.
- Import and export the port blacklist.
- Require manual calculation. Never calculate automatically when opening or reopening the panel.
- Existing cached results must appear when the panel is reopened.
- Clicking an item name in the profit table must open that item's detail in the mall page, without the user closing the panel and searching manually.

## Architecture

### `content.js`

Responsible for:

- injecting the panel and port manager UI;
- reading public mall APIs;
- paginating market and offer endpoints;
- caching market, total-profit and offer-analysis results;
- applying search, quantity, vanilla and port filters;
- manual calculation flow;
- port blacklist import/export;
- storing the port blacklist in `chrome.storage.local`;
- jumping from a profit row into the mall's own item detail view;
- validating API payload shapes and surfacing interface drift instead of silently showing an empty list.

### `profit-core.js`

Pure, testable functions:

- `buildUnitRows`: positive-profit rows from market summary data.
- `parsePortBlacklistText`: parses an imported blacklist file (JSON object, JSON array, TXT or CSV) and reports a reason when the file is unusable.
- `filterOutlierOffers`: median-multiple anomaly filtering.
- `filterBlacklistedOffers`: exact port blacklist filtering.
- `buildOfferAnalysis`: combines port filtering, outlier filtering, price summaries and total-profit matching.
- `calculateMatchedProfit`: matches cheapest sell offers with highest buy offers by amount.
- `sortRows`: stable sorting helpers.

### `content.css`

The extension uses prefixed `.mpe-*` classes to avoid colliding with the mall page CSS. `.mpe-jump-target` is the one intentional exception: it is applied to a row inside the mall's page to briefly highlight the item that the jump landed on.

## Mall Item Jump

The mall is a single-page app served at `/mall`. There is **no per-item route and no item deep link**: the mall bundle never reads `window.location`, and the whole app boots through a one-shot pathname match. Route changes are full page loads, which would destroy the panel. The jump therefore drives the mall's own UI instead of navigating.

Order of operations:

1. Refuse early when the current path is not `/mall`, keeping the panel open with a message.
2. Look for the row already rendered in the mall list; if found, do not touch the search box at all.
3. Otherwise write the item name into the mall search input (`placeholder="搜索物品名"`) via the native value setter plus a bubbling `input` event, because the input is React-controlled.
4. Wait for the row by polling (`setInterval`, 120 ms) up to eight seconds. A `MutationObserver` was tried first and is wrong here: the mall unmounts and rebuilds the whole table when the search query changes, so any observer bound to the pre-search table node goes dead and never fires.
5. On success: close the panel, `scrollIntoView` the row, dispatch a real bubbling `click` (React listens at the root), then add `.mpe-jump-target` for a short highlight.
6. On failure: re-locate the search input (the mall may have remounted it), restore the previous value, keep the panel open and show the reason.

Supporting rules:

- The mall item table is identified by its `thead` text `物品名`, never by an index, and is re-located on every poll so a rebuilt table is picked up.
- The row is identified by an exact leaf-text match anywhere in the row, so substring matches such as `石头` versus `圆石` cannot select the wrong item.
- The jump must never trigger, restart or abort an offer calculation.
- Leaving the mall search box set to the item name is intentional and only happens when the fast path failed.
- Jump is single-flight: a second click while a jump is running is ignored.
- If the row click throws after the panel was already closed, the panel is reopened so the user never faces a blank page.

## APIs

Base: `https://mall.vesego.xyz/api/mall`

- `GET /items?includeTagged=false&limit=100&offset=N`
- `GET /items/{encodedItemName}/offers?includeTagged=false&limit=100&mode=buy&offset=N`
- `GET /items/{encodedItemName}/offers?includeTagged=false&limit=100&mode=sell&offset=N`
- `GET /ports?includeTagged=false`

The server caps `limit` at 100.

## Calculation Rules

Per-unit profit:

```text
maxBuyPrice - minSellPrice
```

Only positive values are displayed.

Total profit:

1. Sort sell offers by price ascending.
2. Sort buy offers by price descending.
3. Match quantities while the buy price is greater than the sell price.
4. Sum `(buyPrice - sellPrice) * matchedAmount`.

This assumes offers are executable and ignores travel and transport costs.

## Anomaly Filtering

Options:

- Off
- Strict: `5x` median
- Recommended: `10x` median
- Loose: `20x` median

For normal sample sizes, offers below `median / multiplier` or above `median * multiplier` are removed. Small samples use the largest adjacent price gap to reduce false positives.

Anomaly filtering is statistical. It is not proof that a listing is invalid.

## Port Blacklist

- Exact match against `offer.region` or `offer.nearestPort.name`.
- Blacklisted offers are removed before anomaly detection and total-profit matching.
- The blacklist is persisted in `chrome.storage.local`.
- Export format:

```json
{
  "format": "mall-profit-port-blacklist",
  "version": 1,
  "exportedAt": "ISO-8601 timestamp",
  "ports": ["港口甲", "港口乙"]
}
```

Import accepts this JSON, a raw array of strings, or TXT/CSV text. After editing or importing, results require manual recalculation.

An import that cannot produce at least one port name is rejected with a reason and leaves the current draft selection untouched. Only `ports` being a non-empty array of strings is accepted from a JSON document.

## Cache Rules

- Market summary cache: five minutes.
- Total-profit cache: five minutes.
- Offer-analysis cache: five minutes.
- Analysis cache keys include the anomaly multiplier and a stable hash of the port blacklist.
- Cache expiry does not trigger calculation.
- The manual button forces a new calculation and replaces the active cache.
- Refreshing market data clears analysis caches but preserves the port blacklist.
- `unlimitedStorage` is requested so the market cache can grow with the item count. If a write still fails, the status line says so instead of leaving the user with cache that silently stops working.

## Non-Silent Failure Rules

Every one of these must produce a visible message in the panel rather than an empty or stale table:

- Mall API payload missing its `items`, `offers` or `ports` array.
- An offer list that hit `maxOffers` / page guard and was therefore truncated.
- A port blacklist file that cannot be parsed.
- A `chrome.storage.local` write failure.

## Current UI

Toolbar filters:

- Profit mode: per-unit / total.
- Sort mode.
- Item name search.
- Minimum sale amount.
- Vanilla / non-vanilla / all.
- Anomaly multiplier.
- Port blacklist manager.

Top-right actions:

- "开始计算" / "重新计算"
- "刷新数据"
- Close

Table:

- Item names are buttons. Clicking one jumps to that item in the mall page (see "Mall Item Jump").
- Keyboard users reach the same action with Tab and Enter.

Status line:

- Left: market item count and last update time.
- Right: contextual note. It shows the default hint normally, and switches to jump progress, storage or truncation warnings. On narrow screens the default hint is hidden but real notices stay visible.

## Verification

All of the checks below live in the repo under `tools/e2e/`, with run instructions
in `tools/e2e/README.md`. `tools/e2e/jsdom-harness.js` is the fast headless layer;
`tools/e2e/gen-inject.py` plus `tools/e2e/run-jump.js` and `tools/e2e/run-ports.js`
drive real Chromium against the live mall.

### Calculation baseline at `v1.6.0`

- 8,230 market items loaded.
- 430 raw positive-profit items.
- Default `10x` anomaly filtering produced 354 results.
- Blacklisting `星月湾` and `五月花港` produced 343 results.
- Opening and reopening the panel did not trigger recalculation.

### Static and unit checks

- `node --check content.js` and `node --check profit-core.js` pass.
- `node tests/profit-core.test.js` passes, including the `parsePortBlacklistText` cases.

### DOM harness (jsdom, 20/20)

Fixture mall page with a React-style root `onClick` and a controlled search input. Covered:

- fast path: row already rendered, clicked without touching the search box;
- search path: search box written, row found, panel closed;
- exact match: `圆石` does not select `石头` or `黄铁矿`;
- not found: error message, panel stays open, search box restored;
- missing search box: explicit message, panel stays open;
- wrong route (not `/mall`): refused with a reason, panel stays open;
- no conflict: jump issues no `/offers`, no market refetch, leaves the calculate button untouched;
- regression: default `10x` filter still does not auto-calculate.

### Real browser (Chromium via `agent-browser`, injection harness)

Run against the live `https://mall.vesego.xyz/mall` with the real `content.js`
injected through `--init-script`.

Fast path, target `圆石` (already in the first 50 rows):

- panel closed, `.mpe-jump-target` applied, no error text;
- status note `已在商城页面中打开「圆石」。`;
- exactly one new request: `/api/mall/items/%E5%9C%86%E7%9F%B3/offers?...` (detail opened);
- `/items?...&q=` count: 0 — the mall search box was never touched.

Search path, target `远古残骸` (not in the first 50 rows, so the fast path cannot apply):

- panel closed, no error text, status note `已在商城页面中打开「远古残骸」。`;
- the mall's own search ran: `/api/mall/items?...&q=%E8%BF%9C%E5%8F%A4%E6%AE%8B%E9%AA%B8`, list narrowed to 1 row;
- detail opened: `/api/mall/items/%E8%BF%9C%E5%8F%A4%E6%AE%8B%E9%AA%B8/offers?...`;
- search box left holding `远古残骸`;
- `.mpe-jump-target` present after the table rebuild (the polling wait returns the new row node, so the highlight is not lost).

Port manager regression:

- 359 ports loaded, list scrollable (scrollHeight 8262 / clientHeight 282);
- toggling a checkbox kept `scrollTop` at 240 and updated the selected count without rebuilding the list;
- importing `{"foo":1}` → `导入失败：JSON 中缺少 ports 数组`, previous selection kept;
- importing `[{"a":1}]` → `导入失败：没有解析到任何港口名称`, previous selection kept;
- importing `{"format":"mall-profit-port-blacklist","version":1,"ports":["Alpha","Beta"]}` → `已导入 2 个港口`.

Known limitation: a bare scalar file such as `12345` falls back to TXT parsing and imports one port named `12345`. This is deliberate TXT support, not a silent failure.

## Moving To Another AI Tool

1. Clone or copy the entire repository directory.
2. Open the directory in the new tool.
3. Tell the tool to read `AGENTS.md` and this file before editing.
4. Run the test commands from `AGENTS.md`, then the harness in `tools/e2e/`
   (`node tools/e2e/jsdom-harness.js`, and `tools/e2e/README.md` for the browser layer).
5. Load `mall-profit-extension` as an unpacked Chrome extension for browser verification.
6. Rebuild `mall-profit-extension.zip` after any change to the extension sources.

No conversation history is technically required if these files are present. Do not rely on absolute workspace paths in future changes. The extension folder is the only thing that must ship; `tools/` is development-only.

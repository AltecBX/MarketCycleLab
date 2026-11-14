# Architecture

## Layers

```
src/engine/core   types, exchange calendar, statistics, indicators, series, outcomes
src/engine        one pure module per study. No DOM, no network, no clock
src/data          provider contract, fixture provider, client cache, engine worker, workspace store
src/ui            design tokens, shared components, SVG charts, formatting
src/app           shell, routes, ticker search, research workspace, stock strip
src/views         one folder per destination. Each view is its own lazy chunk
server            owner-only API: session, workspace compare-and-swap, job token
e2e               browser checks against the production build
```

Engines never call a provider. Views never compute a definition. A number on screen comes from an
engine function that has a test.

## Organization chosen, and the one rejected

Rejected: one destination per study (seven top-level entries and ten research subviews). Every
new idea adds navigation, the same symbol control repeats, and common paths get long.

Chosen: four destinations and one persistent stock workspace.

- **Today.** What changed and what needs attention.
- **Research.** One symbol and one as-of date shared by nine sections: Overview, Selloffs, Trend,
  Calendar, Strength, Earnings, Business, Forecasts, Lab.
- **Discover.** Screener, Groups, Drawdowns, Cash flow, Earnings calendar.
- **Portfolio.** Positions and risk, Protection, Journal.
- **Data and methods** sits behind the status chip in the header.

The symbol, section, as-of date and every study setting live in the URL. Back, Forward and
bookmarks restore the exact view. Older routes redirect through `LEGACY_ALIASES`.

## Data flow

1. A view asks the client for a keyed resource. The cache dedupes in-flight loads and drops a
   failed load so a failure never poisons a later success.
2. Identity resolves first. Prices, earnings and fundamentals then load in parallel and settle
   independently, so one failed source affects only the cards it feeds.
3. When the key changes the previous result is dropped at once. A view cannot show another
   symbol's figures under the new name.
4. Heavy studies run in a worker through `useEngine`. The key carries symbol, as-of and settings.

## Providers

`DataProvider` in `src/data/contracts.ts` is the only seam. This build ships one implementation,
the synthetic fixture provider. A live provider implements the same interface on the server, with
credentials read from server secrets. No credential reaches the browser.

## Owner state

`WorkspaceStore` is revisioned. This build uses the browser-local store and says so in the UI.
The server API in `server/app.ts` provides the durable version: signed HttpOnly session,
same-origin writes, `If-Match` compare-and-swap with 412 on a stale revision, a body size bound,
and a separate job token limited to appending whitelisted monitor rows. The client is not yet
wired to it.

## Not built

Live provider adapters, durable repository (D1 or similar), scheduler, client wiring to the
server store, migration tooling, logo assets, weather.

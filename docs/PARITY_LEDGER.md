# Parity ledger

One row per capability in the owner specification. Last updated 2026-11-14.

**The "old source" column is the reference file the specification names. None of those files was
read.** The reference was not reachable from the build session, so no row carries "source
verified" or "authenticated runtime verified". See `docs/EVIDENCE.md`.

Status labels:
- **Fixture verified.** Built from the specification and covered by unit tests on hand-built
  cases and by browser checks on synthetic data.
- **Partial.** Some of the capability is built. The gap is stated.
- **Gated.** Built, and withheld at runtime until its evidence gate or data source exists.
- **Not built.** No implementation. The reason is stated.

| # | Capability | Old source (unread) | New location | Acceptance test | Status and differences |
|---|---|---|---|---|---|
| 1 | Shared stock selection, ticker pill, keyboard search, aliases | global-selection.mjs, stock-research-loader.mjs | `src/app/search.tsx`, `research.tsx` | `e2e/run.mjs` steps 2 to 4 | Fixture verified. CCCX resolves to INFQ. Unknown symbols explain themselves |
| 2 | Quote strip: close, YTD, 200 day, closing high, forward P/E, FCF, cash, next earnings | DashboardContent.jsx | `src/app/StockStrip.tsx` | `core.test.ts`, `valuation.test.ts`, e2e | Fixture verified. Beta, 52 week range, volume, cap sit in Data details |
| 3 | Company logos | reference assets | `Logo` in StockStrip | e2e INTC badge check | Partial. Ticker badge only. No licensed artwork. A generic image is never shown as a logo |
| 4 | Weather | Open-Meteo adapter | none | none | Not built. Optional, outside the research path |
| 5 | Today: health, alerts, watchlist, week ahead | CommandCenter, DecisionOverview | `src/views/Today.tsx`, `engine/today.ts` | `today.test.ts`, e2e | Fixture verified. Alert thresholds have no editor yet |
| 6 | Data and methods, source health, scoped failure | source-scopes.mjs | `src/views/DataMethods.tsx` | e2e step 5 | Fixture verified on a simulated outage |
| 7 | Price and volume charts, MA overlays, comparison | price research views | `views/research/Overview.tsx` | e2e | Fixture verified |
| 8 | Drawdown episodes, counts per year, durations, current selloff analogs | research.mjs, cycle-decisions.mjs | `engine/drawdowns.ts`, Selloffs current tab | `drawdowns.test.ts` | Fixture verified. Sample gate and overlap spacing are proposed values. 11 sector grid not built |
| 9 | Monthly returns board, High and Low YTD, seasonality | monthly-history.mjs | `engine/monthlyBoard.ts`, Calendar | `monthlyBoard.test.ts` | Fixture verified |
| 10 | Weekly returns board | weekly-returns.mjs, WeeklyReturnsBoard.jsx | `engine/weeklyBoard.ts`, Calendar weekly | `weeklyBoard.test.ts` | Fixture verified. Owner NVDA 2026 fixture not reproduced |
| 11 | Moving average runs, age, distance, survival | ma-duration-model.mjs | `engine/maRuns.ts`, Trend | `maRuns.test.ts` | Fixture verified. Touch policy is a proposed choice. Histogram uses equal width bins |
| 12 | Big declines, bases, horizons, exhaustion patterns | decline-engine.mjs, BIG_DECLINES.md | `engine/declines.ts`, Selloffs declines tab | `declines.test.ts` | Fixture verified. Pattern windows the specification left open are proposed. Size, volume and trend filters not on screen |
| 13 | Shared analog service | shared-history.mjs, statistical-evidence.mjs | `engine/analogs.ts` | `analogs.test.ts` | Fixture verified. Feature weights proposed. Group cohorts supported by the engine, not on screen |
| 14 | Monthly Reversal | monthly-reversal-study.mjs and views | `engine/monthlyReversal*.ts`, Selloffs monthly tab | `monthlyReversal.test.ts` | Fixture verified. Match weights and scales proposed (equal weights). Reference checkpoints not reproduced. Cohort range filters and cross-stock scanner not on screen |
| 15 | Relative strength, ranges, state precedence, compression | relative-strength.mjs | `engine/relativeStrength.ts`, Strength | `relativeStrength.test.ts` | Fixture verified. State thresholds are the specification's |
| 16 | Breakout events and outcomes | strength-outcomes.mjs | `engine/breakouts.ts`, Strength breakouts tab | `breakouts.test.ts` | Gated. Estimate shows only when it beats the baseline out of sample |
| 17 | Strength scanner | RelativeStrength.jsx | Strength scanner tab | e2e | Partial. Single column sort. No per row validation |
| 18 | Watchlist transition monitoring | monitor routes | `transitionEvents` in engine | unit test only | Not built in the UI. Needs delivery |
| 19 | Screener, cap floor, sort, search, filter builder | LargeCapScreener.jsx, ScreenerFilters.jsx | `engine/screener.ts`, Discover | `screener.test.ts`, builder browser check | Fixture verified on a 58 symbol universe. Saved views not built. Buy % and Week move columns empty |
| 20 | Groups, industry view, co-movement | IndustryOverview.jsx, TradingSimilarity.jsx | `engine/groups.ts`, Discover groups | `groups.test.ts` | Fixture verified. Themes come from the specification, unverified against filings |
| 21 | Drawdown board | screener schemas | Discover drawdowns | `screener.test.ts` | Fixture verified |
| 22 | Cash flow tab | cash-flow schema | Discover cash, `engine/valuation.ts` | `valuation.test.ts` | Fixture verified |
| 23 | Earnings calendar | market_earnings_calendar | Discover earnings calendar | `earnings.test.ts` | Fixture verified. No rolling capture archive. No external calendar link |
| 24 | Earnings reactions, runups, drift, path comparison | earnings views | `engine/earnings.ts`, Earnings | `earnings.test.ts` | Fixture verified |
| 25 | Expected versus realized move | implied_moves | `expectedVsRealized` in engine | unit test only | Gated. No option data source |
| 26 | Canonical forward P/E | forward-PE schema | `engine/valuation.ts` | `valuation.test.ts` | Fixture verified. One record feeds strip and screener |
| 27 | Trailing P/E, own history percentile, peer context | valuation_archive | `engine/valuation.ts`, Business | `valuation.test.ts` | Gated. No actual EPS basis field and no archive yet |
| 28 | Business checkpoints and notes | milestones | Business, workspace journal | builder browser check | Fixture verified. Browser storage only |
| 29 | Positions, marks, P and L, coverage totals | portfolio-research.mjs | `engine/portfolio.ts`, Portfolio | `portfolio.test.ts` | Fixture verified. No Google positions import |
| 30 | CSV import, reconcile, archive, receipts | holdings-adapter.mjs | Portfolio | `portfolio.test.ts`, builder browser check | Fixture verified |
| 31 | Exposure, correlation, scenario shocks | scenario-research.mjs | Portfolio risk | `portfolio.test.ts` | Fixture verified. ETF look-through and event replay have no screen |
| 32 | Protection planner | GuidedProtection.jsx, ProtectionWorkbench.jsx | `engine/protection.ts`, Protection | `protection.test.ts` | Partial. Manual premiums only. No quotes. Ladder and roll have no screen |
| 33 | Research journal, append only, corrections | workspace-store.mjs | Journal | builder browser check | Fixture verified. Browser storage only |
| 34 | Strategy tests, rolling audit | rolling-audit.mjs, StrategyTest.jsx | `engine/strategy.ts`, Lab rules | `strategy.test.ts` | Fixture verified. Holdout verdict rule proposed |
| 35 | Lab coverage map | lab-coverage.mjs | Lab coverage tab | e2e | Fixture verified as a table. Statuses reflect this build |
| 36 | Fear and Greed study | sentiment-model.mjs | `engine/sentiment.ts`, Lab sentiment | `sentiment.test.ts` | Partial. Synthetic proxy series, labeled. Zone inclusivity proposed |
| 37 | Options research tables, dealer positioning | lab_options_* | none | none | Not built. No source |
| 38 | Signal Score | signal-engine.mjs and others | `engine/signal*.ts`, Forecasts | `signal.test.ts` | Gated. No fixture symbol reaches Valid. Prior mass and regularization proposed. Not wired into Today or screener |
| 39 | Weekly Range Engine A and B | weekly-range.mjs, supplied scripts | `engine/weeklyRange.ts`, Forecasts range | `weeklyRange.test.ts` | Gated. Math built and tested. No option or IV source. Backtest not reproduced. No capture, settlement or reliability history |
| 40 | Owner-only access, revisioned writes, job identity | data-app-worker.js | `server/` | `server/app.test.ts` | Fixture verified in memory. Client not wired. No durable store |
| 41 | Scheduled refresh, risk monitor, Friday capture | hosting config | none | none | Not built. Needs a deployment |
| 42 | Owner data migration | D1 and R2 store | none | none | Not built. No access to the private store |
| 43 | Legacy route aliases | presentation.json | `LEGACY_ALIASES` | e2e step 6 | Partial. Names taken from the specification, not from the reference routes |
| 44 | Report view | src/content/report | none | none | Not built. Reference not read |

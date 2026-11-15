# Evidence log

What was verified, how, and what could not be. Each kind of evidence proves a different thing and
is kept separate. Last updated 2026-11-14.

## Evidence that exists

| Kind | What it covers | How to reproduce |
|---|---|---|
| Unit tests on hand-built cases | Every definition in the engines, the exchange calendar, statistics, and the owner API security rules | `npm test` |
| Invariant tests | Future rows never change earlier as-of results. Scaling all prices by one factor changes no return or state | `npm test` |
| Synthetic fixture smoke tests | Each engine runs on a long history (NVDA, from Jan 22, 1999) and a short one (SNDK, from Feb 24, 2025) | `npm test` |
| Owner acceptance fixture on real prices, session run | Weekly returns board on real NVDA daily bars from the Unusual Whales daily OHLC tool, 320 bars, Aug 1, 2025 to Nov 6, 2026, held outside the repository. All 13 owner figures matched: 45 completed weeks, 24 up, Aug 7 +11.56%, Nov 6 -8.80% at -1.94 sigma with low -11.33%, Feb 27 -6.65%, close $186.64, 22.0% below the 2026 closing high, 13.0% above the $165.17 Mar 30 closing low, five losing weeks, -20.2% from the Oct 2 close. Volume was absent from the capture, so relative volume was not exercised | Run `weeklyAcceptanceSummary` on a private capture. Not part of `npm test`, because the data cannot be committed |
| Browser checks on the production build | Routes at 1440, 440, 390 and 320 wide: no page side scroll, no console errors, no broken text. Symbol switching, alias, unknown symbol, keyboard search, scoped outage, legacy links | `npm run build && npm run e2e` |

## Evidence that does not exist

| Item | Why | What unblocks it |
|---|---|---|
| Reference source audit (AGENTS.md, plans, 272 tests, git history) | The reference lives on the owner's Mac. No folder was shared with the build session | Share the folder through Remote Control, or push the source to a private repository |
| Reference live site review | `market-cycle-research-jerry.jerryp.chatgpt.site` returns 401, sign in required | Owner-side review, or screenshots |
| Monthly Reversal checkpoints (NVDA Nov 13, SNDK) | Needs real data and the reference settings | Reference source plus a private capture |
| Relative strength checkpoint (NVDA Nov 13) | Same | Same |
| Weekly Range backtest reproduction (Engine A 152 weeks, Engine B 1,843 weeks) | The supplied zip, CSVs and Python scripts are on the owner's Mac | Share the backtest folder |
| Authenticated provider runs | Yahoo and Unusual Whales hosts are blocked by the session network policy. No API key was requested | Allow the hosts, store `UW_API_KEY` as a server secret |
| Scheduled jobs (daily refresh, risk monitor, Friday range capture) | No deployment exists | Staging deployment |
| Owner data migration | No access to the private store | Authorized export from the reference |
| Real device Safari review | Checks ran in headless Chromium at phone viewport sizes | Review on an iPhone |
| First-time user task review | No independent reviewer was available. Scripted checks stand in | A reviewer session |

## Thresholds marked proposed

The specification delegates some values to the reference source. Until that source is read they
are exposed as documented defaults tagged `provenance: 'proposed'` in each engine:
Monthly Reversal match weights and scales, moving average touch policy, analog feature weights,
exhaustion pattern windows the specification did not define, Signal Score prior mass and
regularization, drawdown study sample gate, valuation staleness tolerance, sentiment zone
inclusivity, strategy holdout verdict rule. Values the specification states are used exactly and
tagged `provenance: 'spec'`.

## Identity facts not re-verified

Company names, the CCCX to INFQ mapping, the SNDK and WDC February 2025 boundary and the curated
themes come from the owner specification. They were not checked against issuer filings in the
build session. The dates on which fixture histories start are fixture choices, not listing dates.

# MarketCycleLab decision system plan

**Goal.** Recognize when the reward left in holding a position is shrinking relative to the risk of giving back gains, and when a damaged position is starting to recover. Tie historical patterns, earnings expectations, valuation, price behavior and portfolio exposure to four practical choices: hold, reduce, protect, reenter.

This plan merges the original 12 research areas (`RESEARCH_FRAMEWORK.md`, implemented) with Part 1 (expectations, turning points, protecting gains) and Part 2 (earnings lead-in patterns, moving average behavior) into one system. AAPL and SNDK are the first case studies (section 8).

## 0. Evidence labels

Every statement in this plan, and every number the system shows, carries one of these labels.

| Label | Meaning | Example |
|---|---|---|
| VERIFIED | Observed directly in sourced data, reproducible by a script in this repo | AAPL first closed above $1T on the date in section 8 |
| HYPOTHESIS | An idea to test; not yet measured | "A smaller than usual beat from a habitual big beater gets sold" |
| ASSOCIATION | Measured on history with counts, intervals and failures, but not tested on later data | "After 20 day streaks above the 20 day average, the next 5 sessions..." |
| VALIDATED | Held on data not used to find it, after costs, and improved decisions versus holding | none yet |
| HYPOTHETICAL EXAMPLE | Made up numbers to show a calculation | a 500 share position at a $150 basis |

Status today: the data layer is VERIFIED for the 8 names checked (README, "Verifying SEC fundamentals"). The market study in `reports/market_study.md` contains ASSOCIATIONS with grades. **No decision rule in this system is VALIDATED yet.** The point of the build sequence is to find out which ones can be.

## 1. System structure

```
 Data (point in time)          Events and features            Evidence engine              Decision layer
 prices, splits, SEC facts  -> earnings, streaks, drawdowns -> counts, n_eff, intervals,  -> alerts with comparables
 8-K timing, estimates,        rallies, milestones, gaps,      failures, base rates,        giveback budget
 options, holdings, ETFs       valuation, revisions, regime    walk forward, BH q-values    protection payoffs
                                                                                            portfolio exposure
                                         ^                                                        |
                                         +---------------- Validation loop (rules vs holding) <---+
```

Five rules hold across every module:

1. **Point in time.** A feature on day t uses only data public by t (filings usable the day after acceptance, consensus as of its timestamp, prices through the close of t).
2. **Count failures.** Every table shows n, independent n, hits, fails, an interval and the base rate it must beat.
3. **One event per episode.** Overlapping windows (a streak counted every day, 12 monthly samples of a yearly return) are collapsed before counting.
4. **Learn early, test late.** Cutoffs are fitted on an earlier period and scored unchanged on a later one.
5. **Decisions are scored as portfolios.** A rule is judged by what it does to the position (gains kept, losses avoided, upside missed, costs, taxes), not by its hit rate.

### Module map

| Module | Integrates | Core question | Status |
|---|---|---|---|
| M1 Data and verification | orig 11 (data side), P1.10 (structure changes) | Are the inputs right and knowable at the time? | built, verified on 8 names |
| M2 Earnings expectations and reactions | orig 3, P1.1, P1.2, P2.1, P2.2, P2.3 | What was expected, what was delivered, and how did price treat it? | partly built (event study, run up, beat/miss) |
| M3 Earnings versus multiple, and the cycle | orig 4, orig 5, P1.3 | Is the move earnings or the multiple, and are profits cyclically high? | partly built (valuation bands, peers, as of basis) |
| M4 Price path, drawdowns, rallies, analogs | orig 1, 6, 7, 8, 12 (analogs), P1.4 | After conditions like today, what happened first: more downside, a target, or a new high? | built (first passage, analogs); add time under water |
| M5 Moving average streaks and extension | P2.4, P2.5, P2.6 | How unusual is the current streak and stretch, and what followed similar ones? | prototype verified (section 8) |
| M6 Market cap milestones | P1.5 | Does crossing $1T, $2T, ... add anything beyond the rally that got there? | facts verified for AAPL (section 8); test not built |
| M7 Context | orig 2, 9, 10, P1.2 (relative windows) | Is the move the stock, its industry, its sector or the market, and in what regime? | built |
| M8 Early warning versus confirmation | P1.6, orig 12 (alerts) | Which signals came before the damage, which after, and what does waiting cost? | new |
| M9 Portfolio exposure | P1.7 | Which holdings fall together, and what does a joint decline cost in dollars? | new |
| M10 Position economics | P1.8, P1.9, P2.7 (protection) | What does each protection choice pay in every outcome, and how much profit am I willing to give back? | new |
| M11 Alerts | P2.7, orig 12 | One card per condition: why, how unusual, comparables, outcomes, choices | partly built (phase, alerts) |
| M12 Validation | P1.10, orig 11, P2.7 (testing) | Did acting on the system beat holding, after costs, on later data? | engine built; decision backtests new |

## 2. Modules

### M1 Data and verification
* **Have:** split adjusted prices with splits (Yahoo), first reported and restated as of fundamentals (SEC XBRL), 8-K Item 2.02 timing converted from UTC to Eastern, Yahoo EPS estimate and actual, VIX, 10 year yield, S&P 500 GICS table, successor CIK merge, `python -m mcl verify`.
* **Add:** holdings and tax lots (user file), option chain snapshots, a daily archive of consensus estimates (expectations have no free timestamped history, see M2), ETF holdings files, and a structure change log (spin offs, mergers, splits, share class changes) per ticker so tests can stop at the break.
* **Rule for newer listings (P1.10):** a ticker's own statistics start at its listing date. Before that, only clearly labeled proxies may be used (SNDK, section 8.3).

### M2 Earnings expectations and reactions
Questions: P1.1 (what was expected), P1.2 (when good news stops being rewarded), P2.1 to P2.3 (the path into the report and its link to the reaction).

**Calculations**
* **Report alignment.** Reaction day t0 from 8-K acceptance time (before the open: same day; after the close: next session; during market hours: Yahoo's call). Report interval = sessions between consecutive reports. Fiscal quarter label from the company's fiscal year end (AAPL: September; SNDK: June/July).
* **Lead in (P2.1).** For the final 60, 40, 20, 10, 5 and 1 sessions before t0: total return, maximum rally (high close over the window start), maximum decline, and the session (relative to t0) of the highest and lowest close. A rally followed by a selloff inside the window is kept even when the net is small.
* **When buying or selling starts (P2.2).** Aligned paths by fiscal quarter across years: share of reports whose lead in high came 20 or more sessions early, 6 to 19 sessions early, or in the final 5 sessions; same for lows. Shown per year next to the median path, with n and the 25 to 75 percentile band.
* **Surprise versus usual (P1.1).** surprise = (actual − estimate) / |estimate|; surprise_vs_usual = (surprise − median of the prior 8 surprises) / MAD of the prior 8, using only reports before this one. "Smaller beat than usual" = surprise > 0 and surprise_vs_usual below −1. Revenue surprise and guidance versus consensus join when the data exists (below).
* **Four lead in combinations (P2.3).** Rally into the report (lead in return above its own historical median) or decline, crossed with continued gain or reversal over t0 to t0+1, t0+5 and t0+20; split by result (beat, inline, miss), guidance (raised, held, cut, when known), valuation percentile and market regime. Reported as ASSOCIATION with n per cell; a cell with fewer than 10 independent reports is shown but marked insufficient.
* **Reaction quality (P1.2).** Flags per report: sold good news (beat or raised guidance, and t0 return below the sector ETF's by more than one typical daily move); failed gap (open above the prior close by more than 1%, close below the open); absorbed bad news (miss or cut guidance, t0 excess return above zero). Then 1, 5 and 20 session excess returns versus industry ETF, sector ETF and SPY. Test: does a run of "sold good news" in the last 4 reports change the next 60 session distribution versus the stock's base rate (M12 decides if it is more than an ASSOCIATION).

**Data reality for expectations.** Yahoo provides one EPS estimate per past report with no timestamp or source history, and current estimate trends only for the next few quarters. Timestamped consensus and revision history (LSEG I/B/E/S, FactSet, S&P Capital IQ) are paid. Plan: (a) use Yahoo's figure for the surprise history, labeled "consensus, untimestamped"; (b) start a daily snapshot archive now (Yahoo estimate trend and revisions; TipRanks if connected) so revisions become testable going forward; (c) guidance from the 8-K exhibit text where companies print it, and a `guidance` column the user can fill in from calls. Apple gives its outlook on the call, not in the release, so AAPL guidance needs transcripts (Quartr connector, currently needs sign in).

### M3 Earnings versus multiple, and the cycle (P1.3, orig 4 and 5)
* **Decomposition.** Over any window, log price return = Δlog(EPS) + Δlog(P/E), plus dividends. Trailing version uses TTM EPS from SEC (available now, both bases). Forward version uses consensus next twelve months EPS (needs the archive in M2). Output: "price −8% = earnings +6% and multiple −14%", per quarter, with the multiple's percentile versus its own history.
* **Falling despite improving earnings / rising despite weak earnings.** Flag when the signs of the two components disagree for 2 consecutive quarters; test what followed (ASSOCIATION, then M12).
* **Cycle check for cyclicals (memory, semis, energy).** Normalized earnings = median operating margin over the last full cycle (or 7 to 10 years) × current TTM revenue; P/E on normalized earnings next to P/E on current earnings. Margin percentile versus its own history. Industry measures from XBRL where free: gross margin, inventory days (InventoryNet / cost of revenue × 91), capex to revenue, and customer spending proxies (hyperscaler capex from MSFT, GOOGL, AMZN, META filings). Contract pricing (NAND, DRAM) is paid data (TrendForce); until then it is manual input or omitted. Flag: low current P/E with margin in its top decile = "low multiple on peak profits" HYPOTHESIS to test, not a buy signal.
* **Peers (orig 5)** stay as built: premium to peer median and its own history; cheap versus value trap by fundamental momentum.

### M4 Price path, drawdowns, rallies, analogs (orig 1, 6, 7, 8, 12; P1.4)
* Built: extended downturns and swing selloffs, rally and selloff checkpoints with "another 10% before a 10% pullback" races, bounce versus recovery, analogs.
* **Add (P1.4):** for each current condition set (drawdown depth, rally size, valuation percentile, revision direction, regime), the outcome table shows: forward returns at 20/60/120/250 sessions (median, 10th and 90th percentiles), further downside before recovery (MAE), sessions to recover the prior high, share of time below the prior high, and the race: which came first among −X% more, +Y% target, or the prior high. Sample size, independent sample size, Wilson interval and the base rate on every row.

### M5 Moving average streaks and extension (P2.4 to P2.6)
* **Inputs.** Split adjusted closes (dividends ignored, as on most charts; held consistent across the history). Simple averages: 5, 20, 50, 200 sessions.
* **History per average (P2.4).** Share of days above; number of crossings; completed streak lengths above and below (median, 75th, 90th, 95th percentile, maximum); distance from the average; slope (5 session change in the average); outcomes after crossings; for 50 and 200: time below, failed recovery attempts (close back above that fails within 10 sessions), and outcomes after a regained average.
* **Conditional on the current length (P2.5).** Take every past same side streak that reached today's length L; measure the next 3, 5 and 10 sessions: return, share where the streak ended (a close on the other side), and share with a decline larger than one typical move (20 session daily volatility × √h). Compared with all same side days. The historical maximum is shown as an observation, not a deadline. A crossing is reported separately from a price loss, because the average can catch up while price moves sideways.
* **Combinations (P2.6).** Streak percentile × distance from the average in volatility units × rally size × proximity to earnings × relative strength × sector trend, shown as small two way tables, never more than two conditions at a time unless n allows. Overlap control: one representative per family (the 20 day streak and the 50 day distance carry similar information); conditions scanned together get Benjamini Hochberg q values; n is counted in independent streaks, not days.
* The prototype is already verified against a brute force count (section 8 values come from it).

### M6 Market cap milestones (P1.5)
* **Event definitions.** First intraday crossing (high × shares), first close, and each later close crossing from below. Shares: the latest cover page count filed on or before that day, split adjusted. Windows: 5, 20, 60, 120 sessions; max drawdown within 120 sessions.
* **Control group.** Rallies of the same size and speed, at similar valuation percentile and regime, that did not cross a round number (from the stock itself and from other mega caps). The milestone adds information only if its outcomes differ from the matched controls beyond the interval.
* **Expectation.** With AAPL alone, there are 4 thresholds; across all US companies that crossed $1T or more there are still only a few dozen events. This will stay at ASSOCIATION or Insufficient; it cannot reach VALIDATED on its own.

### M7 Context (orig 2, 9, 10)
Built: return attribution to market, sector, industry and company; behavior in market selloffs; trend, VIX and rate regimes; breadth; seasonality with walk forward (which so far shows no edge for the S&P 500, section 2 of `reports/market_study.md`). Used by every other module as conditioning columns, never as a stand alone signal.

### M8 Early warning versus confirmation (P1.6)
* **Early signals** (knowable before the event): valuation percentile, relative strength rolling over, extension (streak and distance percentiles), rally size percentile, days to earnings, estimate revisions turning (once archived).
* **Confirmation signals** (visible after): failed earnings rally, break of the 50 or 200 day average, lower swing high, drawdown checkpoint reached.
* **Measurement.** For every historical decline of the chosen size, the lead time of each signal; for every signal, the share of firings followed by that decline within N sessions (precision), the share of declines it caught (recall), false alarms per year, and the upside given up by acting at each firing. The result is a tradeoff curve per stock: act early (more false alarms, less given back) versus act late (fewer false alarms, more given back). All features are recomputed as of each day.

### M9 Portfolio exposure (P1.7)
* **Shared drivers.** Tag each holding by industry, end market and theme (for example AI data center, memory cycle, consumer hardware). ETF look through: weights of each stock inside each ETF held, from issuer holdings files.
* **Falling together.** Downside correlation (correlation on days SPY falls more than 1%, and over the last 3 market selloffs), beta to each theme ETF.
* **Earnings clustering.** Calendar of report dates across holdings; flag weeks where more than a set share of portfolio value reports.
* **Dollars.** Scenario table: for shocks such as "semis −20%, market −10%", each position's expected loss = value × beta to the shocked factor, with the historical worst case from the last selloffs next to it; totals for the portfolio and for each theme.

### M10 Position economics: giveback budget and protection (P1.8, P1.9, P2.7)
**Giveback budget (P1.9)**
* Track per lot: cost basis, acquisition date (tax term), current value, highest position value since a chosen reset date, unrealized gain, and peak unrealized gain.
* giveback = (peak unrealized gain − current unrealized gain) / peak unrealized gain. This is a different number from the stock's decline: a stock down 10% from its high can have given back 40% of the profit if most of the gain is recent (HYPOTHETICAL EXAMPLE: basis $100, high $150, now $135: stock −10%, profit given back 30%).
* The budget is a share of peak unrealized gain the user accepts losing over a window (for example 25% over 3 months). From it: the price at which the budget is used up, and the share of the position whose loss at the stock's historical 90th percentile earnings gap would use up the budget in one night. Execution assumption: stops fill at the next open after a gap, not at the stop price.

**Protection choices (P1.8)**, each priced from the live option chain, shown at expiration and before it (Black Scholes repricing at today's implied volatility across a price grid and dates):

| Choice | Cost | Remaining downside | Upside given up | Notes |
|---|---|---|---|---|
| Hold | none | all | none | gap risk shown from the earnings gap history |
| Trim k% | taxes on the realized part | (1 − k) of position | k of position | |
| Sell | taxes | none | all | wash sale window on a loss (IRC §1091) |
| Covered call, strike K | premium received | stock downside minus premium | above K | effective sale price = K + premium if assigned |
| Protective put, strike P | premium paid | below P only, plus premium | none | |
| Collar (put P, call K) | net premium | below P | above K | constructive sale review (IRC §1259) |

* **Deep in the money calls.** Premium = intrinsic (price − K) + time value. Effective sale price = K + premium; only the time value is income for waiting; the position behaves like stock with little upside and full downside down to roughly K minus time value. Tax: a call struck below the statute's "lowest qualified benchmark" is not a qualified covered call (IRC §1092(c)(4)), which brings the straddle rules into play; a qualified in the money call suspends the stock's holding period while open (§1092(f)). Section 9 has the cited rules.
* **Coverage amounts.** Calls are compared at several strikes and at 25%, 50% and 100% of the shares, against the user's stated willingness to sell and the giveback budget. Default: calls are written against shares already owned.
* **Assignment.** Probability of finishing in the money (from the chain's implied volatility), early assignment risk before ex dividend dates when the remaining time value is below the dividend, and the tax result of assignment for each lot.

### M11 Alerts (P2.7)
Each alert is one card:
1. Condition and why it fired (the rule and today's values).
2. How unusual: percentile versus the stock's own history, and n.
3. Comparable cases: count, independent count, date range.
4. What happened next: median, 10th and 90th percentile, share with further gains, share with a meaningful decline, over the stated horizon.
5. Evidence label (ASSOCIATION until M12 says otherwise) and grade.
6. Choices from M10 with their payoffs at today's prices, sized to the giveback budget.

### M12 Validation (P1.10)
* **Rules, not signals.** Each candidate rule is written as an action (for example "write 30 delta calls on 50% of shares when the 20 day streak is above its 90th percentile and earnings are more than 15 sessions away; buy back at 50% of premium or 5 sessions before earnings").
* **Walk forward.** Fit on the first 60% of the history, score the remaining 40% unchanged; purge events whose windows overlap the split.
* **Scoreboard versus holding.** Ending value, largest drawdown, profit given back, upside missed, false alarms per year, number of trades, costs (option bid ask spreads from chain snapshots; commissions), assignment events and tax drag by lot.
* **Insufficient evidence** is an allowed result and is printed as such: fewer than 10 independent events, intervals that include the base rate, or results that flip between periods. SNDK will show this for most rules (section 8.3).
* **Structure changes.** Splits handled by adjustment; spin offs, mergers and share class changes end a ticker's comparable history (from the M1 log).

## 3. Data inventory

| Data | Source | Point in time | History | Status |
|---|---|---|---|---|
| Daily OHLCV, splits, dividends | Yahoo (yfinance) | yes | from 2005 (config) | have |
| Quarterly fundamentals, shares | SEC XBRL company facts | yes (filing date) | about 2009 on | have, verified |
| Earnings dates and timing | SEC 8-K Item 2.02, Yahoo | yes | 2004 on (SEC) | have, verified |
| EPS estimate and actual | Yahoo | estimate untimestamped | about 25 years | have, label limits |
| Revenue estimates, revisions | Yahoo (current only), TipRanks | from archive start | none free | start archive |
| Guidance | 8-K exhibit text, call transcripts | yes | varies | parse 8-K; transcripts need Quartr sign in or paid |
| Option chains | Yahoo (current snapshot) | snapshot | none free | snapshot daily |
| Option and IV history | Cboe DataShop, ORATS, OptionMetrics | yes | long | paid; until then model estimates labeled as such |
| Sector and industry ETFs | Yahoo | yes | long | have |
| ETF holdings | issuer files (SPDR, iShares) | current only | none | add |
| Industry pricing (NAND, DRAM) | TrendForce | yes | long | paid; manual entry meanwhile |
| Inventory, margins, capex | SEC XBRL | yes | about 2009 on | have the facts; add the ratios |
| Hyperscaler capex | SEC XBRL (MSFT, GOOGL, AMZN, META) | yes | about 2009 on | have the facts |
| VIX, 10 year yield, breadth | Yahoo, FRED, GitHub mirrors | yes | long | have |
| Holdings, lots, budget | user file `data/user/holdings.json` | n/a | n/a | add |

## 4. Visualizations

| View | Module | Shows |
|---|---|---|
| Earnings aligned paths | M2 | each year's path from t0−60 to t0+20 by fiscal quarter, median line and 25 to 75 band, lead in high and low marked |
| Lead in versus reaction quadrant | M2 | pre earnings return against t0 to t0+5 return, colored by beat or miss, with counts per quadrant |
| Surprise versus usual | M2 | bars of each surprise with the trailing median and the reaction on top |
| Earnings versus multiple waterfall | M3 | price change split into EPS change and multiple change, per quarter |
| Cycle panel | M3 | operating margin with its history band, inventory days, capex to revenue, P/E on current and normalized earnings |
| Outcome fan | M4 | forward return percentiles from analog or conditional cases, with the race result counts |
| Streak histogram | M5 | completed streak lengths with today's marker; next 3/5/10 session outcome bars for streaks that reached today's length |
| Milestone study | M6 | event study around each crossing versus matched non milestone rallies |
| Signal timeline | M8 | early and confirming signals on the price chart before past declines, with lead times |
| Exposure heatmap and dollar scenarios | M9 | downside correlations by holding; scenario losses in dollars by theme |
| Payoff panel | M10 | profit and loss at expiration and at two earlier dates for hold, trim, calls at several strikes, put, collar |
| Giveback gauge | M10 | profit kept versus peak, budget line, price where the budget runs out, one night gap risk |
| Alert card | M11 | the six parts listed in M11 |

## 5. Build sequence

| Phase | Builds | Uses data that is | Output type |
|---|---|---|---|
| 0 (done) | data verification, point in time fundamentals, restated as of basis, earnings timing, `verify` | free, verified | VERIFIED inputs |
| 1 (MVP, section 6) | holdings file, giveback budget, moving average streak stats, earnings lead in stats, live option payoff panel, exposure basics, alert cards | free, available now | VERIFIED facts and ASSOCIATIONS |
| 2 | earnings versus multiple (trailing), reaction quality flags, time under water, market cap milestone study with controls, signal timeline | free, available now | ASSOCIATIONS |
| 3 | estimate and option chain snapshot archive, guidance parsing from 8-Ks | free going forward | builds history; testable after 6 to 12 months |
| 4 | rule backtests and validation scoreboard (M12), early versus late tradeoff curves | free prices plus modeled option prices; paid history makes it exact | first chance at VALIDATED |
| 5 | cycle module with industry pricing, forward based decomposition | paid or manual inputs | ASSOCIATIONS |

Can be implemented immediately: everything in phases 1 and 2. Requires more data or time: forward expectations and revisions (phase 3 archive or a paid source), historical option backtests (paid history, or labeled model estimates), industry pricing (paid), and any VALIDATED label (phase 4 on data not yet used).

## 6. Smallest useful version: holdings monitor

**Input** `data/user/holdings.json` (the user fills it in; nothing is assumed):

```json
{
  "budget": {"giveback_pct": 0.25, "window_days": 63, "reset": "2026-07-01"},
  "lots": [
    {"ticker": "AAPL", "shares": 100, "cost": 150.00, "acquired": "2023-05-01"},
    {"ticker": "SNDK", "shares": 50, "cost": 40.00, "acquired": "2025-03-10"}
  ],
  "willing_to_sell": {"AAPL": 0.5, "SNDK": 1.0}
}
```
(The numbers above are HYPOTHETICAL EXAMPLES of the format.)

**Command** `python -m mcl holdings` prints one card per holding and a portfolio page:
* Position: shares, basis, value, unrealized gain, peak value since reset, giveback used versus budget, price at which the budget runs out, tax term per lot.
* Price state: drawdown from the 52 week high, current streak versus each average with its percentile and the next 3/5/10 session outcomes of comparable streaks (ASSOCIATION, with n).
* Earnings: next report date and timing, sessions to go, the stock's lead in pattern for that fiscal quarter, historical one night gap distribution, and whether one 90th percentile gap would use up the budget.
* Valuation: current multiple and its percentile (first reported or as of basis, per `MCL_FUNDAMENTALS`).
* Protection: today's chain for the next two monthly expirations after earnings and before them; for 3 call strikes, 1 put, 1 collar, at 25/50/100% coverage: premium, effective sale price, downside left, upside given up, qualified covered call status, short or long term on assignment.
* Portfolio: holdings that report within the same 10 sessions; downside correlation pairs above 0.7; dollar loss in two stated scenarios.

Everything in this MVP runs on free data that the system already verifies. None of it says what to do; it shows the position, the comparables and the prices of each choice.

## 7. Tax rules that shape protection choices

Statutory text retrieved from the U.S. Code (links below). Treasury Regulations were not retrievable in this session, so regulation level details (for example how assignment folds the premium into the sale price) are marked "to confirm". This is information, not tax advice; confirm with a tax professional before acting.

* **Qualified covered calls.** The straddle rules do not apply to stock plus covered calls that are exchange traded, written more than 30 days before expiration, and not deep in the money. "Deep in the money" means a strike below the lowest qualified benchmark, generally the highest listed strike below the prior close, with special rules for terms over 90 days, prices of $25 or less, and prices of $150 or less. ([IRC §1092(c)(4)](https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title26-section1092&num=0&edition=prelim))
* **In the money qualified calls.** When the strike is below the prior close, the stock's holding period stops counting while the call is open, and a loss on the call is long term if the stock would have been. ([IRC §1092(f)](https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title26-section1092&num=0&edition=prelim))
* **Premium on a call that expires or is bought back** is short term capital gain or loss for the writer. ([IRC §1234(b)](https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title26-section1234&num=0&edition=prelim)) On assignment, the premium is treated as part of the stock's sale price (to confirm in Treas. Reg. §1.1234-1).
* **Collars and constructive sales.** A short sale, offsetting notional principal contract or forward on appreciated stock is a constructive sale; other positions with substantially the same effect count only to the extent regulations prescribe. A tight collar should be reviewed before use. ([IRC §1259](https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title26-section1259&num=0&edition=prelim))
* **Reentry after a loss sale.** A loss is disallowed if substantially identical stock, or a contract or option to acquire it, is bought within 30 days before or after the sale; the reentry rules in M12 respect this window for lots sold at a loss. ([IRC §1091](https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title26-section1091&num=0&edition=prelim))

## 8. Case studies: AAPL and SNDK

Pending: verified figures from `python scripts/case_study_facts.py AAPL SNDK` are being collected and will replace this line.

## 9. Open questions for the user

* Holdings file contents (tickers, lots, basis, dates) and the giveback budget (share of peak profit, window).
* Willingness to sell per holding (sets call coverage and strikes).
* Whether to pay for any data: consensus history (expectations, revisions), option history (exact backtests), industry pricing (memory cycle). Each unlocks a specific part of the plan; none is needed for the MVP.

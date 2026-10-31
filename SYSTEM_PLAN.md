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
* **Surprise versus usual (P1.1).** surprise = (actual − estimate) / |estimate|; surprise_vs_usual = (surprise − median of the prior 8 surprises) / MAD of the prior 8, using only reports before this one. "Smaller beat than usual" = surprise > 0 and surprise_vs_usual below −1. Because a percentage surprise explodes when the estimate is near zero (SNDK, August 2025: +867%), the same measures are also computed on surprise in price terms, (actual − estimate) / share price before the report. Revenue surprise and guidance versus consensus join when the data exists (below).
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

**Source of every number here:** `python scripts/case_study_facts.py AAPL SNDK` plus a follow up query, run 2026-10-31 on commit 18480df with data through the 2026-10-30 close: Yahoo daily bars (split adjusted closes), SEC EDGAR company facts and submissions, SEC 8-K Item 2.02 acceptance times. Rerun the script to reproduce or update. Returns are close to close; "t0" is the first session that could react (next session for an after close report).

### 8.1 AAPL: verified facts

* **History used:** 2005-01-03 to 2026-10-30, 5,492 sessions. Last close $344.63; 252 session closing high $348.91; 1.2% below it.
* **Splits (Yahoo):** 2 for 1 on 2005-02-28, 7 for 1 on 2014-06-09, 4 for 1 on 2020-08-31.
* **Fiscal year (SEC):** CIK 320193, fiscal year end listed as 09/26 (52/53 week year ending late September). Fiscal Q1 = October to December.

**Last 8 fiscal quarters, as first reported ($M; EPS diluted)**

| Quarter end | Fiscal | Revenue | Net income | EPS | Quarter source | Filed |
|---|---|---|---|---|---|---|
| 2024-09-28 | FY2024 Q4 | 94,930 | 14,736 | (not reported for Q4 alone) | FY minus 9M | 2024-11-01 |
| 2024-12-28 | FY2025 Q1 | 124,300 | 36,330 | 2.40 | 10-Q | 2025-01-31 |
| 2025-03-29 | FY2025 Q2 | 95,359 | 24,780 | 1.65 | 10-Q | 2025-05-02 |
| 2025-06-28 | FY2025 Q3 | 94,036 | 23,434 | 1.57 | 10-Q | 2025-08-01 |
| 2025-09-27 | FY2025 Q4 | 102,466 | 27,466 | (not reported for Q4 alone) | FY minus 9M | 2025-10-31 |
| 2025-12-27 | FY2026 Q1 | 143,756 | 42,097 | 2.84 | 10-Q | 2026-01-30 |
| 2026-03-28 | FY2026 Q2 | 111,184 | 29,578 | 2.01 | 10-Q | 2026-05-01 |
| 2026-06-27 | FY2026 Q3 | 109,417 | 29,789 | 2.02 | 10-Q | 2026-07-31 |

**Earnings releases.** All 12 releases from 2023-11-02 to 2026-07-30 were 8-Ks accepted between 16:30:21 and 16:30:41 ET (after the close). Yahoo EPS surprise on those 12: 1.3% to 9.8%; median over all 87 past reports 4.5%, last 8 reports 4.1%. Yahoo lists the next report on 2026-11-02 with no time; this date is not confirmed by an Apple announcement in this data.

**Market cap milestones** (closing price × latest cover page share count filed on or before that day; split adjusted)

| Level | First intraday | First close | Close (unadjusted) × shares | Separate close crossings | After the first close: 5 / 20 / 60 / 120 sessions | Worst close within 120 sessions of the first intraday crossing |
|---|---|---|---|---|---|---|
| $1T | 2018-08-02 | 2018-08-02 | $207.39 × 4,829.9M (as of 2018-07-20) | 6 | +0.7% / +8.5% / +4.3% / −23.9% | −31.4% (2019-01-03) |
| $2T | 2020-08-19 | 2020-08-20 | $473.10 × 4,275.6M (as of 2020-07-17) | 10 | +5.7% / −9.7% / +0.8% / +14.3% | −7.7% (2020-09-18) |
| $3T | 2022-01-03 | 2023-06-30 | $193.97 × 15,728.7M (as of 2023-04-21) | 15 | −2.8% / +1.3% / −11.3% / +0.4% | −28.5% (2022-06-16); no close above the 2022-01-03 close until 2023-06-12 |
| $4T | 2025-10-28 | 2025-10-29 | $269.70 × 14,840.4M (as of 2025-07-18) | 8 | +0.2% / +2.9% / −4.2% / +1.4% | −8.3% (2026-03-30) |

What this does and does not show: the dates are VERIFIED. Two of four first crossings ($1T in 2018, $3T intraday in 2022) were followed by declines near 30% within 120 sessions; the other two by declines under 10%. Four events, with many repeated crossings around each level, are not a sample: whether a milestone says more than "a large rally to a new high at a high valuation" needs the matched control rallies in M6 (not yet run).

### 8.2 AAPL: first associations (in sample, not validated)

**Moving averages** (as of 2026-10-30; past streaks counted once each)

| Average | Now | Streak | Completed same side streaks: median / 90th pct / max | Share that reached today's length | Next 5 sessions after past streaks that reached it: median return (all same side days) / streak ended / drop larger than a typical move | n |
|---|---|---|---|---|---|---|
| 5 day | below, −0.3% | 1 | 3 / 7 / 20 | all | +0.3% (+0.6%) / 79% / 23% | 668 |
| 20 day | above, +0.7% | 21 | 6 / 35 / 85 | 22% | +1.5% (+0.9%) / 19% / 14% | 58 |
| 50 day | above, +3.5% | 37 | 6 / 59 / 187 | 18% | +0.9% (+0.8%) / 16% / 19% | 31 |
| 200 day | above, +16.2% | 149 | 20 / 273 / 551 | 29% | +1.6% (+0.8%) / 8% / 0% | 12 |

Reading: in AAPL's 2005 to 2026 history, streaks above the 20, 50 and 200 day averages that had already lasted as long as today's were not followed by weaker 5 session returns than the average day above. At 3 and 10 sessions the 50 day case was slightly weaker than its baseline (median −0.0% versus +0.4%; +1.2% versus +1.4%; n = 31); the 20 and 200 day cases were not. The streak alone did not clearly mark higher pullback risk at these horizons. Missing before this can be used: the "drop larger than a typical move" baseline for all same side days, the extension and earnings conditions (M5), and the out of sample test (M12).

**Earnings lead in versus reaction** (87 reports, 2005-01-12 to 2026-07-30)

| 20 session run up into the report (tercile) | n | Median run up | Median reaction (t0) | Share with a negative t0 | Median next 20 sessions |
|---|---|---|---|---|---|
| low | 29 | −4.7% | −0.7% | 55% | +3.2% |
| mid | 28 | +2.5% | +2.5% | 39% | +3.7% |
| high | 29 | +10.3% | +2.4% | 41% | +1.1% |

* Four combinations: rallied in and kept rising 33, rallied in then fell 23, fell in and kept falling 16, fell in then recovered 14 (1 unclassified).
* 62 reports beat by more than 2%; 25 of those (40%) still fell on t0.
* By fiscal quarter reported (73 reports since SEC data begins in 2008, about 18 each): the September quarter (fiscal Q4, reported late October or early November) has the only negative median reaction, −0.7%, against +0.9% to +2.8% for the others.
* Reading: for AAPL, a large run up was not followed by more frequent t0 declines than a moderate one (41% versus 39%); weak run ups were followed by declines more often (55%). With 28 to 29 reports per group the 95% intervals overlap, so neither direction is established.

**Smaller than usual beats, last 8 reports** (surprise compared with the median of the prior 8)

| Report | Surprise | Versus prior 8 median | Run up (20 sessions) | t0 | t0 versus SPY | Next 20 sessions |
|---|---|---|---|---|---|---|
| 2024-10-31 | 2.1% | −2.0 pts | +0.1% | −1.3% | −1.8% | +7.5% |
| 2025-01-30 | 2.1% | −2.0 pts | −5.8% | −0.7% | −0.1% | +0.9% |
| 2025-05-01 | 1.9% | −2.3 pts | −4.7% | −3.7% | −5.2% | −1.8% |
| 2025-07-31 | 9.8% | +6.8 pts | −2.3% | −2.5% | −0.9% | +14.7% |
| 2025-10-30 | 4.5% | +1.6 pts | +5.6% | −0.4% | −0.7% | +4.7% |
| 2026-01-29 | 6.4% | +3.4 pts | −5.4% | +0.5% | +0.8% | +2.0% |
| 2026-04-30 | 3.6% | +0.3 pts | +6.2% | +3.2% | +3.0% | +9.3% |
| 2026-07-30 | 6.9% | +2.8 pts | +13.3% | −7.4% | −8.1% | +3.5% |

Eight reports are anecdotes, not evidence: the three smaller than usual beats all fell on t0, but so did three of the five larger than usual beats, including the largest t0 drop (−7.4% on 2026-07-31 after a 13.3% run up into a 6.9% beat).

### 8.3 SNDK: verified facts and why most statistics are not possible yet

* **Company (SEC):** Sandisk Corp, CIK 2023554, Form 10 registration (10-12B) filed 2024-11-25, amended 2025-01-27; fiscal year end listed as 06/28 (52/53 week year ending late June or early July). No predecessor CIK is merged: the old SanDisk (acquired by Western Digital in 2016) is a different company.
* **Trading history:** Yahoo bars start 2025-02-13, but volume was 0.2M to 1.3M shares a day until 33.8M on 2025-02-24; the first 7 sessions look like when issued trading, so regular way history starts 2025-02-24 (the exact first regular way date should be confirmed in the company's filings). 431 sessions in total; no splits.
* **Price:** closing high $2,335.00 on 2026-06-25; last close $1,150.89 on 2026-10-30, 50.7% below it, 89 sessions after the high. The 2026-10-30 close was the first close below the 200 day average in its trading history (1 crossing, 99.6% of days above).

**Fiscal quarters, as first reported ($M)**

| Quarter end | Fiscal | Revenue | Net income | EPS | Filed |
|---|---|---|---|---|---|
| 2024-12-27 | FY2025 Q2 | 1,876 | 104 | 0.72 | 2025-03-07 |
| 2025-03-28 | FY2025 Q3 | 1,695 | −1,933 | −13.33 | 2025-05-12 |
| 2025-06-27 | FY2025 Q4 | 1,901 | −23 | (FY minus 9M) | 2025-08-21 |
| 2025-10-03 | FY2026 Q1 | 2,308 | 112 | 0.75 | 2025-11-07 |
| 2026-01-02 | FY2026 Q2 | 3,025 | 803 | 5.15 | 2026-01-30 |
| 2026-04-03 | FY2026 Q3 | 5,950 | 3,615 | 23.03 | 2026-05-01 |
| 2026-07-03 | FY2026 Q4 | 8,965 | 6,903 | (FY minus 9M) | 2026-08-17 |
| 2026-10-02 | FY2027 Q1 | 11,031 | 8,101 | 52.60 | 2026-10-30 |

Last four quarters: revenue $28,971M, net income $19,422M (67% of revenue).

**Every report since the listing** (all 8-Ks accepted 16:07 to 16:14 ET, after the close)

| Report | EPS estimate / actual | Surprise | Run up (20 sessions) | Gap | t0 | t0 versus SMH | Next 5 sessions | Next 20 sessions |
|---|---|---|---|---|---|---|---|---|
| 2025-05-07 | −0.39 / −0.30 | +23% | +8.1% | 0.0% | +4.8% | +4.0% | +10.6% | +6.8% |
| 2025-08-14 | 0.03 / 0.29 | +867% | +12.4% | −7.8% | −4.6% | −2.5% | +4.1% | +102.3% |
| 2025-11-06 | 0.89 / 1.22 | +37% | +60.2% | +0.4% | +15.3% | +16.2% | +6.1% | −5.9% |
| 2026-01-29 | 3.54 / 6.20 | +75% | +124.5% | +20.8% | +6.9% | +10.2% | +3.8% | +7.4% |
| 2026-04-30 | 14.66 / 23.41 | +60% | +58.3% | −3.4% | +8.3% | +7.6% | +31.6% | +48.4% |
| 2026-08-05 | 34.52 / 39.25 | +14% | −21.8% | −13.1% | −6.8% | −7.1% | +21.4% | +23.6% |
| 2026-10-29 | 46.41 / 49.51 | +7% | −25.6% | −8.6% | −13.5% | −6.5% | (not yet) | (not yet) |

Yahoo lists the next report on 2027-02-15 (an estimate, no time).

**What the SNDK data can and cannot say**
* VERIFIED: of the five reports since November 2025, the two smallest beats (+14% and +7%, against a median of 37% for all seven) were the only ones with negative t0 reactions, and the closing high (2026-06-25) came about six weeks before the first of them. The August 2025 report also fell (−4.6%) despite a +867% surprise: a percentage surprise on an estimate near zero says little, so M2 also measures surprise in dollars per share relative to the share price.
* Not evidence: seven reports cannot separate "smaller beat than usual" from "falling into the report" (both August and October came after declines of more than 20% in 20 sessions), and after the August report the stock rose 21% in 5 sessions anyway.
* Moving average statistics for SNDK rest on 1 to 2 past streaks (20 day: 2; 50 day: 1; 200 day: 0) and are not reported as findings.
* The cycle question (P1.3) is live: profits rose from about 0 to $8.1B a quarter within a year. Whether today's multiple reflects peak profits needs the cycle module with proxies whose histories cover full memory cycles (Micron, Yahoo history from 2005; Western Digital, which held the flash business until the spin off) and industry pricing. Proxy results will be labeled as proxies, never as SNDK's own history.

### 8.4 Hypotheses register

| Hypothesis (from the user unless noted) | Label now | What the data shows so far | Next step |
|---|---|---|---|
| A habitual big beater that delivers a smaller beat gets sold | HYPOTHESIS | consistent anecdotes in SNDK (2 of 2) and AAPL (3 of 3 smaller beats fell, but 3 of 5 larger ones did too) | M2 surprise versus usual across many companies; needs timestamped consensus for a clean test |
| Big run ups into earnings lead to more frequent post report declines | ASSOCIATION, not supported for AAPL | 41% (high run up) versus 39% (mid) versus 55% (low) negative t0 | same table across the watchlist; split by result and guidance |
| A long streak above a moving average raises pullback risk | ASSOCIATION, not clearly supported for AAPL | 20 and 200 day: conditional medians at or above the same side baseline at 3, 5 and 10 sessions; 50 day: slightly below at 3 and 10 sessions (n = 31) | add extension and earnings conditions; M12 |
| Crossing a market cap milestone precedes drawdowns (AAPL $1T, $2T, $3T) | dates VERIFIED; effect untested | 2 of 4 first crossings followed by about −30% within 120 sessions, 2 of 4 by under −10% | matched control rallies (M6) |
| A low multiple at a profit peak is a trap for cyclicals (added for SNDK) | HYPOTHESIS | SNDK profit growth is extreme; no cycle history of its own | M3 cycle module with labeled proxies |
| Good news stops being rewarded near tops (P1.2) | HYPOTHESIS | SNDK peak preceded two weakly received beats | reaction quality flags and lead times (M2, M8) |

## 9. Open questions for the user

* Holdings file contents (tickers, lots, basis, dates) and the giveback budget (share of peak profit, window).
* Willingness to sell per holding (sets call coverage and strikes).
* Whether to pay for any data: consensus history (expectations, revisions), option history (exact backtests), industry pricing (memory cycle). Each unlocks a specific part of the plan; none is needed for the MVP.

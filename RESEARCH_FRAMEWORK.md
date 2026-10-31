# Research framework

How each question is turned into something countable, tested, and scored. Every study follows the same five steps.

1. **Define the situation precisely.** A situation is an event stamped on the first day it was knowable (for example "the first close 25% above a confirmed swing low"), not on a date picked with hindsight.
2. **Record what was known that day.** Features use only data up to that day: trend, momentum, volume, volatility, valuation percentile versus history to date, relative strength, market regime.
3. **Score what happened next.** Outcomes use the days after: which comes first (a favorable move or an adverse one), how far, how long, and the worst drawdown endured first (MAE).
4. **Count hits AND failures.** Every table shows n, hits, fails, hit rate with a 95% interval, the base rate it must beat, typical and extreme outcomes, and the outcome when it failed.
5. **Test it on later data.** Cutoffs are learned on the earlier period and applied unchanged to the later period. A pattern that only works in the period it was found in gets no credit.

## Evidence grade

| Grade | Rule |
|---|---|
| A | 30+ independent events, interval excludes the base rate, held out of sample |
| B | 20+ independent events, and either the interval excludes the base rate or it held out of sample |
| C | 10+ independent events, no clear separation |
| Insufficient | fewer than 10 independent events |

"Independent" means non overlapping. Twelve monthly samples of a 12 month return are one event, not twelve. Tables show `n` and `n_eff` side by side and grade on `n_eff`. When many conditions are scanned at once, Benjamini Hochberg q values flag the ones likely to be luck.

## The 12 areas

### 1. Drawdowns and recoveries (`analytics/drawdowns.py`)
* **Extended downturn**: all time closing high until price closes back at or above it. One downturn, however many legs.
* **Swing selloff**: a zigzag decline of at least X% (5, 10, 20%). A bounce smaller than X% does not split it.
* Each selloff is tagged with the downturn it belongs to, its leg number inside it, and whether it started near a high or inside an existing downturn. That separates new selloffs from repeat declines.
* Measured: depth, bars to reach 5/10/20/30%, bars to trough, bars to recover, total duration, per year counts, largest intra year decline vs calendar year return.

### 2. Patterns through the year (`analytics/seasonality.py`)
* Month and quarter tables, hit rates with intervals, the specific years each month failed, last 5 years vs full history, excess return vs SPY for sectors and stocks.
* **Walk forward**: each year is predicted from earlier years only, and accuracy is compared with simply calling the usual direction. Markets rise in most months, so 60% accuracy can be zero edge.
* Earnings season phases: pre season, peak season (10 to 45 days after quarter end), off season.

### 3. Earnings behavior (`analytics/earnings.py`)
* Reaction day from report timing: after the close means the next session; before the open means the same day. Timing comes from SEC 8-K acceptance times, EPS estimate and actual from Yahoo.
* Windows: 5/10/20 day run up into the report, overnight gap, reaction day, 1 to 60 day drift after, excess vs SPY.
* Recovery: share of reaction day drops regained within 20 sessions, sessions to regain, share of pops that faded.
* **What was priced in**: reaction by result (beat, inline, miss) crossed with how strongly the stock ran into the report, and by valuation percentile going in. Guidance is not available as free structured data; add a `guidance` column to condition on it.

### 4. Valuation vs own history (`analytics/valuation.py`)
* Fundamentals from SEC XBRL with filing dates. A quarter is usable the day after it was filed. Restatements are ignored in favor of the first filed value, which is what investors saw.
* Multiple chosen by business type: P/E for steady earners, EV/Sales when earnings are often negative, P/B for financials, P/FCF for real estate. All are computed; the default can be switched.
* Bands are expanding percentiles, so each day compares only with prior history.
* Multiples at every swing peak and trough; clusters of peaks at the same multiple ("stalled near 32x four times") are flagged as ceilings, clusters of troughs as floors.
* Today's multiple is regressed on revenue growth and operating margin over its own history: a premium the fundamentals do not explain is shown separately.

### 5. Valuation vs peers (`analytics/peers.py`)
* Premium or discount to the peer median every day, and where today's premium sits in its own history.
* Cross section fit of the multiple on growth and margin across peers: is the premium earned?
* **Cheap vs value trap**: valuation percentile crossed with fundamental momentum (revenue growth accelerating or decelerating), scored by the next 6 months' returns.
* Peers default to the same GICS sub industry in the S&P 500. Override in `data/user/peers.json`.

### 6. Rally exhaustion (`analytics/events.py: rally_checkpoints`)
* Event: the first day a rally from a confirmed swing low reaches +15%, +25%, +40%.
* Outcome: does it gain another 10% before a 10% pullback?
* Distribution of completed rally sizes and durations, and "of rallies that got this far, how many went 10% further".
* Features compared between rallies that continued and those that stalled: speed, volume ratio, volatility, RSI, distance from the 52 week high, valuation percentile, relative strength, market regime.

### 7. Selling exhaustion (`analytics/events.py: selloff_checkpoints`)
* Event: the first day a decline from a confirmed swing high reaches 15%, 25%, 35%.
* Outcome: another 10% down before a 15% rebound? Additional downside to the eventual low and sessions until it.

### 8. Bounce vs recovery, pullback vs downturn (`bounce_events`, `pullback_events`)
* Bounce: a 10% rally off a low that is at least 20% below the 1 year high. Sustained if it recovers half the drawdown before a new low.
* Pullback: an 8% decline from a swing high while the 200 day average is rising. Normal if it makes a new high before falling 20%.

### 9. Market, sector, industry, stock (`analytics/relative.py`)
* Additive log return attribution over 1, 3, 6, 12 months: market + sector vs market + industry vs sector + company specific = total. Answers which layer drove the move.
* Behavior in every market selloff: return, max drawdown, beta adjusted excess, whether its low came before the market's, and what it did in the 3 months after.

### 10. Conditions (`analytics/regimes.py`)
* Market trend (above a rising 200 day average, below a falling one, or sideways), VIX regime, 10 year yield direction, breadth (% of names above 50 and 200 day averages, new highs and lows).
* Every event table is split by these, so a pattern that only works in one regime is visible.
* Breadth signals: narrow rally (index near its high while participation falls) and repair divergence (index near its low while participation recovers).
* Survivorship: breadth from today's index members overstates past breadth. Sector ETF breadth is coarse but free of that bias.

### 11. Evidence, probabilities, failures (`analytics/evidence.py`)
Covered by the five steps and grade above.

### 12. Dashboard, watchlist, analogs (`app/dashboard.py`, `analytics/analogs.py`, `analytics/state.py`)
* Phase label from transparent rules: early recovery, uptrend, extended, stalling, pullback in uptrend, downtrend, late selloff, range.
* Alerts cite their basis ("larger than 82% of 17 completed rallies").
* Analogs: the past dates whose feature percentiles were closest to today, at least a month apart, with their outcome windows finished before today. Compared with the base rate of all eligible dates.

## Known limits
* Yahoo prices are split adjusted; the `adj_close` column is also dividend adjusted. Valuation uses the split adjusted close with share counts converted to the same basis.
* SEC XBRL starts around 2009 to 2011 for most companies, so valuation history is about 15 years at most. Banks and insurers report revenue differently; P/B is the default there.
* Each quarter takes the value investors could first see: a reported three month value or full year minus nine months, whichever was filed first, and across tags the earliest filing wins (when companies switched to the ASC 606 revenue tag in 2018 they re-tagged two prior years with restated values, which would otherwise replace what was first reported). A 10-K quarterly table that does not add up to that 10-K's own year is ignored (Amazon's FY2012 10-K mis-tagged Q4 2012 revenue as 17,431M; the year implies 21,268M). Restatements are not applied back, so TTM rows that straddle one mix old and new accounting until the old quarters roll off; `python -m mcl verify` lists those years.
* Share counts come from the cover page of each 10-Q or 10-K, matched to the quarter by filing date so no later count leaks in. Multi class companies sometimes put only one class on the cover; `python -m mcl verify` flags those quarters against diluted weighted shares.
* 8-K earnings releases are dated and timed by SEC acceptance time, which the feed gives in UTC and the tool converts to US Eastern. Acceptance can only trail the press release, so an 8-K accepted during market hours takes Yahoo's before open / after close call, and an 8-K 1 to 3 days off Yahoo's report date is treated as a different Item 2.02 event (Yahoo's date stands). Other 2.02 filings (guidance cuts, pre-announcements, recasts) are tagged and left out of the earnings studies. `python -m mcl verify` lists every disagreement.
* The free S&P 500 table lists current members only (survivorship). Sector and industry ETF studies avoid that.
* Estimates history (revisions, guidance) is not free. The tool keeps those as optional columns.
* Analogs and conditional tables describe the past. They do not forecast; they say how often something happened, with how much pain, in how many independent cases.

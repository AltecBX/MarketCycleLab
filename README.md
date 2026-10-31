# MarketCycleLab

Evidence based cycle research for the market, sectors, industries and single stocks: drawdowns, seasonality, earnings behavior, valuation vs own history and peers, rally and selloff exhaustion, bounce vs recovery, relative strength, market regimes, and similar past situations. Every pattern is reported with its count, hit rate, failures, interval, and an out of sample check.

See `RESEARCH_FRAMEWORK.md` for definitions and rules, and `reports/market_study.md` for the first real data results.

## Setup (Mac)

```bash
git clone https://github.com/AltecBX/MarketCycleLab.git && cd MarketCycleLab
```

```bash
python3 -m venv .venv && source .venv/bin/activate
```

```bash
pip install -r requirements.txt
```

SEC requires a contact in the request header. Prices work without it; fundamentals and exact earnings timing need it.

```bash
export MCL_SEC_USER_AGENT="Your Name your@email.com"
```

## Use

Dashboard (pick Live or Demo in the sidebar):

```bash
streamlit run app/dashboard.py
```

One ticker, full HTML report in `reports/`:

```bash
python -m mcl study NVDA
```

Watchlist scan (phase and alerts for each name; edit `data/user/watchlist.json`):

```bash
python -m mcl scan
```

Long run S&P 500 study (no API keys needed):

```bash
python -m mcl market
```

Tests:

```bash
python -m pytest -q
```

## Data sources

| Data | Source | Notes |
|---|---|---|
| Daily OHLCV, splits, dividends | Yahoo via yfinance | `close` split adjusted; `adj_close` also dividend adjusted |
| Quarterly fundamentals | SEC EDGAR XBRL company facts | first filed value per period, usable the day after filing |
| Earnings dates and timing | SEC 8-K Item 2.02 acceptance time | joined to Yahoo EPS estimate and actual |
| VIX | Yahoo `^VIX`, fallback CBOE file mirror | |
| 10 year yield | FRED DGS10, fallback Yahoo `^TNX`, fallback monthly mirror | |
| Long run S&P 500, CAPE | Shiller data (datahub mirror) | monthly averages; earnings and CAPE end 2023 in the mirror |
| Sector, sub industry, peers | S&P 500 GICS table (datahub mirror) | current members only |

Own data: drop `data/user/prices/<TICKER>.csv` (Date, Open, High, Low, Close, Volume) to override Yahoo, for example a sheet built with `GOOGLEFINANCE("NVDA","all",DATE(2015,1,1),TODAY())` saved as CSV.

## Layout

```
mcl/analytics   drawdowns, swings, seasonality, earnings, valuation, peers, relative,
                regimes, events, evidence, analogs, state
mcl/data        yahoo, sec, macro, universe, loader, demo (synthetic), store (cache)
mcl/report      charts (plotly), html (single file report)
mcl/study.py    runs every study for one ticker; used by dashboard, report and CLI
app/            Streamlit dashboard
tests/          known answer tests, SEC parsing fixtures, no lookahead property tests
```

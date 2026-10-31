# MarketCycleLab

Evidence based cycle research for the market, sectors, industries and single stocks: drawdowns, seasonality, earnings behavior, valuation vs own history and peers, rally and selloff exhaustion, bounce vs recovery, relative strength, market regimes, and similar past situations. Every pattern is reported with its count, hit rate, failures, interval, and an out of sample check.

See `RESEARCH_FRAMEWORK.md` for definitions and rules, `reports/market_study.md` for the first real data results, and `SYSTEM_PLAN.md` for the plan that extends the research into hold, reduce, protect and reenter decisions (with the AAPL and SNDK case studies, reproducible with `python scripts/case_study_facts.py AAPL SNDK`).

## Setup (Mac)

Needs Python 3.10 or newer; 3.12 is what CI tests. Check with `python3 --version`. If it is older, install 3.12 with Homebrew:

```bash
brew install python@3.12
```

```bash
git clone https://github.com/AltecBX/MarketCycleLab.git && cd MarketCycleLab
```

```bash
python3.12 -m venv .venv && source .venv/bin/activate
```

```bash
pip install -U pip && pip install -r requirements.txt
```

SEC requires a contact in the request header. Prices work without it; fundamentals and exact earnings timing need it. Add it to `~/.zshrc` once so every new Terminal window has it:

```bash
echo 'export MCL_SEC_USER_AGENT="Your Name your@email.com"' >> ~/.zshrc && source ~/.zshrc
```

Preflight. Checks Python, packages, the SEC header, certificates, and one request each to SEC, Yahoo, FRED and the GitHub mirrors. Every failed line prints its fix:

```bash
python -m mcl doctor
```

Each new Terminal session: `cd MarketCycleLab && source .venv/bin/activate`.

## Use

Dashboard (opens http://localhost:8501; pick Live or Demo in the sidebar):

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

Check the SEC fundamentals before trusting a valuation study (details below):

```bash
python -m mcl verify AAPL MSFT NVDA JPM XOM
```

Tests:

```bash
python -m pytest -q
```

## Verifying SEC fundamentals

Valuation uses quarters rebuilt from SEC XBRL facts. A quarter is the three month value when the 10-Q has one, otherwise a difference of year to date values (Q4 = full year minus nine months). `python -m mcl verify` checks that reconstruction per ticker, prints a summary, and writes every compared number to `reports/verify_<TICKER>.csv` with a link to the filing. With no tickers it runs the stocks in the watchlist.

| Check | What it compares | How to read it |
|---|---|---|
| fiscal_years | Q1+Q2+Q3+Q4 vs the 10-K full year value | WARN "restatement mix" = the first filed quarters straddle a restatement but add up to some filed version of the year; the parser is fine and TTM rows with those quarters mix old and new accounting until they roll off. FAIL = the quarters match no filed version of the year: open the filing. Rows marked "by construction" (cash flow, year to date only) cannot fail. |
| yahoo | each quarter Yahoo shows vs the first filed and the latest filed SEC value | ok = first filed matches. info = only the restated value matches, expected. WARN when the revenue gap equals Yahoo's unusual items (Yahoo leaves one time gains out of revenue). FAIL on revenue or net income = open the filing. Definitions differ for banks (total net revenue) and for energy companies whose `Revenues` tag is total revenues and other income. |
| restated | quarters changed in a later filing | Studies use the first value, which is what investors saw. Vendors show the latest. |
| integrity | missing quarters, negative revenue, revenue 2x off its neighbors, late first filings | Gaps blank out TTM multiples for a year. |
| shares | cover page shares vs latest filed diluted weighted shares, quarter to quarter jumps | A WARN near 0.3x to 0.6x usually means a multi class company where only one class is on the cover; market cap and every multiple are off for those rows. Convertibles can push diluted shares 15%+ above the cover count. A 1,000x gap is a units error in an old filing (info). |
| earnings | 8-K Item 2.02 dates and before open / after close timing vs Yahoo | Low agreement means the acceptance time reading is wrong for that company. extra_8k rows are 2.02 filings with no report near them. |

A ticker that moved under a new holding company gets a new SEC CIK with only a few quarters (`integrity` warns). Its history stays under the old CIK: add `{"TICKER": [old CIK]}` to `data/user/cik_predecessors.json` and the two are merged. XOM (ExxonMobil Holdings Corp, 2026) is built in.

The spot check at the end of each ticker lists the last four quarters of revenue and net income with the filing folder link: open it, open the 10-Q or 10-K, and compare with the income statement. Tolerance is 0.5% or $2M, whichever is larger. The command exits with code 1 when any check has a FAIL.

## Fundamentals basis

Two ways to treat restatements in every valuation study. Pick one in the dashboard sidebar ("Fundamentals"), with `--basis` on `study`, `scan` and `fetch`, or for everything with `export MCL_FUNDAMENTALS=asof`.

| Basis | What each day uses | Trade off |
|---|---|---|
| `first` (default) | each quarter as first reported, kept forever | never changes once filed; around a restatement the TTM mixes old and new accounting until the old quarters roll off |
| `asof` | trailing twelve months rebuilt on every 10-Q, 10-K or amendment from what had been filed by then: the 10-K year, or prior year minus prior year to date plus year to date | a restatement counts from the day after it was filed, as investors saw it (JPMorgan's 10-Q/A of 2012-08-09 lowers TTM net income by 459M from 2012-08-10) |

Neither basis looks ahead: a value is usable the day after the filing that contains it. Without restatements the two give identical TTM figures; `python -m mcl verify` lists every period where they differ and the filing that caused it.

```bash
python -m mcl study JPM --basis asof
```

## Troubleshooting (Mac)

| Symptom | Fix |
|---|---|
| `CERTIFICATE_VERIFY_FAILED` | Python from python.org ships without certificates. The tool retries with the `certifi` bundle automatically; to fix it for everything, run `/Applications/Python 3.12/Install Certificates.command`. |
| SEC returns 403 | `MCL_SEC_USER_AGENT` missing or not "Name email". If it is set, SEC may have rate limited the IP for about 10 minutes. The tool stays under 8 requests per second. |
| `YFRateLimitError` or empty Yahoo data | Yahoo throttles bursts. Wait a few minutes; prices are cached 12 hours in `data/cache/`, so repeats do not refetch. `pip install -U yfinance` if Yahoo changed something. |
| Dashboard errors on `width="stretch"` | Streamlit older than 1.51. `pip install -U -r requirements.txt`. |
| Stale numbers | Delete `data/cache/` (or one subfolder, e.g. `data/cache/fundamentals/`) to force a refetch. |

## Data sources

| Data | Source | Notes |
|---|---|---|
| Daily OHLCV, splits, dividends | Yahoo via yfinance | `close` split adjusted; `adj_close` also dividend adjusted |
| Quarterly fundamentals | SEC EDGAR XBRL company facts | first filed value per period, usable the day after filing |
| Earnings dates and timing | SEC 8-K Item 2.02 acceptance time (UTC, converted to Eastern) | joined to Yahoo EPS estimate and actual; Yahoo's date and timing win where the 8-K is a different event or was accepted during market hours |
| VIX | Yahoo `^VIX`, fallback CBOE file mirror | |
| 10 year yield | FRED DGS10, fallback Yahoo `^TNX`, fallback monthly mirror | |
| Long run S&P 500, CAPE | Shiller data (datahub mirror) | monthly averages; earnings and CAPE end 2023 in the mirror |
| Sector, sub industry, peers | S&P 500 GICS table (datahub mirror) | current members only |

Own data: drop `data/user/prices/<TICKER>.csv` (Date, Open, High, Low, Close, Volume) to override Yahoo, for example a sheet built with `GOOGLEFINANCE("NVDA","all",DATE(2015,1,1),TODAY())` saved as CSV.

## Layout

```
mcl/analytics   drawdowns, swings, seasonality, earnings, valuation, peers, relative,
                regimes, events, evidence, analogs, state
mcl/data        yahoo, sec, macro, universe, loader, demo (synthetic), store (cache), http
mcl/report      charts (plotly), html (single file report)
mcl/study.py    runs every study for one ticker; used by dashboard, report and CLI
mcl/verify.py   SEC fundamentals checks (python -m mcl verify)
mcl/doctor.py   live data preflight (python -m mcl doctor)
app/            Streamlit dashboard
scripts/        case_study_facts.py (verified facts for case studies)
tests/          known answer tests, SEC parsing fixtures, no lookahead property tests
```

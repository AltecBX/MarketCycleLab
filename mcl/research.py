"""Research website data: python -m mcl research [TICKERS ...]

Writes JSON row files for a static website (names in FILES). Every file is a
JSON array of row objects; numbers are finite or null, dates are ISO, and
missing data stays null (nothing is filled, interpolated or invented).

The computation functions take plain frames, so `build_from_frames` runs the
whole pipeline offline on synthetic data; `build` loads Yahoo and SEC data and
then calls it.

Conventions
* Sessions are the rows of the price frame. No rows are created for weekends
  or holidays.
* Report timing: before the open and during market hours react on the report
  date, after the close on the next session (analytics.earnings.reaction_index).
  Unknown timing is never guessed: its one day reaction is left null.
* Returns are price returns of split adjusted closes (dividends excluded).
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

import numpy as np
import pandas as pd

from .analytics import streaks
from .analytics.earnings import reaction_index
from .config import HISTORY_START, ROOT, USER_DIR
from .holdings import _day, _num

BENCHMARKS = ["SPY", "QQQ", "IWM"]
SECTOR_FUNDS = ["XLK", "XLF", "XLV", "XLE", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC"]
MAS = (5, 20, 50, 200)
COND_MAX_LEN = 60
PRICE_YEARS = 15            # weekly price rows kept for charts (statistics use all history)
EARN_PATH_YEARS = 10.5      # report windows kept (the website's longest choice is 10 years)
THRESHOLDS = (0.10, 0.20, 0.30, 0.40)
COST_PER_TRADE = 0.001          # 0.10% per position change
LARGE_DROP = -0.25
MAX_BYTES = 8_000_000
CONFIRMATIONS = ROOT / "data" / "confirmed_report_dates.json"
SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
DEFAULT_OUT = USER_DIR / "research_web"
EPS_TOL_DAYS = 3
FISCAL_WINDOW_DAYS = 120
QUARTER_STEP_DAYS = 91

TIMING_TEXT = {"bmo": "before the open", "amc": "after the close", "dmh": "during market hours", "unknown": "unknown"}
EPS_SOURCE = "Yahoo (adjusted EPS as Yahoo reports it; consensus is Yahoo's EPS estimate)"
LARGE_DROP_NOTE = "possible corporate action or news, check before treating as a market decline"
KNOWN_NOTES = {
    "SNDK": ("Standalone Sandisk listed 2025-02 after separating from Western Digital; the old SanDisk (acquired by "
             "Western Digital in 2016) is a different company and is not spliced in."),
    "WDC": ("Sandisk separation completed 2025-02-24; check whether prices around that date are adjusted before reading "
            "that drop as a market decline."),
}
KNOWN_EVENTS = {"WDC": "2025-02-24"}

PROVIDERS = {
    "price_provider": "Yahoo Finance via yfinance (split adjusted daily closes)",
    "timing_provider": "SEC EDGAR 8-K Item 2.02 acceptance times, Yahoo where SEC is unavailable",
    "eps_provider": "Yahoo earnings dates (adjusted EPS and consensus as Yahoo reports them)",
    "fundamentals_provider": "SEC EDGAR XBRL company facts, first reported",
}

FILES = {
    "universe": "research_universe.json",
    "coverage": "research_coverage.json",
    "prices": "research_prices.json",
    "earnings": "research_earnings.json",
    "earn_paths": "research_earn_paths.json",
    "earn_summary": "research_earn_summary.json",
    "ma": "research_ma.json",
    "ma_cond": "research_ma_cond.json",
    "drawdowns": "research_drawdowns.json",
    "dd_summary": "research_dd_summary.json",
    "dd_years": "research_dd_years.json",
    "seasonality": "research_seasonality.json",
    "strategy": "research_strategy.json",
    "events": "research_events.json",
    "meta": "research_meta.json",
}


def known_etfs() -> set[str]:
    from .data import universe as u
    return (set(u.MARKET) | set(u.SECTOR_ETFS.values()) | {e for _, e in u.INDUSTRY_ETFS}
            | {"SLV", "GLD", "IAU", "TLT", "IEF", "HYG", "LQD", "VTI", "VOO", "IVV", "EFA", "EEM", "VEA", "VWO",
               "ARKK", "TQQQ", "SQQQ", "SOXL", "SOXS", "USO", "UNG", "GDXJ", "BITO", "IBIT"})


# ---------------------------------------------------------------- small helpers
def _px(x):
    """A price rounded to 4 decimals, keeping at least 4 significant digits for prices under $1."""
    v = _num(x, 12)
    if v is None or v == 0:
        return v
    return round(v, max(4, 3 - math.floor(math.log10(abs(v)))))


def _int(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return int(v) if np.isfinite(v) else None


def _clean(o):
    """Safety net for strict JSON: numpy scalars to Python, non-finite numbers to null, timestamps to ISO dates."""
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if o is None or o is pd.NaT or o is pd.NA:
        return None
    if isinstance(o, (bool, np.bool_)):
        return bool(o)
    if isinstance(o, (int, np.integer)):
        return int(o)
    if isinstance(o, (float, np.floating)):
        return float(o) if np.isfinite(o) else None
    if isinstance(o, pd.Timestamp):
        return _day(o)
    return o


def _on_or_before(idx: pd.DatetimeIndex, d) -> int | None:
    pos = int(idx.searchsorted(pd.Timestamp(d), side="right")) - 1
    return pos if pos >= 0 else None


def _before(idx: pd.DatetimeIndex, d) -> int | None:
    pos = int(idx.searchsorted(pd.Timestamp(d), side="left")) - 1
    return pos if pos >= 0 else None


def _timing_code(x) -> str:
    s = str(x if x is not None else "").strip().lower()
    if s in TIMING_TEXT:
        return s
    return {v: k for k, v in TIMING_TEXT.items()}.get(s, "unknown")


def period_complete(last_session, period_end, as_of=None) -> bool:
    """True when no session can still fall in the period that holds `last_session`.

    Complete when the next weekday after the last session is past the period end, or when `as_of` is past the
    period end and only a few days (a holiday) separate the last session from it.
    """
    last, end = pd.Timestamp(last_session).normalize(), pd.Timestamp(period_end).normalize()
    if last + pd.offsets.BDay(1) > end:
        return True
    return as_of is not None and pd.Timestamp(as_of).normalize() > end and (end - last).days <= 4


def clean_close(prices: pd.DataFrame, as_of=None) -> pd.Series:
    """Split adjusted daily closes, one per session, positive and finite, up to as_of."""
    if prices is None or "close" not in prices:
        raise ValueError("no close prices")
    idx = pd.DatetimeIndex(pd.to_datetime(prices.index))
    if idx.tz is not None:
        idx = idx.tz_localize(None)
    c = pd.Series(pd.to_numeric(prices["close"], errors="coerce").to_numpy(float), index=idx.normalize())
    c = c[~c.index.duplicated(keep="last")].sort_index()
    c = c[np.isfinite(c) & (c > 0)]
    if as_of is not None:
        c = c[c.index <= pd.Timestamp(as_of).normalize()]
    if c.empty:
        raise ValueError("no close prices up to the as of date")
    return c


# ---------------------------------------------------------------- universe
_KEEP = {"INC": "Inc", "CORP": "Corp", "CO": "Co", "LTD": "Ltd", "LLC": "LLC", "PLC": "PLC", "ETF": "ETF",
         "AG": "AG", "SA": "SA", "NV": "NV", "LP": "LP", "SE": "SE", "ADR": "ADR", "REIT": "REIT", "USA": "USA",
         "US": "US", "&": "&"}
_SMALL = {"OF", "THE", "AND", "FOR", "IN", "ON", "AT", "TO", "BY", "DE", "A"}


def _word(w: str, first: bool) -> str:
    pre, core, post = re.match(r"^([^\w&]*)(.*?)([^\w&]*)$", w).groups()
    if not core:
        return w
    if any(ch in pre + post for ch in "/\\"):
        out = core                                     # /DE/ and \\DE\\ state markers stay as filed
    elif core in _KEEP:
        out = _KEEP[core]
    elif (re.search(r"[\d/\\]", core) or ("&" in core and len(core) <= 5)
          or re.fullmatch(r"[A-Z](\.[A-Z])+", core)):
        out = core                                     # 3M, A/S, AT&T, S&P, U.S.
    elif not first and core in _SMALL:
        out = core.lower()
    elif len(core) <= 3 and not re.search(r"[AEIOUY]", core):
        out = core                                     # HP, CVS, PNC
    else:
        out = "-".join(p.capitalize() for p in core.split("-"))
    return pre + out + post


def readable_name(name) -> str:
    """'MICROSOFT CORP' -> 'Microsoft Corp'. Names that already have lower case letters are kept as filed."""
    s = " ".join(str(name or "").split())
    if not s or any(ch.islower() for ch in s):
        return s
    return " ".join(_word(w, i == 0) for i, w in enumerate(s.split(" ")))


def fetch_sec_tickers() -> dict:
    """SEC's company_tickers.json (needs MCL_SEC_USER_AGENT). Cached a day."""
    from .data import sec, store
    cached = store.load_json("sec", "company_tickers_full", 24)
    if cached:
        return cached
    raw = sec._get(SEC_TICKERS_URL)
    store.save_json(raw, "sec", "company_tickers_full")
    return raw


def universe_rows(raw, covered: dict[str, dict]) -> list[dict]:
    """Search list: SEC order (rank 0 = first), title cased names, then covered symbols missing from it."""
    etfs = known_etfs()
    rows, seen = [], set()
    if raw:
        entries = (sorted(raw.items(), key=lambda kv: int(kv[0]) if str(kv[0]).isdigit() else 0)
                   if isinstance(raw, dict) else list(enumerate(raw)))
        for pos, (_, v) in enumerate(entries):
            sym = str((v or {}).get("ticker") or "").strip().upper()
            if not sym or sym in seen:
                continue
            seen.add(sym)
            cov = covered.get(sym)
            if cov:
                name = cov.get("name") if cov.get("name") and cov.get("name") != sym else readable_name(v.get("title"))
                kind = cov.get("kind") or "stock"
            else:
                name, kind = readable_name(v.get("title")) or sym, "etf" if sym in etfs else "stock"
            rows.append({"symbol": sym, "name": name, "kind": kind, "rank": pos, "covered": bool(cov)})
    for sym, cov in covered.items():
        if sym not in seen:
            seen.add(sym)
            rows.append({"symbol": sym, "name": cov.get("name") or sym, "kind": cov.get("kind") or "stock",
                         "rank": None, "covered": True})
    return rows


# ---------------------------------------------------------------- prices
def weekly_prices(symbol: str, close: pd.Series) -> list[dict]:
    """Last session of each calendar week (W-FRI); from_high uses the running max of daily closes."""
    fh = close / close.cummax() - 1.0
    wk = close.index.to_period("W-FRI")
    last = pd.Series(np.arange(len(close)), index=close.index).groupby(wk).max().to_numpy()
    return [{"symbol": symbol, "date": _day(close.index[i]), "close": _px(close.iloc[i]), "from_high": _num(fh.iloc[i])}
            for i in last]


# ---------------------------------------------------------------- earnings: dates, timing, EPS, fiscal labels
def load_confirmations(path=CONFIRMATIONS) -> list[dict]:
    p = Path(path)
    return json.loads(p.read_text()) if p.exists() else []


def _norm_events(events: pd.DataFrame | None) -> pd.DataFrame:
    cols = ["date", "timing", "timing_source", "sec"]
    if events is None or len(events) == 0 or "date" not in events:
        return pd.DataFrame(columns=cols)
    e = events.copy()
    e["date"] = pd.to_datetime(e["date"]).dt.normalize().astype("datetime64[ns]")
    e = e.dropna(subset=["date"])
    if "kind" in e:
        e = e[e["kind"].fillna("report").astype(str) == "report"]
    e["timing"] = [_timing_code(x) for x in e["timing"]] if "timing" in e else "unknown"
    sec_row = e["accepted"].notna() & (e["accepted"].astype(str) != "") if "accepted" in e else pd.Series(False, index=e.index)
    if "timing_sec" in e:
        sec_timed = sec_row & (e["timing_sec"].isna() | (e["timing_sec"].astype(str) == e["timing"]))
    else:
        sec_timed = sec_row
    if "timing_source" not in e:
        e["timing_source"] = np.where(sec_timed, "SEC filing time", "Yahoo")
    e["sec"] = sec_row
    e.loc[e["timing"] == "unknown", "timing_source"] = None
    return e.sort_values("date").drop_duplicates("date", keep="first")[cols].reset_index(drop=True)


def _eps_frame(eps: pd.DataFrame | None, events: pd.DataFrame | None) -> pd.DataFrame | None:
    for f in (eps, events):
        if f is not None and len(f) and "date" in f and ({"eps_actual", "eps_estimate"} & set(f.columns)):
            y = pd.DataFrame({"date": pd.to_datetime(f["date"]).dt.normalize().astype("datetime64[ns]")})
            for col in ("eps_actual", "eps_estimate"):
                y[col] = pd.to_numeric(f[col], errors="coerce").to_numpy() if col in f else np.nan
            return y.dropna(subset=["date"]).sort_values("date").reset_index(drop=True)
    return None


def eps_match(dates, eps: pd.DataFrame | None, tol_days: int = EPS_TOL_DAYS) -> pd.DataFrame:
    """Yahoo EPS actual and estimate of the nearest Yahoo row within tol_days of each date."""
    left = pd.DataFrame({"date": pd.to_datetime(pd.Series(list(dates), dtype="datetime64[ns]"))})
    left["order"] = np.arange(len(left))
    if eps is None or eps.empty or left.empty:
        return left.assign(eps_actual=np.nan, eps_estimate=np.nan).drop(columns="order")
    j = pd.merge_asof(left.sort_values("date"), eps, on="date", direction="nearest",
                      tolerance=pd.Timedelta(days=tol_days))
    return j.sort_values("order").drop(columns="order").reset_index(drop=True)


def report_list(events, eps, confirmations, symbol: str, last_session) -> tuple[pd.DataFrame, dict | None]:
    """Historical reports (date on or before the last session) and the next report, if one is known.

    The next report comes from the confirmations file when it holds a future date for the symbol (status
    "confirmed"; a Yahoo future date within 45 days of it is the same report and is replaced), else from Yahoo's
    future date ("estimated by Yahoo"). Yahoo stamps unconfirmed future dates with a placeholder time that reads
    as during market hours, so a future "during market hours" is treated as unknown.
    """
    last = pd.Timestamp(last_session).normalize()
    e = _norm_events(events)
    past = e[e["date"] <= last].reset_index(drop=True)
    fut = e[e["date"] > last].copy()
    fut.loc[fut["timing"] == "dmh", ["timing", "timing_source"]] = ["unknown", None]
    nxt = None
    confs = []
    for c in confirmations or []:
        try:
            cd = pd.Timestamp(c.get("report_date")).normalize()
        except (TypeError, ValueError):
            continue
        if str(c.get("symbol", "")).upper() == symbol.upper() and pd.notna(cd) and cd > last:
            confs.append((cd, c))
    if confs:
        cd, c0 = min(confs, key=lambda x: x[0])
        near = fut[(fut["date"] - cd).abs() <= pd.Timedelta(days=45)]
        fut = fut.drop(near.index)
        code = _timing_code(c0.get("timing"))
        nxt = {"date": cd, "timing": code, "timing_source": "confirmed" if code != "unknown" else None,
               "date_status": "confirmed", "source": c0.get("source"),
               "replaced": near["date"].min() if len(near) else None}
    if len(fut) and (nxt is None or fut["date"].min() < nxt["date"]):
        r = fut.sort_values("date").iloc[0]
        src = r["timing_source"] if isinstance(r["timing_source"], str) else None
        nxt = {"date": r["date"], "timing": r["timing"], "timing_source": src,
               "date_status": "estimated by Yahoo", "source": None, "replaced": None}
    return past, nxt


def fiscal_periods(facts: dict) -> pd.DataFrame:
    """period_end, fiscal_year, fiscal_q of each 10-Q / 10-K's own period from SEC company facts.

    A filing's own period is the latest period end among its duration facts; its fy and fp label it (fp FY -> 4).
    Amended filings repeat a period: the first filed label is kept.
    """
    from .data import sec
    cols = ["period_end", "fiscal_year", "fiscal_q", "filed"]
    tags = sec.TAGS["revenue"] + ["NetIncomeLoss", "ProfitLoss", "EarningsPerShareDiluted", "EarningsPerShareBasic",
                                  "NetCashProvidedByUsedInOperatingActivities", "OperatingIncomeLoss"]
    parts = []
    for tag in dict.fromkeys(tags):
        df = sec._facts(facts, tag, ("USD", "USD/shares"))
        if df.empty or not {"fy", "fp", "accn", "start"} <= set(df.columns):
            continue
        parts.append(df[["accn", "fy", "fp", "start", "end", "filed"]])
    if not parts:
        return pd.DataFrame(columns=cols)
    d = pd.concat(parts, ignore_index=True).dropna(subset=["fy", "fp", "end", "start"])
    d = d[d["fp"].astype(str).isin(["Q1", "Q2", "Q3", "FY"])]
    if d.empty:
        return pd.DataFrame(columns=cols)
    own = d.sort_values(["accn", "end"]).groupby("accn").tail(1)
    out = pd.DataFrame({"period_end": own["end"].to_numpy(), "fiscal_year": own["fy"].astype(int).to_numpy(),
                        "fiscal_q": own["fp"].map({"Q1": 1, "Q2": 2, "Q3": 3, "FY": 4}).to_numpy(),
                        "filed": own["filed"].to_numpy()})
    out = out.sort_values(["period_end", "filed"]).drop_duplicates("period_end", keep="first")
    return out.reset_index(drop=True)[cols]


def _advance(fy: int, fq: int, k: int = 1) -> tuple[int, int]:
    n = fy * 4 + (fq - 1) + k
    return n // 4, n % 4 + 1


def _fiscal_calendar(fiscal: pd.DataFrame, until) -> pd.DataFrame:
    """Known fiscal periods, plus the quarters a quarterly filer's calendar implies but SEC does not hold yet.

    Fiscal labels follow a fixed sequence, so a gap between two known quarters whose labels are exactly k steps
    apart is filled, and quarters after the last filing are added (13 weeks apart) while they end before `until`
    (the latest report date). This is what labels a report whose 10-Q or 10-K has not been filed yet.
    """
    f = fiscal.dropna(subset=["period_end", "fiscal_year", "fiscal_q"]).copy()
    f["period_end"] = pd.to_datetime(f["period_end"])
    f = f.sort_values("period_end").drop_duplicates("period_end")
    rows = [(r.period_end, int(r.fiscal_year), int(r.fiscal_q)) for r in f.itertuples()]
    if not rows or not (f["fiscal_q"] < 4).any():
        return pd.DataFrame(rows, columns=["period_end", "fiscal_year", "fiscal_q"])
    out = [rows[0]]
    step = pd.Timedelta(days=QUARTER_STEP_DAYS)
    for a, b in zip(rows, rows[1:], strict=False):
        k = int(round((b[0] - a[0]).days / 91.31))
        if 2 <= k <= 4 and _advance(a[1], a[2], k) == (b[1], b[2]):
            out += [(a[0] + j * step, *_advance(a[1], a[2], j)) for j in range(1, k)]
        out.append(b)
    if until is not None:
        while out[-1][0] + step < pd.Timestamp(until):
            last = out[-1]
            out.append((last[0] + step, *_advance(last[1], last[2])))
    return pd.DataFrame(out, columns=["period_end", "fiscal_year", "fiscal_q"])


def fiscal_labels(dates, fiscal: pd.DataFrame | None) -> list[tuple]:
    """(label, fiscal_year, fiscal_q) per report date.

    With SEC fiscal periods: the most recent fiscal period end within 120 days before the report ("FY2026 Q3"),
    else nulls. Without them: the calendar quarter of report date minus 30 days ("CY2026 Q3 (calendar)").
    """
    dates = [pd.Timestamp(d).normalize() for d in dates]
    if fiscal is None or len(fiscal) == 0:
        out = []
        for d in dates:
            ref = d - pd.Timedelta(days=30)
            q = (ref.month - 1) // 3 + 1
            out.append((f"CY{ref.year} Q{q} (calendar)", int(ref.year), int(q)))
        return out
    cal = _fiscal_calendar(fiscal, max(dates) if dates else None)
    ends = pd.DatetimeIndex(cal["period_end"])
    out = []
    for d in dates:
        i = _before(ends, d)
        if i is None or (d - ends[i]).days > FISCAL_WINDOW_DAYS:
            out.append((None, None, None))
            continue
        fy, fq = int(cal["fiscal_year"].iloc[i]), int(cal["fiscal_q"].iloc[i])
        out.append((f"FY{fy} Q{fq}", fy, fq))
    return out


def eps_ttm(facts: dict, splits: pd.Series | None = None) -> pd.DataFrame:
    """TTM diluted GAAP EPS from SEC company facts, on today's split basis, as first reported.

    Each fact is converted to today's share basis with the splits after its own filing date before quarters are
    derived (Q4 = FY - 9M), so a split between the 9 month 10-Q and the 10-K does not corrupt Q4. TTM is the sum of
    four contiguous quarters; `filed` is the latest filing date among them (usable only after that day).
    """
    from .analytics.valuation import split_factor_after
    from .data import sec
    cols = ["period_end", "filed", "ttm_eps"]
    parts = []
    for rank, tag in enumerate(["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"]):
        df = sec._facts(facts, tag, ("USD/shares",))
        if df.empty:
            continue
        df = df.copy()
        df["val"] = df["val"].astype(float) / split_factor_after(df["filed"], splits)
        q = sec.discrete_quarters(df)
        if not q.empty:
            parts.append(q.assign(rank=rank))
    if not parts:
        return pd.DataFrame(columns=cols)
    m = pd.concat(parts, ignore_index=True)
    m["derived"] = m["derived"].astype(bool)
    m = m.sort_values(["period_end", "filed", "derived", "rank"], kind="mergesort").drop_duplicates("period_end")
    m = m.sort_values("period_end").reset_index(drop=True)
    pe, filed, val = pd.to_datetime(m["period_end"]), pd.to_datetime(m["filed"]), m["val"].astype(float)
    rows = []
    for i in range(3, len(m)):
        if 250 <= (pe.iloc[i] - pe.iloc[i - 3]).days <= 290:
            rows.append({"period_end": pe.iloc[i], "filed": filed.iloc[i - 3: i + 1].max(),
                         "ttm_eps": float(val.iloc[i - 3: i + 1].sum())})
    return pd.DataFrame(rows, columns=cols)


def pe_at(pe: pd.DataFrame | None, report_date, price, today=None):
    """Price / TTM diluted EPS from filings dated before the report (point in time); null if EPS <= 0 or unknown.

    The newest quarter whose TTM filings all precede the report is used; when that quarter has no TTM value the
    result is null rather than an older TTM.
    """
    if pe is None or len(pe) == 0 or price is None or not np.isfinite(price):
        return None
    d = pd.Timestamp(report_date).normalize()
    t = pe.copy()
    t["filed"] = pd.to_datetime(t["filed"])
    ok = t["filed"] < d
    if today is not None:
        ok &= t["filed"] <= pd.Timestamp(today)
    t = t[ok]
    if t.empty:
        return None
    row = t.sort_values(["period_end", "filed"]).iloc[-1]
    eps = float(row["ttm_eps"]) if pd.notna(row["ttm_eps"]) else np.nan
    return price / eps if np.isfinite(eps) and eps > 0 else None


# ---------------------------------------------------------------- earnings: price behavior around one report
def report_prices(close: pd.Series, report_date, timing: str, current: bool = False) -> dict:
    """Run-up and reaction around one report from split adjusted closes.

    base   last close before the reaction: report date's own close (or the last session on or before it) for
           after the close, else the session before the report date
    pre_*  base / last close on or before report date - 42, 14, 7 calendar days - 1 (null while that window
           has not started)
    react  close(t0), close(t0 + 4), close(t0 + 20) over the close of the session before t0; unknown timing:
           no 1 day reaction, 1 week and 1 month over 5 and 21 sessions after the session before the report
    """
    idx, c = close.index, close.to_numpy(float)
    n = len(c)
    d = pd.Timestamp(report_date).normalize()
    code = _timing_code(timing)
    out = {"t0_date": None, "pre_6w": None, "pre_2w": None, "pre_1w": None, "react_1d": None, "react_1w": None,
           "react_1m": None, "run_bucket": None, "run_low_days": None, "run_high_days": None, "base_i": None}
    pb = _on_or_before(idx, d) if code == "amc" else _before(idx, d)
    out["base_i"] = pb
    if pb is not None:
        for key, days in (("pre_6w", 42), ("pre_2w", 14), ("pre_1w", 7)):
            start = d - pd.Timedelta(days=days)
            bi = _on_or_before(idx, start)
            if bi is None or idx[pb] < start:
                continue
            out[key] = _num(c[pb] / c[bi] - 1.0)
            if key == "pre_6w":
                w = c[bi: pb + 1]
                out["run_low_days"] = int(pb - (bi + np.flatnonzero(w == w.min())[-1]))
                out["run_high_days"] = int(pb - (bi + np.flatnonzero(w == w.max())[-1]))
        p6 = out["pre_6w"]
        if p6 is not None:
            out["run_bucket"] = "large rally" if p6 >= 0.10 else "small rally" if p6 >= 0 else "decline"
    if current or pb is None:                  # no session before the report: nothing could react in the data
        return out
    if code == "unknown":
        rb = pb
        if rb is not None:
            out["react_1w"] = _num(c[rb + 5] / c[rb] - 1.0) if rb + 5 < n else None
            out["react_1m"] = _num(c[rb + 21] / c[rb] - 1.0) if rb + 21 < n else None
        return out
    t0 = reaction_index(idx, d, code)
    if t0 is None or t0 < 1:
        return out
    out["t0_date"] = _day(idx[t0])
    rb = t0 - 1                                 # equals the run-up base for every known timing
    out["react_1d"] = _num(c[t0] / c[rb] - 1.0)
    out["react_1w"] = _num(c[t0 + 4] / c[rb] - 1.0) if t0 + 4 < n else None
    out["react_1m"] = _num(c[t0 + 20] / c[rb] - 1.0) if t0 + 20 < n else None
    return out


def earn_path(close: pd.Series, report_date, current: bool = False) -> dict | None:
    """Sessions from 42 calendar days before to 28 after the report, against one baseline.

    The baseline is the last close on or before day -42 (carried from an earlier session when day -42 is not a
    session) and is never reset. A current cycle path ends at the last session; it is absent until the last
    session reaches day -42.
    """
    idx, c = close.index, close.to_numpy(float)
    d = pd.Timestamp(report_date).normalize()
    start, end = d - pd.Timedelta(days=42), d + pd.Timedelta(days=28)
    if current and idx[-1] < start:
        return None
    bi = _on_or_before(idx, start)
    if bi is None:
        return None
    lo, hi = int(idx.searchsorted(start, side="left")), int(idx.searchsorted(end, side="right"))
    if hi <= lo:
        return None
    pts = range(lo, hi)
    days = [int((idx[k] - d).days) for k in pts]
    return {"baseline_date": _day(idx[bi]), "baseline_close": _px(c[bi]), "days": days,
            "weeks": [round(x / 7, 3) for x in days], "pct": [_num(c[k] / c[bi] - 1.0) for k in pts],
            "dates": [_day(idx[k]) for k in pts], "last_date": _day(idx[hi - 1])}


def symbol_earnings(symbol: str, close: pd.Series, d: dict, confirmations, today) -> dict:
    """research_earnings, research_earn_paths and research_earn_summary rows for one symbol, plus coverage facts."""
    last = close.index[-1]
    events = d.get("events") if d.get("events") is not None else d.get("eps")
    past, nxt = report_list(events, d.get("eps"), confirmations, symbol, last)
    reports = [{"date": r.date, "timing": r.timing, "current": False, "date_status": "reported", "replaced": None,
                "timing_source": r.timing_source if isinstance(r.timing_source, str) else None}
               for r in past.itertuples()]
    if nxt is not None:
        reports.append({**nxt, "current": True})
    res = {"earnings": [], "paths": [], "summary": [], "next": nxt, "hist": []}
    if not reports:
        return res
    eps = _eps_frame(d.get("eps"), events)
    m = eps_match([r["date"] for r in reports], eps)
    labels = fiscal_labels([r["date"] for r in reports], d.get("fiscal"))
    for k, r in enumerate(reports):
        cur = r["current"]
        actual, est = m["eps_actual"].iloc[k], m["eps_estimate"].iloc[k]
        if cur:
            actual = np.nan                          # not reported yet
            if pd.isna(est) and r.get("replaced") is not None:
                est = eps_match([r["replaced"]], eps)["eps_estimate"].iloc[0]
        a, e = _num(actual), _num(est)
        surprise = _num((actual - est) / abs(est)) if a is not None and e is not None and est != 0 else None
        beat = bool(actual > est) if a is not None and e is not None else None
        p = report_prices(close, r["date"], r["timing"], current=cur)
        base_close = float(close.iloc[p["base_i"]]) if p["base_i"] is not None else None
        pe = pe_at(d.get("pe"), r["date"], base_close, today)
        if beat is None:
            beat_fell = None
        elif not beat:
            beat_fell = False
        else:
            beat_fell = None if p["react_1d"] is None else bool(p["react_1d"] < 0)
        label, fy, fq = labels[k]
        row = {"symbol": symbol, "report_date": _day(r["date"]), "timing": TIMING_TEXT[r["timing"]],
               "timing_source": r["timing_source"], "fiscal_label": label, "fiscal_year": fy, "fiscal_q": fq,
               "eps_actual": a, "eps_estimate": e, "surprise_pct": surprise,
               "eps_source": EPS_SOURCE if a is not None or e is not None else None, "beat": beat,
               "t0_date": p["t0_date"], "pre_6w": p["pre_6w"], "pre_2w": p["pre_2w"], "pre_1w": p["pre_1w"],
               "react_1d": p["react_1d"], "react_1w": p["react_1w"], "react_1m": p["react_1m"],
               "run_bucket": p["run_bucket"], "run_low_days": p["run_low_days"], "run_high_days": p["run_high_days"],
               "beat_fell": beat_fell, "pe_ttm_gaap": _num(pe, 2), "current": cur}
        res["earnings"].append(row)
        if not cur:
            res["hist"].append({**row, "has_prices": p["base_i"] is not None})
        path = earn_path(close, r["date"], current=cur)
        if path is not None:
            res["paths"].append({"symbol": symbol, "report_date": row["report_date"], "fiscal_label": label,
                                 "fiscal_year": fy, "fiscal_q": fq, "timing": row["timing"], "current": cur,
                                 "date_status": r["date_status"], **path})
    res["summary"] = earn_summary(symbol, res["hist"])
    return res


def earn_summary(symbol: str, hist: list[dict]) -> list[dict]:
    """Per run-up bucket and "all": historical reports with prices; medians over the reports that have each value."""
    rows = []
    with_px = [r for r in hist if r.get("has_prices")]
    if not with_px:
        return rows
    for bucket in ("large rally", "small rally", "decline", "all"):
        g = with_px if bucket == "all" else [r for r in with_px if r["run_bucket"] == bucket]

        def med(key, g=g):
            v = [r[key] for r in g if r[key] is not None]
            return _num(np.median(v)) if v else None

        r1 = [r["react_1d"] for r in g if r["react_1d"] is not None]
        rows.append({"symbol": symbol, "run_bucket": bucket, "n": len(g), "n_with_reaction": len(r1),
                     "median_react_1d": med("react_1d"), "pct_up_1d": _num(np.mean(np.array(r1) > 0)) if r1 else None,
                     "median_react_1w": med("react_1w"), "median_react_1m": med("react_1m"),
                     "n_with_eps": sum(1 for r in g if r["beat"] is not None),
                     "beats": sum(1 for r in g if r["beat"] is True),
                     "beat_fell": sum(1 for r in g if r["beat_fell"] is True)})
    return rows


# ---------------------------------------------------------------- moving average streaks
def ma_rows(symbol: str, close: pd.Series, mas=MAS) -> tuple[list[dict], list[dict]]:
    """Streak state and history per simple moving average, and what followed past streaks of each length.

    Completed streak statistics leave out the first run (left censored: it began before the average existed) and
    the current run (unfinished). Each past streak counts once in the conditional rows, measured from the session
    it reached length L.
    """
    stats, cond = [], []
    for n in mas:
        r, c, s, dates = streaks.runs(close, n)
        if r.empty:
            continue
        side = np.repeat(r["side"].to_numpy(), r["len"].to_numpy())
        cur = r.iloc[-1]
        done = r.iloc[1:-1]
        same = done[done["side"] == cur["side"]]
        lens = same["len"].astype(float)
        row = {"symbol": symbol, "ma": n, "side": "above" if cur["side"] > 0 else "below", "streak": int(cur["len"]),
               "gap": _num(c[-1] / s[-1] - 1.0), "pct_time_above": _num(float((side > 0).mean())),
               "completed_same_side": int(len(same)), "median_len": None, "p75_len": None, "p90_len": None,
               "max_len": None, "max_len_end": None, "share_reaching_today": None,
               "first_run_excluded": bool(len(r) >= 2 and r["side"].iloc[0] == cur["side"])}
        if len(same):
            longest = same[same["len"] == same["len"].max()].iloc[-1]
            row.update({"median_len": _num(lens.median()), "p75_len": _num(lens.quantile(0.75)),
                        "p90_len": _num(lens.quantile(0.9)), "max_len": int(longest["len"]),
                        "max_len_end": _day(dates[int(longest["end"])]),
                        "share_reaching_today": _num(float((lens >= cur["len"]).mean()))})
        stats.append(row)
        for sd, label in ((1, "above"), (-1, "below")):
            elig = done[done["side"] == sd]
            if elig.empty:
                continue
            bi = np.flatnonzero(side[: max(len(c) - 10, 0)] == sd)
            base = c[bi + 10] / c[bi] - 1.0 if len(bi) else np.array([])
            base_med = _num(np.median(base)) if len(base) else None
            for L in range(1, min(COND_MAX_LEN, int(elig["len"].max())) + 1):
                reached = elig[elig["len"] >= L]
                k = len(reached)
                if k == 0:
                    continue
                at = reached["start"].to_numpy() + L - 1
                left = reached["len"].to_numpy() - L + 1        # sessions from reaching L to the first close across
                rets = {}
                for h in (5, 10, 20):
                    ok = at + h < len(c)
                    rets[h] = c[at[ok] + h] / c[at[ok]] - 1.0
                cond.append({"symbol": symbol, "ma": n, "side": label, "length": L, "n": k,
                             "ended_within_5": _num(float((left <= 5).mean())),
                             "ended_within_10": _num(float((left <= 10).mean())),
                             "median_ret_5": _num(np.median(rets[5])) if len(rets[5]) >= 5 else None,
                             "median_ret_10": _num(np.median(rets[10])) if len(rets[10]) >= 5 else None,
                             "median_ret_20": _num(np.median(rets[20])) if len(rets[20]) >= 5 else None,
                             "p10_ret_10": _num(np.percentile(rets[10], 10)) if len(rets[10]) >= 5 else None,
                             "base_median_ret_10": base_med})
    return stats, cond


# ---------------------------------------------------------------- drawdowns
def drawdown_episodes(close: pd.Series, threshold: float) -> list[dict]:
    """Episodes from a running high: start when the close first falls `threshold` below it, end when a close
    regains it. One episode per peak however many lower lows; ongoing when still below at the last session."""
    v, idx = close.to_numpy(float), close.index
    out = []
    hwm_i, in_ep, peak, trough = 0, False, 0, 0

    def episode(p, t, r):
        return {"peak_date": _day(idx[p]), "peak_close": _px(v[p]), "trough_date": _day(idx[t]),
                "depth": _num(v[t] / v[p] - 1.0), "recovered_date": _day(idx[r]) if r is not None else None,
                "status": "completed" if r is not None else "ongoing", "sessions_to_trough": int(t - p),
                "sessions_to_recover": int(r - p) if r is not None else None, "censored": bool(p == 0), "_peak_i": p}

    for i in range(len(v)):
        if not in_ep:
            if v[i] >= v[hwm_i]:
                hwm_i = i
            elif v[i] / v[hwm_i] - 1.0 <= -threshold + 1e-12:
                in_ep, peak, trough = True, hwm_i, i
        else:
            if v[i] < v[trough]:
                trough = i
            if v[i] >= v[peak]:
                out.append(episode(peak, trough, i))
                in_ep, hwm_i = False, i
    if in_ep:
        out.append(episode(peak, trough, None))
    return out


def drawdown_rows(symbol: str, close: pd.Series, thresholds=THRESHOLDS) -> tuple[list[dict], list[dict]]:
    episodes, summary = [], []
    last_i = len(close) - 1
    for th in thresholds:
        eps = drawdown_episodes(close, th)
        done = [e for e in eps if e["status"] == "completed"]
        could = [e for e in eps if last_i - e["_peak_i"] >= 250]
        summary.append({"symbol": symbol, "threshold": th, "episodes": len(eps), "completed": len(done),
                        "ongoing": len(eps) - len(done), "censored": sum(e["censored"] for e in eps),
                        "median_sessions_to_recover": _num(np.median([e["sessions_to_recover"] for e in done]), 1)
                        if done else None,
                        "recovered_within_250": sum(1 for e in could if e["status"] == "completed"
                                                    and e["sessions_to_recover"] <= 250),
                        "recovered_within_250_of": len(could),
                        "data_start": _day(close.index[0]), "data_end": _day(close.index[-1])})
        episodes += [{"symbol": symbol, "threshold": th, **{k: v for k, v in e.items() if k != "_peak_i"}} for e in eps]
    return episodes, summary


def _first_session_expected(year: int) -> pd.Timestamp:
    """First NYSE session of a year under the New Year's Day rule (Jan 2 is closed when Jan 1 is a Sunday)."""
    d = pd.Timestamp(year, 1, 2)
    if pd.Timestamp(year, 1, 1).weekday() == 6:
        d = pd.Timestamp(year, 1, 3)
    while d.weekday() >= 5:
        d += pd.Timedelta(days=1)
    return d


def dd_year_rows(symbol: str, close: pd.Series, as_of=None) -> list[dict]:
    """Worst close of each calendar year against the running high of all history up to that day."""
    dd = close / close.cummax() - 1.0
    years = sorted(set(close.index.year))
    first_partial = close.index[0] > _first_session_expected(years[0])
    last_complete = period_complete(close.index[-1], pd.Timestamp(years[-1], 12, 31), as_of)
    rows = []
    for y, g in dd.groupby(dd.index.year):
        complete = not ((y == years[0] and first_partial) or (y == years[-1] and not last_complete))
        rows.append({"symbol": symbol, "year": int(y), "worst_from_high": _num(g.min()), "complete": complete})
    return rows


# ---------------------------------------------------------------- seasonality and strategy
def seasonality_rows(symbol: str, close: pd.Series, as_of=None) -> list[dict]:
    """Complete calendar months and quarters: last close of the period over the last close of the previous one.
    The period holding the last session goes in current_ret, with current_complete saying whether it is over."""
    rows = []
    for ptype, freq, count in (("month", "M", 12), ("quarter", "Q", 4)):
        per = close.index.to_period(freq)
        pc = close.groupby(per).last()
        ords = np.array([p.ordinal for p in pc.index])
        vals = pc.to_numpy(float)
        ret = np.full(len(pc), np.nan)
        ok = np.r_[False, np.diff(ords) == 1]
        ret[ok] = vals[ok] / vals[np.flatnonzero(ok) - 1] - 1.0
        nums = np.array([p.month if ptype == "month" else p.quarter for p in pc.index])
        complete = np.ones(len(pc), bool)
        last_done = period_complete(close.index[-1], pc.index[-1].end_time.normalize(), as_of)
        complete[-1] = last_done
        cur_num = int(nums[-1])
        for p in range(1, count + 1):
            x = ret[(nums == p) & complete & np.isfinite(ret)]
            row = {"symbol": symbol, "period_type": ptype, "period": p, "n": int(len(x)),
                   "median_ret": _num(np.median(x)) if len(x) else None, "mean_ret": _num(np.mean(x)) if len(x) else None,
                   "pct_up": _num(float((x > 0).mean())) if len(x) else None,
                   "best": _num(x.max()) if len(x) else None, "worst": _num(x.min()) if len(x) else None,
                   "current_ret": None, "current_complete": None}
            if p == cur_num:
                row["current_ret"], row["current_complete"] = _num(ret[-1]), bool(last_done)
            rows.append(row)
    return rows


def strategy_rows(symbol: str, close: pd.Series, cost: float = COST_PER_TRADE) -> list[dict]:
    """Buy and hold, above the 200 day average, and 50/200 day cross, from the first session with a 200 day average.

    The signal uses the close of day t and the position changes at the close of day t + 1, so a signal on the last
    session causes no trade. Each buy or sell costs `cost`; cash earns nothing.
    """
    c = close.to_numpy(float)
    n = len(c)
    sma200 = close.rolling(200).mean().to_numpy()
    sma50 = close.rolling(50).mean().to_numpy()
    valid = np.flatnonzero(np.isfinite(sma200))
    if not len(valid) or valid[0] >= n - 1:
        return []
    w = int(valid[0])
    with np.errstate(invalid="ignore"):
        rules = {"buy and hold": np.ones(n, bool), "above 200 day average": c > sma200, "50/200 day cross": sma50 > sma200}
    years = (close.index[-1] - close.index[w]).days / 365.25
    rows = []
    for name, sig in rules.items():
        pos = np.zeros(n)
        pos[w + 1:] = sig[w: n - 1].astype(float)     # set at the close of t + 1 from the signal at t
        eq = np.ones(n - w)
        trades = 0
        for k in range(w + 1, n):
            e = eq[k - 1 - w] * (1.0 + pos[k - 1] * (c[k] / c[k - 1] - 1.0))
            if pos[k] != pos[k - 1]:
                e *= 1.0 - cost
                trades += 1
            eq[k - w] = e
        dd = eq / np.maximum.accumulate(eq) - 1.0
        rows.append({"symbol": symbol, "rule": name, "start": _day(close.index[w]), "end": _day(close.index[-1]),
                     "total_return": _num(eq[-1] - 1.0),
                     "cagr": _num(eq[-1] ** (1.0 / years) - 1.0) if years >= 1 else None,
                     "max_drawdown": _num(dd.min()), "trades": trades,
                     "pct_time_invested": _num(float(pos[w: n - 1].mean())), "cost_per_trade": cost})
    return rows


# ---------------------------------------------------------------- corporate actions and large drops
def event_rows(symbol: str, close: pd.Series, report_dates) -> list[dict]:
    """One session moves of -25% or worse that are not within 2 sessions after a report date, and known actions."""
    idx = close.index
    move = close.pct_change().to_numpy()
    near = set()
    for d in report_dates:
        p = int(idx.searchsorted(pd.Timestamp(d).normalize(), side="left"))
        near.update(range(p, p + 3))
    rows = [{"symbol": symbol, "date": _day(idx[k]), "kind": "large one day drop", "move": _num(move[k]),
             "note": LARGE_DROP_NOTE}
            for k in range(1, len(idx)) if move[k] <= LARGE_DROP + 1e-12 and k not in near]
    if symbol in KNOWN_EVENTS:
        d = pd.Timestamp(KNOWN_EVENTS[symbol])
        k = int(idx.searchsorted(d))
        mv = _num(move[k]) if 0 < k < len(idx) and idx[k] == d else None
        rows.append({"symbol": symbol, "date": _day(d), "kind": "corporate action", "move": mv, "note": KNOWN_NOTES[symbol]})
    return sorted(rows, key=lambda r: r["date"])


# ---------------------------------------------------------------- coverage
def coverage_row(symbol: str, d: dict, close: pd.Series, earn: dict, events: list[dict], kind: str) -> dict:
    start, end = close.index[0], close.index[-1]
    years = (end - start).days / 365.25
    hist = earn["hist"]
    nxt = earn["next"]
    notes = []
    if years < 5:
        if start > pd.Timestamp(HISTORY_START) + pd.Timedelta(days=7):
            notes.append(f"Listed {_day(start)}: about {years:.1f} years of prices")
        else:
            notes.append(f"Only about {years:.1f} years of prices (from {_day(start)})")
    if kind == "stock":
        expected = 4 * years
        if expected - len(hist) >= 4 and len(hist) < 0.85 * expected:
            notes.append(f"{years:.1f} years of prices but only {len(hist)} dated reports")
        unknown = sum(1 for r in hist if r["timing"] == "unknown")
        if unknown:
            notes.append(f"{unknown} of {len(hist)} reports have unknown timing: their 1 day reaction is left blank")
    if symbol in KNOWN_NOTES:
        notes.append(KNOWN_NOTES[symbol])
    for e in events:
        if e["kind"] == "large one day drop":
            notes.append(f"{e['date']}: one session move of {e['move'] * 100:.1f}%, not within 2 sessions after a "
                         f"report: {LARGE_DROP_NOTE}")
    if nxt is not None and nxt.get("source"):
        notes.append(f"Next report {_day(nxt['date'])} {TIMING_TEXT[nxt['timing']]} confirmed: {nxt['source']}")
    notes += [str(x) for x in d.get("notes") or []]
    has_reports = kind == "stock" and (bool(hist) or nxt is not None)
    fiscal = d.get("fiscal")
    return {"symbol": symbol, "name": d.get("name") or symbol, "kind": kind, "price_start": _day(start),
            "price_end": _day(end), "sessions": int(len(close)), "years_of_prices": _num(years, 2),
            "reports_dated": len(hist), "reports_with_prices": sum(1 for r in hist if r["has_prices"]),
            "reports_with_eps": sum(1 for r in hist if r["eps_actual"] is not None),
            "timing_known": sum(1 for r in hist if r["timing"] != "unknown"),
            "next_report": _day(nxt["date"]) if nxt else None,
            "next_report_timing": TIMING_TEXT[nxt["timing"]] if nxt else None,
            "next_report_status": nxt["date_status"] if nxt else None,
            "fiscal_calendar": (("SEC fiscal periods" if fiscal is not None and len(fiscal) else
                                 "calendar quarters (fiscal calendar not available)") if has_reports else None),
            "notes": notes}


# ---------------------------------------------------------------- pipeline
def write_rows(out_dir: Path, name: str, rows: list[dict]) -> int:
    text = json.dumps(_clean(rows), allow_nan=False, separators=(",", ":"))
    (out_dir / name).write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def build_from_frames(data: dict, out_dir, as_of=None, *, confirmations=None, sec_tickers=None,
                      notes: list[str] | None = None) -> dict[str, tuple[int, int]]:
    """Compute every file from in-memory frames and write them to out_dir. Returns {file: (rows, bytes)}.

    data[symbol] = {"prices": daily frame with `close` (split adjusted), "events": report dates (date, timing,
    kind; SEC rows carry `accepted`) or None, "eps": Yahoo earnings_dates (date, eps_estimate, eps_actual) or None,
    "fiscal": fiscal_periods() frame or None, "pe": eps_ttm() frame (period_end, filed, ttm_eps) or None,
    "name": str, "kind": "stock" | "etf", optional "notes": [str]}.
    confirmations: list of {symbol, report_date, timing, source}; None reads data/confirmed_report_dates.json.
    sec_tickers: the SEC company_tickers.json payload; None fetches it.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    today = pd.Timestamp(as_of).normalize() if as_of is not None else pd.Timestamp.today().normalize()
    confirmations = load_confirmations() if confirmations is None else confirmations
    meta_notes = list(notes or [])
    etfs = known_etfs()
    rows = {k: [] for k in FILES if k not in ("universe", "meta")}
    covered = {}
    for sym, d in data.items():
        sym = sym.upper()
        try:
            close = clean_close(d.get("prices"), today)
        except Exception as e:
            meta_notes.append(f"{sym} skipped: {e}")
            continue
        kind = "etf" if sym in etfs else (d.get("kind") or "stock")
        covered[sym] = {"name": d.get("name") or sym, "kind": kind}
        rows["prices"] += weekly_prices(sym, close)
        earn = (symbol_earnings(sym, close, d, confirmations, today) if kind == "stock" else
                {"earnings": [], "paths": [], "summary": [], "next": None, "hist": []})
        rows["earnings"] += earn["earnings"]
        rows["earn_paths"] += earn["paths"]
        rows["earn_summary"] += earn["summary"]
        st, cond = ma_rows(sym, close)
        rows["ma"] += st
        rows["ma_cond"] += cond
        ep, dds = drawdown_rows(sym, close)
        rows["drawdowns"] += ep
        rows["dd_summary"] += dds
        rows["dd_years"] += dd_year_rows(sym, close, today)
        rows["seasonality"] += seasonality_rows(sym, close, today)
        rows["strategy"] += strategy_rows(sym, close)
        ev = event_rows(sym, close, [r["report_date"] for r in earn["hist"]])
        rows["events"] += ev
        rows["coverage"].append(coverage_row(sym, d, close, earn, ev, kind))
    # Keep the chart files light for a phone; every statistic above was computed on the full history.
    price_cut = (today - pd.DateOffset(years=PRICE_YEARS)).strftime("%Y-%m-%d")
    path_cut = (today - pd.DateOffset(months=int(EARN_PATH_YEARS * 12))).strftime("%Y-%m-%d")
    rows["prices"] = [r for r in rows["prices"] if str(r["date"]) >= price_cut]
    rows["earn_paths"] = [r for r in rows["earn_paths"] if r.get("current") or str(r["report_date"]) >= path_cut]
    meta_notes.append(f"Charts keep weekly prices for the last {PRICE_YEARS} years and report windows for the last "
                      f"{EARN_PATH_YEARS:g} years; statistics use the full price history.")
    fetched = True
    if sec_tickers is None:
        try:
            sec_tickers = fetch_sec_tickers()
        except Exception as e:
            sec_tickers, fetched = None, False
            meta_notes.append(f"SEC company list unavailable ({e}): the search list holds only the covered symbols")
    uni = universe_rows(sec_tickers if fetched else None, covered)
    result = {FILES["universe"]: (len(uni), write_rows(out, FILES["universe"], uni))}
    for key, r in rows.items():
        result[FILES[key]] = (len(r), write_rows(out, FILES[key], r))
    for name, (_, size) in result.items():
        if size > MAX_BYTES:
            meta_notes.append(f"{name} is {size:,} bytes, over the 8 MB budget")
    meta_notes.append("Returns are price returns of split adjusted closes (dividends excluded).")
    meta = [{"generated_at": pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%dT%H:%M:%SZ"), "as_of": _day(today),
             "covered": len(covered), "universe_size": len(uni), **PROVIDERS,
             "universe_provider": ("SEC company_tickers.json (in SEC's order, roughly by size), plus covered symbols "
                                   "missing from it" if fetched else "covered symbols only (SEC list unavailable)"),
             "sec_list_fetched": fetched, "notes": meta_notes}]
    result[FILES["meta"]] = (1, write_rows(out, FILES["meta"], meta))
    return result


def load_symbol(ticker: str) -> dict:
    """Prices, name and kind; for stocks also Yahoo EPS, SEC report dates and timing, fiscal periods and TTM EPS."""
    from .config import SEC_USER_AGENT
    from .data import loader, sec, yahoo
    t = ticker.upper()
    prices = loader.get_prices(t)
    try:
        prof = yahoo.profile(t) or {}
    except Exception:
        prof = {}
    qt = str(prof.get("quoteType") or "").upper()
    kind = "etf" if qt in ("ETF", "MUTUALFUND") or t in known_etfs() else "stock"
    d = {"prices": prices, "events": None, "eps": None, "fiscal": None, "pe": None,
         "name": prof.get("longName") or prof.get("shortName") or t, "kind": kind, "notes": []}
    if kind == "etf":
        return d
    try:
        d["eps"] = yahoo.earnings_dates(t)
    except Exception as e:
        d["notes"].append(f"Yahoo earnings dates unavailable ({e})")
    if SEC_USER_AGENT:
        try:
            d["events"] = sec.merge_earnings(sec.earnings_releases(t), d["eps"])
        except Exception as e:
            d["notes"].append(f"SEC report dates unavailable ({e}): dates and timing from Yahoo")
        try:
            _, facts = sec.company_data(t)
            d["fiscal"] = fiscal_periods(facts)
            d["pe"] = eps_ttm(facts, yahoo.splits(t, prices))
        except Exception as e:
            d["notes"].append(f"SEC company facts unavailable ({e}): calendar quarter labels and no P/E")
    else:
        d["notes"].append("MCL_SEC_USER_AGENT not set: report dates and timing from Yahoo, calendar quarter labels, "
                          "no P/E")
    if d["events"] is None:
        d["events"] = d["eps"]
    return d


def build(tickers: list[str], out_dir=DEFAULT_OUT, as_of=None, confirmations=None) -> dict[str, tuple[int, int]]:
    """Load real data for each ticker (a ticker that fails is skipped with a note in meta), then build_from_frames."""
    data, notes = {}, []
    for t in dict.fromkeys(x.upper() for x in tickers):
        try:
            data[t] = load_symbol(t)
        except Exception as e:
            notes.append(f"{t} skipped: {e}")
    return build_from_frames(data, out_dir, as_of, confirmations=confirmations, notes=notes)


def research_set(tickers=None, position_csv=None, watchlist=None) -> list[str]:
    """TICKERS + holdings + watchlist + benchmarks and sector funds, in that order, without repeats."""
    from .holdings import read_holdings
    out = [t.upper() for t in tickers or []]
    if position_csv:
        out += read_holdings(position_csv)["ticker"].tolist()
    wl = Path(watchlist) if watchlist else USER_DIR / "watchlist.json"
    if watchlist and not wl.exists():
        raise FileNotFoundError(f"watchlist {wl} not found")
    if wl.exists():
        out += [str(t).strip().upper() for t in json.loads(wl.read_text())]
    out += BENCHMARKS + SECTOR_FUNDS
    return list(dict.fromkeys(t for t in out if t))

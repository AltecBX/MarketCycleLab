"""Yahoo Finance via yfinance: daily OHLCV, splits, earnings dates, sector/industry.

Prices keep two closes:
* close      split-adjusted, not dividend-adjusted (use for valuation levels)
* adj_close  split- and dividend-adjusted (use for total-return studies)
"""
from __future__ import annotations

import pandas as pd

from . import store
from ..config import HISTORY_START


def _yf():
    try:
        import yfinance as yf
    except ImportError as e:  # pragma: no cover
        raise RuntimeError("pip install yfinance") from e
    return yf


def _naive(idx) -> pd.DatetimeIndex:
    idx = pd.DatetimeIndex(idx)
    if idx.tz is not None:
        idx = idx.tz_convert("America/New_York").tz_localize(None)
    return idx.normalize()


def prices(ticker: str, start: str = HISTORY_START, refresh_hours: float = 12.0) -> pd.DataFrame:
    cached = store.load_frame("prices", ticker, refresh_hours)
    if cached is not None and len(cached):
        return cached
    t = _yf().Ticker(ticker)
    h = t.history(start=start, auto_adjust=False, actions=True)
    if h is None or h.empty:
        raise RuntimeError(f"No Yahoo price data for {ticker}")
    h.index = _naive(h.index)
    cols = {"Open": "open", "High": "high", "Low": "low", "Close": "close", "Adj Close": "adj_close",
            "Volume": "volume", "Dividends": "dividends", "Stock Splits": "splits"}
    df = h.rename(columns=cols)[[c for c in cols.values() if c in h.rename(columns=cols)]]
    if "adj_close" not in df:
        df["adj_close"] = df["close"]
    df = df[~df.index.duplicated(keep="last")].sort_index()
    store.save_frame(df, "prices", ticker)
    return df


def splits(ticker: str, px: pd.DataFrame | None = None) -> pd.Series:
    if px is not None and "splits" in px:
        s = px["splits"]
        return s[s > 0]
    s = _yf().Ticker(ticker).splits
    if s is None or s.empty:
        return pd.Series(dtype=float)
    s.index = _naive(s.index)
    return s[s > 0]


def earnings_dates(ticker: str, limit: int = 60, refresh_hours: float = 24.0) -> pd.DataFrame:
    """Report timestamps with EPS estimate and actual where Yahoo has them.

    Columns: date, timestamp, timing, eps_estimate, eps_actual. Includes the
    next scheduled report (eps_actual NaN). Surprise is recomputed from the
    two EPS columns rather than trusting Yahoo's surprise column units.
    """
    from ..analytics.earnings import classify_timing
    cached = store.load_frame("earnings_yahoo", ticker, refresh_hours, parse_index=False)
    if cached is not None:
        cached["date"] = pd.to_datetime(cached["date"])
        return cached
    try:
        e = _yf().Ticker(ticker).get_earnings_dates(limit=limit)
    except Exception:
        e = None
    if e is None or e.empty:
        return pd.DataFrame(columns=["date", "timestamp", "timing", "eps_estimate", "eps_actual"])
    ts = pd.DatetimeIndex(e.index)
    out = pd.DataFrame({
        "timestamp": ts.astype(str),
        "date": _naive(ts),
        "timing": [classify_timing(x) for x in ts],
        "eps_estimate": pd.to_numeric(e.get("EPS Estimate"), errors="coerce").to_numpy(),
        "eps_actual": pd.to_numeric(e.get("Reported EPS"), errors="coerce").to_numpy(),
    }).sort_values("date").reset_index(drop=True)
    store.save_frame(out, "earnings_yahoo", ticker)
    return out


def profile(ticker: str) -> dict:
    cached = store.load_json("profile", ticker, 24 * 7)
    if cached:
        return cached
    try:
        info = _yf().Ticker(ticker).info or {}
    except Exception:
        info = {}
    keep = {k: info.get(k) for k in ("longName", "shortName", "sector", "industry", "quoteType", "country",
                                     "marketCap", "trailingPE", "forwardPE")}
    store.save_json(keep, "profile", ticker)
    return keep


def many(tickers: list[str], start: str = HISTORY_START) -> dict[str, pd.DataFrame]:
    out = {}
    for t in tickers:
        try:
            out[t] = prices(t, start)
        except Exception as e:
            print(f"  skip {t}: {e}")
    return out


def closes(frames: dict[str, pd.DataFrame], col: str = "adj_close") -> pd.DataFrame:
    return pd.DataFrame({t: f[col] if col in f else f["close"] for t, f in frames.items()}).sort_index()


# Yahoo statement rows (lowercased, letters only) -> MarketCycleLab field, in order of preference
STATEMENT_ROWS = {
    "revenue": ["totalrevenue", "operatingrevenue"],
    "net_income": ["netincome", "netincomecommonstockholders"],
    "op_income": ["operatingincome"],
    "ocf": ["operatingcashflow", "cashflowfromcontinuingoperatingactivities"],
    "capex": ["capitalexpenditure"],
    "unusual": ["totalunusualitems"],     # these two only explain revenue gaps
    "other_income": ["otherincomeexpense"],
}


def quarterly_statements(ticker: str) -> pd.DataFrame:
    """Yahoo's quarterly income and cash flow lines in long form: metric, period_end, value.

    An independent source for checking the SEC reconstruction. Yahoo usually
    carries only the last 5 to 8 quarters and shows restated values.
    """
    import re
    t = _yf().Ticker(ticker)
    frames = []
    for attr in ("quarterly_income_stmt", "quarterly_cashflow"):
        try:
            f = getattr(t, attr)
        except Exception:
            f = None
        if f is not None and not f.empty:
            frames.append(f)
    rows = []
    for f in frames:
        norm = {re.sub(r"[^a-z]", "", str(i).lower()): i for i in f.index}
        for metric, keys in STATEMENT_ROWS.items():
            key = next((k for k in keys if k in norm), None)
            if key is None or any(r["metric"] == metric for r in rows):
                continue
            for col, v in f.loc[norm[key]].items():
                if pd.notna(v):
                    rows.append({"metric": metric, "period_end": pd.Timestamp(col).normalize(), "value": float(v)})
    return pd.DataFrame(rows, columns=["metric", "period_end", "value"])

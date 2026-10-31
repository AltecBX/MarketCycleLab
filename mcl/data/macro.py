"""Market-wide inputs: VIX, 10-year yield, and long-run S&P 500 valuation.

Sources, in order of preference
* VIX:    Yahoo ^VIX daily, else the datahub mirror of CBOE's daily file
* 10y:    FRED DGS10 daily, else Yahoo ^TNX, else datahub monthly
* Shiller monthly S&P 500 (price, dividend, earnings, CPI, long rate, CAPE)
          from the datahub mirror. Prices are MONTHLY AVERAGES of daily
          closes, so drawdowns measured on it are shallower than on daily
          closes (2007 to 2009 is about -52% on monthly averages vs -57% on closes).
"""
from __future__ import annotations

import io
import urllib.request

import pandas as pd

from . import store

DATAHUB = "https://raw.githubusercontent.com/datasets"
URLS = {
    "shiller": f"{DATAHUB}/s-and-p-500/main/data/data.csv",
    "vix_datahub": f"{DATAHUB}/finance-vix/main/data/vix-daily.csv",
    "y10_monthly": f"{DATAHUB}/bond-yields-us-10y/main/data/monthly.csv",
    "sp500_constituents": f"{DATAHUB}/s-and-p-500-companies/main/data/constituents.csv",
    "fred_dgs10": "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10",
}


def _csv(url: str) -> pd.DataFrame:
    req = urllib.request.Request(url, headers={"User-Agent": "MarketCycleLab"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return pd.read_csv(io.BytesIO(r.read()))


def _cached_csv(name: str, hours: float = 24.0) -> pd.DataFrame:
    p = store.path("macro", name)
    if store.fresh(p, hours):
        return pd.read_csv(p)
    try:
        df = _csv(URLS[name])
        df.to_csv(p, index=False)
        return df
    except Exception:
        if p.exists():
            return pd.read_csv(p)
        raise


def shiller() -> pd.DataFrame:
    """Monthly S&P 500 with earnings and CAPE. Zero placeholders for unpublished months become NaN."""
    df = _cached_csv("shiller", 24 * 7)
    df["Date"] = pd.to_datetime(df["Date"])
    df = df.set_index("Date").sort_index()
    df = df.rename(columns={"SP500": "close", "Dividend": "dividend", "Earnings": "earnings",
                            "Consumer Price Index": "cpi", "Long Interest Rate": "long_rate",
                            "Real Price": "real_price", "PE10": "cape"})
    for c in ("dividend", "earnings", "cpi", "long_rate", "real_price", "cape", "Real Dividend", "Real Earnings"):
        if c in df:
            df[c] = df[c].where(df[c] > 0)
    df["pe_trailing"] = df["close"] / df["earnings"]
    return df


def vix() -> pd.Series:
    try:
        from . import yahoo
        return yahoo.prices("^VIX")["close"].rename("vix")
    except Exception:
        df = _cached_csv("vix_datahub")
        df["DATE"] = pd.to_datetime(df["DATE"])
        return df.set_index("DATE")["CLOSE"].rename("vix").sort_index()


def yield10() -> pd.Series:
    """10-year Treasury yield in percent."""
    try:
        df = _cached_csv("fred_dgs10")
        dcol = [c for c in df.columns if "date" in c.lower()][0]
        s = pd.to_numeric(df["DGS10"], errors="coerce")
        s.index = pd.to_datetime(df[dcol])
        return s.dropna().rename("yield10")
    except Exception:
        pass
    try:
        from . import yahoo
        s = yahoo.prices("^TNX")["close"]
        if s.median() > 20:  # some feeds quote 10x the yield
            s = s / 10.0
        return s.rename("yield10")
    except Exception:
        df = _cached_csv("y10_monthly", 24 * 7)
        df["Date"] = pd.to_datetime(df["Date"])
        return df.set_index("Date")["Rate"].rename("yield10")


def sp500_constituents() -> pd.DataFrame:
    """Current S&P 500 members with GICS sector and sub-industry and CIK (survivorship: current members only)."""
    return _cached_csv("sp500_constituents", 24 * 7)

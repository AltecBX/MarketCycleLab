"""Assemble everything one ticker needs: prices, proxies, fundamentals, earnings, regimes.

Every piece is optional. A failed fetch is recorded in `bundle.notes` and the
rest still loads, so an ETF (no fundamentals) or a stock outside the S&P 500
(no GICS row) still works for the price-based studies.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd

from ..config import BASES, FUNDAMENTALS_BASIS, USER_DIR
from . import macro, universe, yahoo


@dataclass
class Bundle:
    ticker: str
    prices: pd.DataFrame
    info: dict = field(default_factory=dict)
    market: pd.DataFrame | None = None
    sector: pd.DataFrame | None = None
    industry: pd.DataFrame | None = None
    quarters: pd.DataFrame | None = None
    ttm: pd.DataFrame | None = None
    valuation: pd.DataFrame | None = None
    metric: str | None = None
    earnings: pd.DataFrame | None = None
    regimes: pd.DataFrame | None = None
    basis: str = "first"
    notes: list[str] = field(default_factory=list)

    @property
    def next_earnings(self):
        if self.earnings is None or self.earnings.empty:
            return None
        last = self.prices.index[-1]
        fut = self.earnings[pd.to_datetime(self.earnings["date"]) > last]
        return fut["date"].min() if len(fut) else None

    @property
    def past_earnings(self) -> pd.DataFrame | None:
        """Quarterly reports up to the last bar; 8-K 2.02 filings that are not reports are left out."""
        if self.earnings is None or self.earnings.empty:
            return None
        e = self.earnings[pd.to_datetime(self.earnings["date"]) <= self.prices.index[-1]]
        if "kind" in e:
            e = e[e["kind"].fillna("report") == "report"]
        return e


def user_prices(ticker: str) -> pd.DataFrame | None:
    """data/user/prices/<TICKER>.csv with Date, Open, High, Low, Close, Volume (any case).

    Lets you drop in data exported from another source, for example a
    GOOGLEFINANCE("TICKER","all",DATE(2015,1,1),TODAY()) sheet saved as CSV.
    """
    p = USER_DIR / "prices" / f"{ticker.upper()}.csv"
    if not p.exists():
        return None
    df = pd.read_csv(p)
    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]
    dcol = "date" if "date" in df else df.columns[0]
    df[dcol] = pd.to_datetime(df[dcol]).dt.normalize()
    df = df.set_index(dcol).sort_index()
    if "adj_close" not in df:
        df["adj_close"] = df["close"]
    return df


def get_prices(ticker: str) -> pd.DataFrame:
    up = user_prices(ticker)
    if up is not None:
        return up
    return yahoo.prices(ticker)


def load(ticker: str, with_fundamentals: bool = True, with_regimes: bool = True,
         market_ticker: str = "SPY", basis: str | None = None) -> Bundle:
    """basis: "first" (each quarter as first reported) or "asof" (restated as of each filing date)."""
    from ..analytics import valuation as val
    from ..analytics import regimes as rg

    tk = ticker.upper()
    basis = (basis or FUNDAMENTALS_BASIS).lower()
    if basis not in BASES:
        raise ValueError(f"basis must be one of {BASES}, got {basis!r}")
    b = Bundle(tk, get_prices(tk), basis=basis)
    try:
        cons = macro.sp500_constituents()
    except Exception as e:
        cons = None
        b.notes.append(f"S&P 500 GICS table unavailable: {e}")
    prof = {}
    if cons is None or tk not in set(cons["Symbol"].str.upper()):
        try:
            prof = yahoo.profile(tk)
        except Exception:
            prof = {}
    b.info = universe.classify(tk, cons, prof)
    for attr, sym in (("market", market_ticker), ("sector", b.info.get("sector_etf")),
                      ("industry", b.info.get("industry_etf"))):
        if sym and sym != tk:
            try:
                setattr(b, attr, get_prices(sym))
            except Exception as e:
                b.notes.append(f"{attr} proxy {sym} unavailable: {e}")
    if with_fundamentals and b.info.get("source") != "proxy":
        try:
            from . import sec
            b.quarters = sec.fundamentals(tk)
            sp = yahoo.splits(tk, b.prices)
            if basis == "asof":
                b.ttm = val.ttm_asof(sec.fundamentals_asof(tk), sp)
                b.notes.append("fundamentals: restated as of each filing date")
            else:
                b.ttm = val.ttm(b.quarters, sp)
            b.valuation = val.daily_multiples(b.prices["close"], b.ttm)
            b.metric = val.suggest_metric(b.info.get("sector"), b.ttm)
        except Exception as e:
            b.notes.append(f"fundamentals unavailable: {e}")
        try:
            from . import sec
            b.earnings = sec.merge_earnings(sec.earnings_releases(tk), yahoo.earnings_dates(tk))
        except Exception as e:
            b.notes.append(f"SEC earnings dates unavailable ({e}); using Yahoo only")
            try:
                b.earnings = yahoo.earnings_dates(tk)
            except Exception as e2:
                b.notes.append(f"earnings dates unavailable: {e2}")
    if with_regimes and b.market is not None:
        try:
            vix = macro.vix()
        except Exception:
            vix = None
        try:
            y10 = macro.yield10()
        except Exception:
            y10 = None
        b.regimes = rg.regime_frame(b.market["close"], vix, y10)
    return b


def sector_closes(col: str = "adj_close") -> pd.DataFrame:
    """Closes for the 11 sector ETFs, the survivorship-free breadth universe."""
    return yahoo.closes(yahoo.many(list(universe.SECTOR_ETFS.values())), col)

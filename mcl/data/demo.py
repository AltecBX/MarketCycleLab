"""Synthetic demo bundle so the pipeline and dashboard run with no network.

Every number it produces is fake. The dashboard labels demo mode on every
page. Use it to learn the screens and to test code, never to draw conclusions.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .loader import Bundle


def _path(rng, n, mu, sigma, idx, start=100.0, shocks=()):
    r = rng.normal(mu, sigma, n)
    for at, size, length in shocks:
        r[at: at + length] += size / length
    return pd.Series(start * np.exp(np.cumsum(r)), index=idx)


def _ohlcv(rng, close: pd.Series) -> pd.DataFrame:
    prev = close.shift(1).fillna(close.iloc[0])
    op = prev * (1 + rng.normal(0, 0.004, len(close)))
    hi = np.maximum(op, close) * (1 + np.abs(rng.normal(0, 0.006, len(close))))
    lo = np.minimum(op, close) * (1 - np.abs(rng.normal(0, 0.006, len(close))))
    vol = rng.lognormal(15, 0.3, len(close)) * (1 + 3 * (close.pct_change().abs().fillna(0) > 0.03))
    return pd.DataFrame({"open": op, "high": hi, "low": lo, "close": close, "adj_close": close, "volume": vol})


def bundle(seed: int = 7, years: int = 11, ticker: str = "DEMO") -> Bundle:
    from ..analytics import valuation as val
    from ..analytics import regimes as rg

    rng = np.random.default_rng(seed)
    n = years * 252
    idx = pd.bdate_range(end=pd.Timestamp.today().normalize() - pd.offsets.BDay(1), periods=n)
    shocks = [(int(n * 0.38), -0.30, 25), (int(n * 0.62), -0.22, 180), (int(n * 0.86), -0.15, 40)]
    mkt = _path(rng, n, 0.0004, 0.010, idx, 250, shocks)
    sec = mkt * _path(rng, n, 0.0001, 0.005, idx, 1.0)
    ind = sec * _path(rng, n, 0.0, 0.006, idx, 1.0)
    stk = ind * _path(rng, n, 0.0002, 0.009, idx, 1.0)
    stk = stk / stk.iloc[0] * 50.0
    b = Bundle(ticker, _ohlcv(rng, stk))
    b.info = {"ticker": ticker, "sector": "Demo sector", "industry": "Demo industry",
              "sector_etf": "DEMO-SECTOR", "industry_etf": "DEMO-INDUSTRY", "peers": [], "source": "synthetic demo"}
    b.market, b.sector, b.industry = _ohlcv(rng, mkt), _ohlcv(rng, sec), _ohlcv(rng, ind)
    qe = pd.date_range(idx[0] - pd.Timedelta(days=400), idx[-1], freq="QE")
    growth = np.exp(np.cumsum(rng.normal(0.03, 0.04, len(qe))))
    rev = 2e9 * growth
    margin = np.clip(0.22 + np.cumsum(rng.normal(0, 0.01, len(qe))), 0.05, 0.45)
    q = pd.DataFrame({"period_end": qe, "filed": qe + pd.Timedelta(days=33), "revenue": rev,
                      "net_income": rev * margin * 0.8, "op_income": rev * margin, "ocf": rev * margin * 1.05,
                      "capex": -rev * 0.06, "shares": 7.0e8, "equity": 8e9, "total_debt": 3e9, "cash": 2e9})
    q = q[q["filed"] <= idx[-1]]
    b.quarters = q
    b.ttm = val.ttm(q)
    b.valuation = val.daily_multiples(b.prices["close"], b.ttm)
    b.metric = "pe"
    rep = q["filed"] - pd.Timedelta(days=5)
    est = q["net_income"] / 1e9 * (1 + rng.normal(0, 0.03, len(q)))
    e = pd.DataFrame({"date": rep, "timing": rng.choice(["amc", "bmo"], len(q)),
                      "eps_actual": q["net_income"] / 1e9, "eps_estimate": est})
    nxt = pd.DataFrame({"date": [idx[-1] + pd.Timedelta(days=12)], "timing": ["amc"], "eps_actual": [np.nan],
                        "eps_estimate": [e["eps_estimate"].iloc[-1] * 1.03]})
    b.earnings = pd.concat([e, nxt], ignore_index=True)
    vix = pd.Series(np.clip(14 + 120 * mkt.pct_change().rolling(20).std().bfill() * 10, 9, 80), index=idx)
    y10 = pd.Series(2.0 + np.cumsum(rng.normal(0, 0.03, n)), index=idx).clip(0.5, 6)
    b.regimes = rg.regime_frame(b.market["close"], vix, y10)
    b.notes.append("SYNTHETIC DEMO DATA: every number on this page is fake.")
    return b

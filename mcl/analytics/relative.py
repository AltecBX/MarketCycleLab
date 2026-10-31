"""Stock vs industry vs sector vs market (research area 9).

The attribution ladder splits a stock's log return over a window into parts
that add up exactly:

    stock = market + (sector - market) + (industry - sector) + (stock - industry)

so "is this company-specific, industry pressure, sector rotation, or the
whole market?" has a numeric answer for any window.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .drawdowns import swing_declines


def _logret(s: pd.Series, window: int) -> pd.Series:
    return np.log(s / s.shift(window))


def attribution(stock: pd.Series, market: pd.Series, sector: pd.Series | None = None,
                industry: pd.Series | None = None, window: int = 63) -> pd.DataFrame:
    """Rolling additive log-return attribution over `window` bars."""
    idx = stock.dropna().index
    s = _logret(stock.reindex(idx), window)
    m = _logret(market.reindex(idx).ffill(), window)
    out = pd.DataFrame(index=idx)
    out["market"] = m
    upper = m
    if sector is not None:
        sec = _logret(sector.reindex(idx).ffill(), window)
        out["sector_vs_market"] = sec - m
        upper = sec
    if industry is not None:
        ind = _logret(industry.reindex(idx).ffill(), window)
        out["industry_vs_sector"] = ind - upper
        upper = ind
    out["company_specific"] = s - upper
    out["total"] = s
    return out


def dominant_driver(row: pd.Series) -> str:
    parts = row.drop(labels=["total"], errors="ignore").dropna()
    if parts.empty:
        return "n/a"
    return str(parts.abs().idxmax())


def rolling_beta(stock: pd.Series, market: pd.Series, window: int = 252) -> pd.Series:
    r = stock.pct_change()
    m = market.reindex(stock.index).ffill().pct_change()
    cov = r.rolling(window, min_periods=window // 2).cov(m)
    var = m.rolling(window, min_periods=window // 2).var()
    return cov / var


def rs_line(stock: pd.Series, ref: pd.Series) -> pd.DataFrame:
    """Relative strength line, its 52-week high flag and its 63-bar change."""
    r = (stock / ref.reindex(stock.index).ffill()).dropna()
    r = r / r.iloc[0]
    out = pd.DataFrame({"rs": r})
    out["rs_52w_high"] = r >= r.rolling(252, min_periods=60).max()
    out["rs_chg_63"] = r / r.shift(63) - 1.0
    return out


def behavior_in_selloffs(stock: pd.Series, market: pd.Series, threshold: float = 0.10,
                         after: int = 63) -> pd.DataFrame:
    """For each market swing decline: how the stock held up and whether it bottomed first.

    lead_bars > 0 means the stock's low came before the market's low.
    """
    mk = market.dropna()
    st = stock.reindex(mk.index).ffill()
    beta = rolling_beta(st, mk).reindex(mk.index)
    rows = []
    for d in swing_declines(mk, threshold).itertuples(index=False):
        if pd.isna(d.end_date):
            continue
        win = st.loc[d.start_date: d.end_date]
        if win.isna().all() or len(win) < 2:
            continue
        s_ret = win.iloc[-1] / win.iloc[0] - 1.0
        s_low_date = win.idxmin()
        s_dd = float((win / win.cummax() - 1.0).min())
        b = beta.get(d.start_date, np.nan)
        m_i = mk.index.get_loc(d.end_date)
        fwd_s = st.iloc[min(m_i + after, len(st) - 1)] / st.iloc[m_i] - 1.0 if m_i + after < len(st) else np.nan
        fwd_m = mk.iloc[min(m_i + after, len(mk) - 1)] / mk.iloc[m_i] - 1.0 if m_i + after < len(mk) else np.nan
        rows.append({
            "market_peak": d.start_date, "market_trough": d.end_date, "market_decline": d.change,
            "stock_return": s_ret, "stock_max_drawdown": s_dd, "excess": s_ret - d.change,
            "beta_at_start": b, "beta_adj_excess": s_ret - (b * d.change if np.isfinite(b) else np.nan),
            "stock_low_date": s_low_date,
            "lead_bars": int(mk.index.get_loc(d.end_date) - mk.index.get_loc(s_low_date)),
            f"stock_after_{after}": fwd_s, f"market_after_{after}": fwd_m,
            f"excess_after_{after}": fwd_s - fwd_m if np.isfinite(fwd_s) and np.isfinite(fwd_m) else np.nan,
        })
    return pd.DataFrame(rows)

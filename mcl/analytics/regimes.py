"""Market conditions that change how patterns behave (research area 10).

All labels are point-in-time. Thresholds are explicit parameters so a result
can be re-run with different definitions to check it is not an artifact of
one cutoff.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .indicators import sma, expanding_pct_rank, pct_from_high


def trend_regime(close: pd.Series, n: int = 200, slope_lookback: int = 20, band: float = 0.0) -> pd.Series:
    """bull: above a rising n-bar average; bear: below a falling one; else sideways."""
    m = sma(close, n)
    slope = m / m.shift(slope_lookback) - 1.0
    above = close > m * (1 + band)
    below = close < m * (1 - band)
    lab = np.select([above & (slope > 0), below & (slope < 0)], ["bull", "bear"], default="sideways")
    s = pd.Series(lab, index=close.index, dtype=object)
    s[m.isna()] = pd.NA
    return s


def vol_regime(vix: pd.Series, cuts=(15.0, 20.0, 30.0)) -> pd.Series:
    labels = ["calm", "normal", "elevated", "stress"]
    b = pd.cut(vix, [-np.inf, *cuts, np.inf], labels=labels)
    return b.astype(object)


def rate_regime(yield_pct: pd.Series, lookback: int = 63, move_bp: float = 25.0) -> pd.Series:
    """rising / falling / stable by the change in yield (in % points) over `lookback` bars."""
    chg = (yield_pct - yield_pct.shift(lookback)) * 100.0
    lab = np.select([chg >= move_bp, chg <= -move_bp], ["rising", "falling"], default="stable")
    s = pd.Series(lab, index=yield_pct.index, dtype=object)
    s[chg.isna()] = pd.NA
    return s


def earnings_growth_regime(eps: pd.Series, periods_per_year: int = 12, lag_periods: int = 3) -> pd.Series:
    """growing / contracting trailing earnings year over year.

    Lagged `lag_periods` rows because trailing earnings are published weeks
    after the period ends (monthly Shiller data: 3 months is conservative).
    """
    e = eps.shift(lag_periods)
    g = e / e.shift(periods_per_year) - 1.0
    lab = np.where(g > 0, "growing", "contracting")
    s = pd.Series(lab, index=eps.index, dtype=object)
    s[g.isna()] = pd.NA
    return s


def breadth(closes: pd.DataFrame, min_names: int = 5) -> pd.DataFrame:
    """Participation across a universe of closes (columns = tickers).

    Survivorship warning: a universe built from today's index members omits
    names that were removed, which overstates historical breadth. Sector ETF
    breadth (11 sectors) is coarse but free of that bias.
    """
    C = closes.sort_index()
    valid = C.notna().sum(axis=1)
    out = pd.DataFrame(index=C.index)
    for n in (50, 200):
        m = C.rolling(n, min_periods=n).mean()
        have = m.notna() & C.notna()
        out[f"pct_above_{n}d"] = ((C > m) & have).sum(axis=1) / have.sum(axis=1).replace(0, np.nan)
    hi = C.rolling(252, min_periods=126).max()
    lo = C.rolling(252, min_periods=126).min()
    have = hi.notna() & C.notna()
    out["pct_52w_high"] = ((C >= hi) & have).sum(axis=1) / have.sum(axis=1).replace(0, np.nan)
    out["pct_52w_low"] = ((C <= lo) & have).sum(axis=1) / have.sum(axis=1).replace(0, np.nan)
    chg = C.diff()
    adv = (chg > 0).sum(axis=1)
    dec = (chg < 0).sum(axis=1)
    out["ad_line"] = (adv - dec).cumsum()
    out["n_names"] = valid
    out[valid < min_names] = np.nan
    return out


def breadth_signals(index_close: pd.Series, br: pd.DataFrame, near_high: float = 0.02,
                    narrow_cut: float = 0.5, wash_cut: float = 0.2, lookback: int = 21) -> pd.DataFrame:
    """Narrow rallies and early repair.

    narrow_rally: index within `near_high` of its 52w high while fewer than
      `narrow_cut` of names are above their 50d average and that share fell
      over `lookback` bars.
    repair_divergence: index within 3% of its 52w low (or lower) while the share
      above 50d has risen from below `wash_cut` over `lookback` bars.
    """
    ix = index_close.reindex(br.index).ffill()
    fh = pct_from_high(ix, 252)
    lowdist = ix / ix.rolling(252, min_periods=126).min() - 1.0
    p50 = br["pct_above_50d"]
    out = pd.DataFrame(index=br.index)
    out["narrow_rally"] = (fh >= -near_high) & (p50 < narrow_cut) & (p50 < p50.shift(lookback))
    out["repair_divergence"] = (lowdist <= 0.03) & (p50.shift(lookback) < wash_cut) & (p50 > p50.shift(lookback) + 0.1)
    return out


def regime_frame(market_close: pd.Series, vix: pd.Series | None = None, yield10: pd.Series | None = None,
                 br: pd.DataFrame | None = None) -> pd.DataFrame:
    """Daily regime labels aligned to the market index."""
    idx = market_close.dropna().index
    out = pd.DataFrame(index=idx)
    out["trend"] = trend_regime(market_close.reindex(idx))
    out["mkt_from_high"] = pct_from_high(market_close.reindex(idx), 252)
    if vix is not None:
        v = vix.reindex(idx).ffill()
        out["vix"] = v
        out["vol"] = vol_regime(v)
        out["vix_pctile"] = expanding_pct_rank(v, 252)
    if yield10 is not None:
        y = yield10.reindex(idx).ffill()
        out["yield10"] = y
        out["rates"] = rate_regime(y)
    if br is not None:
        b = br.reindex(idx).ffill()
        for col in ("pct_above_50d", "pct_above_200d"):
            if col in b:
                out[col] = b[col]
    return out

"""Point-in-time technical features.

Every function here uses only data at or before each row, so a value computed
on a truncated series equals the value computed on the full series for the
same date. tests/test_point_in_time.py enforces that property.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

TRADING_DAYS = 252


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def log_returns(close: pd.Series) -> pd.Series:
    return np.log(close).diff()


def pct_change(close: pd.Series, n: int) -> pd.Series:
    return close / close.shift(n) - 1.0


def pct_from_high(close: pd.Series, n: int = TRADING_DAYS) -> pd.Series:
    """Distance below the rolling n-bar closing high (0 at a high, negative below)."""
    return close / close.rolling(n, min_periods=1).max() - 1.0


def pct_from_low(close: pd.Series, n: int = TRADING_DAYS) -> pd.Series:
    return close / close.rolling(n, min_periods=1).min() - 1.0


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    """Wilder RSI. Recursive smoothing, causal."""
    d = close.diff()
    up = d.clip(lower=0.0)
    dn = (-d).clip(lower=0.0)
    au = up.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()
    ad = dn.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()
    rs = au / ad.replace(0.0, np.nan)
    out = 100.0 - 100.0 / (1.0 + rs)
    out[(ad == 0) & (au > 0)] = 100.0
    return out


def realized_vol(close: pd.Series, n: int = 20, periods_per_year: int = TRADING_DAYS) -> pd.Series:
    return log_returns(close).rolling(n, min_periods=n).std() * np.sqrt(periods_per_year)


def volume_ratio(volume: pd.Series, short: int = 20, long: int = 100) -> pd.Series:
    """Recent average volume relative to the longer baseline (1.0 = normal)."""
    return volume.rolling(short, min_periods=short).mean() / volume.rolling(long, min_periods=long).mean()


def ma_slope(close: pd.Series, n: int = 200, lookback: int = 20) -> pd.Series:
    m = sma(close, n)
    return m / m.shift(lookback) - 1.0


def expanding_pct_rank(s: pd.Series, min_periods: int = 60) -> pd.Series:
    """Percentile of each value within all values up to and including that row (0..1)."""
    return s.expanding(min_periods=min_periods).rank(pct=True)


def rolling_pct_rank(s: pd.Series, window: int, min_periods: int | None = None) -> pd.Series:
    mp = window // 2 if min_periods is None else min_periods
    return s.rolling(window, min_periods=mp).rank(pct=True)


def expanding_zscore(s: pd.Series, min_periods: int = 60) -> pd.Series:
    m = s.expanding(min_periods=min_periods).mean()
    sd = s.expanding(min_periods=min_periods).std()
    return (s - m) / sd


def expanding_quantiles(s: pd.Series, qs=(0.1, 0.25, 0.5, 0.75, 0.9), min_periods: int = 60) -> pd.DataFrame:
    """Point-in-time quantile bands: each row's bands use only history up to that row."""
    out = {}
    for q in qs:
        out[f"q{int(round(q * 100)):02d}"] = s.expanding(min_periods=min_periods).quantile(q)
    return pd.DataFrame(out, index=s.index)


def rolling_quantiles(s: pd.Series, window: int, qs=(0.1, 0.25, 0.5, 0.75, 0.9),
                      min_periods: int | None = None) -> pd.DataFrame:
    mp = window // 2 if min_periods is None else min_periods
    out = {}
    for q in qs:
        out[f"q{int(round(q * 100)):02d}"] = s.rolling(window, min_periods=mp).quantile(q)
    return pd.DataFrame(out, index=s.index)


def technical_features(df: pd.DataFrame) -> pd.DataFrame:
    """Standard causal feature set from an OHLCV frame (needs 'close'; 'volume' optional)."""
    c = df["close"]
    f = pd.DataFrame(index=df.index)
    f["ret_5d"] = pct_change(c, 5)
    f["ret_21d"] = pct_change(c, 21)
    f["ret_63d"] = pct_change(c, 63)
    f["ret_126d"] = pct_change(c, 126)
    f["ret_252d"] = pct_change(c, 252)
    f["from_252d_high"] = pct_from_high(c, 252)
    f["from_252d_low"] = pct_from_low(c, 252)
    f["vs_sma50"] = c / sma(c, 50) - 1.0
    f["vs_sma200"] = c / sma(c, 200) - 1.0
    f["sma200_slope"] = ma_slope(c, 200, 20)
    f["rsi14"] = rsi(c, 14)
    f["vol20"] = realized_vol(c, 20)
    f["vol20_pctile"] = expanding_pct_rank(f["vol20"], 252)
    if "volume" in df and df["volume"].notna().sum() > 120:
        f["volume_ratio"] = volume_ratio(df["volume"], 20, 100)
        f["volume_ratio_5d"] = volume_ratio(df["volume"], 5, 50)
    return f

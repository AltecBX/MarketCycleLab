"""Similar historical situations and what happened next (research area 12).

Each feature is turned into its expanding percentile (where it sat versus its
own history at that time), so features are comparable and causal. Distance is
the root-mean-square percentile gap. Only past dates whose full outcome
window ended before `as_of` are eligible, and picked analogs are at least
`min_gap` bars apart so one episode cannot fill the list.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

DEFAULT_COLS = ["from_252d_high", "ret_21d", "ret_63d", "vs_sma200", "sma200_slope", "vol20_pctile", "rsi14"]


def to_percentiles(features: pd.DataFrame, cols: list[str], min_history: int = 252) -> pd.DataFrame:
    return pd.DataFrame({c: features[c].expanding(min_periods=min_history).rank(pct=True) for c in cols},
                        index=features.index)


def analog_search(features: pd.DataFrame, close: pd.Series, as_of=None, cols: list[str] | None = None,
                  horizons=(21, 63, 126), k: int = 15, min_gap: int = 21, min_history: int = 252,
                  weights: dict[str, float] | None = None) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Nearest past situations to `as_of`; returns (analogs, outcome summary vs base rate)."""
    cols = [c for c in (cols or DEFAULT_COLS) if c in features]
    c = close.reindex(features.index)
    R = to_percentiles(features, cols, min_history)
    complete = R.notna().all(axis=1)
    if as_of is None:
        as_of = R.index[complete.to_numpy()][-1]
    as_of = pd.Timestamp(as_of)
    a_i = R.index.get_loc(as_of)
    H = max(horizons)
    pos = np.arange(len(R))
    eligible = complete.to_numpy() & (pos + H <= a_i)
    w = np.array([(weights or {}).get(col, 1.0) for col in cols])
    diff = (R.to_numpy() - R.iloc[a_i].to_numpy()) ** 2
    dist = np.sqrt((diff * w).sum(axis=1) / w.sum())
    dist[~eligible] = np.inf
    order = np.argsort(dist)
    picked = []
    for i in order:
        if not np.isfinite(dist[i]) or len(picked) >= k:
            break
        if all(abs(i - j) >= min_gap for j in picked):
            picked.append(i)
    v = c.to_numpy(dtype=float)

    def outcomes(i):
        o = {}
        for h in horizons:
            o[f"fwd_{h}"] = v[i + h] / v[i] - 1.0 if i + h < len(v) else np.nan
        seg = v[i + 1: i + H + 1]
        o[f"mae_{H}"] = min(0.0, seg.min() / v[i] - 1.0) if len(seg) else np.nan
        o[f"mfe_{H}"] = max(0.0, seg.max() / v[i] - 1.0) if len(seg) else np.nan
        return o

    rows = []
    for i in picked:
        r = {"date": R.index[i], "distance": dist[i]}
        r.update({f"{col}": features[col].iloc[i] for col in cols})
        r.update(outcomes(i))
        rows.append(r)
    an = pd.DataFrame(rows)
    base_idx = np.nonzero(eligible)[0][::max(1, min_gap // 2)]
    base = pd.DataFrame([outcomes(i) for i in base_idx])
    summ = []
    for col in [f"fwd_{h}" for h in horizons] + [f"mae_{H}"]:
        a, b = (an[col].dropna() if len(an) else pd.Series(dtype=float)), base[col].dropna() if len(base) else pd.Series(dtype=float)
        summ.append({"outcome": col, "analog_n": len(a), "analog_median": a.median(), "analog_pct_positive": (a > 0).mean(),
                     "analog_p10": a.quantile(0.1), "analog_p90": a.quantile(0.9),
                     "base_n": len(b), "base_median": b.median(), "base_pct_positive": (b > 0).mean()})
    return an, pd.DataFrame(summ)

"""Drawdowns and recoveries.

Two layers, so separate selloffs can be told apart from repeated legs of one
extended downturn:

1. Underwater episodes: from a high-water mark (all-time closing high within
   the data) until price closes back at or above it. One episode = one
   extended downturn, however many legs it has.
2. Swing declines: zigzag down legs of at least `threshold`. Each is tagged
   with the underwater episode it belongs to and its leg number inside it,
   and whether it started from a new high or from inside an existing downturn.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .swings import swing_legs


def drawdown_series(close: pd.Series) -> pd.Series:
    c = close.dropna()
    return c / c.cummax() - 1.0


def underwater_episodes(close: pd.Series, min_depth: float = 0.05,
                        depth_marks=(0.05, 0.10, 0.20, 0.30)) -> pd.DataFrame:
    """High-water-mark episodes at least `min_depth` deep.

    Columns: peak/trough/recovery dates and prices, depth, bars and calendar
    days for the decline, recovery and total, bars to reach each depth mark,
    speed, ongoing flag.
    """
    c = close.dropna()
    v = c.to_numpy(dtype=float)
    idx = c.index
    n = len(v)
    out = []
    in_dd = False
    peak_i = trough_i = 0
    hwm = v[0] if n else np.nan
    for i in range(1, n):
        if not in_dd:
            hwm = max(hwm, v[i - 1])
            if v[i] < hwm:
                # not underwater at i-1, so v[i-1] is the high-water mark
                in_dd, peak_i, trough_i = True, i - 1, i
        else:
            if v[i] < v[trough_i]:
                trough_i = i
            if v[i] >= v[peak_i]:
                out.append(_episode(idx, v, peak_i, trough_i, i, depth_marks))
                in_dd = False
    if in_dd:
        out.append(_episode(idx, v, peak_i, trough_i, None, depth_marks))
    df = pd.DataFrame(out)
    if df.empty:
        return df
    return df[df["depth"] <= -abs(min_depth)].reset_index(drop=True)


def _episode(idx, v, p, t, r, marks) -> dict:
    depth = v[t] / v[p] - 1.0
    rec = {
        "peak_date": idx[p], "peak_price": v[p],
        "trough_date": idx[t], "trough_price": v[t], "depth": depth,
        "decline_bars": t - p, "decline_cal_days": (idx[t] - idx[p]).days,
        "recovery_date": idx[r] if r is not None else pd.NaT,
        "recovery_bars": (r - t) if r is not None else np.nan,
        "recovery_cal_days": (idx[r] - idx[t]).days if r is not None else np.nan,
        "total_bars": (r - p) if r is not None else np.nan,
        "ongoing": r is None,
        "speed_per_bar": depth / (t - p) if t > p else np.nan,
        "peak_i": p, "trough_i": t, "recovery_i": r if r is not None else -1,
    }
    seg = v[p: t + 1] / v[p] - 1.0
    for m in marks:
        hit = np.nonzero(seg <= -m)[0]
        rec[f"bars_to_{int(round(m * 100))}pct"] = int(hit[0]) if len(hit) else np.nan
    if r is None:
        rec["current_depth"] = v[-1] / v[p] - 1.0
    return rec


def swing_declines(close: pd.Series, threshold: float = 0.10, near_high: float = 0.03,
                   episodes: pd.DataFrame | None = None) -> pd.DataFrame:
    """Down legs of at least `threshold`, tagged with their parent downturn.

    from_high: leg started within `near_high` of the running all-time high.
    episode_no / leg_in_episode: which extended downturn it belongs to and
    whether it was the first leg or a repeat decline inside it.
    recovery_bars: bars from the trough until close regains the leg's start.
    """
    c = close.dropna()
    v = c.to_numpy(dtype=float)
    legs = swing_legs(c, threshold)
    d = legs[legs["direction"] == "down"].copy()
    if d.empty:
        return d
    hwm = np.maximum.accumulate(v)
    d["depth"] = d["change"]
    d["hwm_at_start"] = [hwm[i] for i in d["start_i"]]
    d["from_high"] = d["start_price"] >= d["hwm_at_start"] * (1 - near_high)
    d["start_below_hwm"] = d["start_price"] / d["hwm_at_start"] - 1.0
    rec_bars, rec_dates = [], []
    for s_i, e_i, sp in zip(d["start_i"], d["end_i"], d["start_price"]):
        after = np.nonzero(v[e_i:] >= sp)[0]
        if len(after):
            rec_bars.append(int(after[0]))
            rec_dates.append(c.index[e_i + after[0]])
        else:
            rec_bars.append(np.nan)
            rec_dates.append(pd.NaT)
    d["recovery_bars"] = rec_bars
    d["recovery_date"] = rec_dates
    ep = underwater_episodes(c, min_depth=0.0) if episodes is None else episodes
    ep_no = []
    for s_i, e_i in zip(d["start_i"], d["end_i"]):
        k = np.nan
        for j, row in enumerate(ep.itertuples(index=False)):
            end = row.recovery_i if row.recovery_i >= 0 else len(v)
            if row.peak_i <= s_i and e_i <= end:
                k = j
                break
        ep_no.append(k)
    d["episode_no"] = ep_no
    d["leg_in_episode"] = d.groupby("episode_no", dropna=False).cumcount() + 1
    d.loc[d["episode_no"].isna(), "leg_in_episode"] = np.nan
    if len(ep):
        depth_map = dict(enumerate(ep["depth"]))
        d["episode_depth"] = d["episode_no"].map(depth_map)
    d["year"] = pd.DatetimeIndex(d["start_date"]).year
    return d.reset_index(drop=True)


def calendar_year_drawdowns(close: pd.Series) -> pd.DataFrame:
    """Per calendar year: return, largest intra-year decline, and when it happened.

    The intra-year decline is the worst close relative to the highest close so
    far that year, with the prior year-end close as the starting point.
    """
    c = close.dropna()
    years = sorted(set(c.index.year))
    rows = []
    for y in years:
        cur = c[c.index.year == y]
        prev = c[c.index.year < y]
        seg = pd.concat([prev.iloc[-1:], cur]) if len(prev) else cur
        dd = seg / seg.cummax() - 1.0
        rows.append({
            "year": y,
            "return": seg.iloc[-1] / seg.iloc[0] - 1.0 if len(prev) else np.nan,
            "max_intra_year_decline": dd.min(),
            "trough_date": dd.idxmin(),
            "partial_year": len(prev) == 0 or y == years[-1],
        })
    return pd.DataFrame(rows)


def annual_selloff_counts(close: pd.Series, thresholds=(0.05, 0.10, 0.20), near_high: float = 0.03) -> pd.DataFrame:
    """Number of swing declines per year at each threshold, split by fresh vs within-downturn."""
    c = close.dropna()
    years = pd.Index(sorted(set(c.index.year)), name="year")
    out = pd.DataFrame(index=years)
    for th in thresholds:
        d = swing_declines(c, th, near_high)
        tag = f"{int(round(th * 100))}pct"
        if d.empty:
            out[f"n_{tag}"] = 0
            out[f"n_{tag}_from_high"] = 0
            continue
        out[f"n_{tag}"] = d.groupby("year").size().reindex(years, fill_value=0)
        out[f"n_{tag}_from_high"] = d[d["from_high"]].groupby("year").size().reindex(years, fill_value=0)
    return out


def summarize_episodes(ep: pd.DataFrame) -> dict:
    """Typical depth, speed and recovery for a set of episodes or declines."""
    if ep is None or ep.empty:
        return {"n": 0}
    done = ep[~ep["ongoing"]] if "ongoing" in ep else ep[ep["recovery_bars"].notna()]
    dep = ep["depth"] if "depth" in ep else ep["change"]
    dbars = ep["decline_bars"] if "decline_bars" in ep else ep["bars"]
    return {
        "n": int(len(ep)),
        "n_recovered": int(len(done)),
        "median_depth": float(dep.median()),
        "p25_depth": float(dep.quantile(0.25)),
        "worst_depth": float(dep.min()),
        "median_decline_bars": float(dbars.median()),
        "median_recovery_bars": float(done["recovery_bars"].median()) if len(done) else np.nan,
        "p75_recovery_bars": float(done["recovery_bars"].quantile(0.75)) if len(done) else np.nan,
    }

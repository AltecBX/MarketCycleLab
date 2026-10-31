"""Moving average streaks: how long the close has stayed on one side, and what followed similar streaks.

For a simple moving average of n sessions on split adjusted closes:
* side       above (close > average) or below
* streak     consecutive sessions on the current side, today included
* history    completed streaks on the same side: median, percentiles, maximum
* outcomes   every past same side streak that reached today's length, measured
             from the day it reached that length over the next h sessions:
             return, whether the streak ended (a close on the other side), and
             whether price fell by more than one typical move (20 session daily
             volatility x sqrt(h)) at any close within the window. Each past
             streak counts once, so the cases do not overlap.
* baseline   the same outcomes over every same side day, to compare against

This is a historical association. It describes what followed; it does not
predict, and the historical maximum is an observation, not a deadline.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd


def runs(close: pd.Series, n: int) -> tuple[pd.DataFrame, np.ndarray, np.ndarray, pd.DatetimeIndex]:
    """Runs of consecutive sessions on one side of the n-session average."""
    sma = close.rolling(n).mean()
    ok = sma.notna() & close.notna()
    c, s = close[ok].to_numpy(float), sma[ok].to_numpy(float)
    if not len(c):
        return pd.DataFrame(columns=["start", "end", "side", "len"]), c, s, close.index[:0]
    side = np.where(c > s, 1, -1)
    starts = np.r_[0, np.flatnonzero(np.diff(side)) + 1]
    ends = np.r_[starts[1:] - 1, len(side) - 1]
    r = pd.DataFrame({"start": starts, "end": ends, "side": side[starts], "len": ends - starts + 1})
    return r, c, s, close.index[ok]


def _typical(c: np.ndarray) -> np.ndarray:
    lr = np.r_[np.nan, np.diff(np.log(c))]
    return pd.Series(lr).rolling(20).std().to_numpy()


def streak_stats(close: pd.Series, n: int, horizons=(3, 5, 10)) -> dict:
    r, c, s, dates = runs(close, n)
    if r.empty:
        return {"sma": n, "n_sessions": 0}
    cur, done = r.iloc[-1], r.iloc[:-1]
    same = done[done["side"] == cur["side"]]
    L = int(cur["len"])
    side = np.repeat(r["side"].to_numpy(), r["len"].to_numpy())
    vol = _typical(c)
    out = {"sma": n, "as_of": dates[-1], "side": "above" if cur["side"] > 0 else "below", "streak": L,
           "distance_pct": 100 * (c[-1] / s[-1] - 1),
           "sma_change_5d_pct": 100 * (s[-1] / s[-6] - 1) if len(s) > 6 else np.nan,
           "pct_days_above": 100 * float((side > 0).mean()), "crossings": int(len(r) - 1),
           "completed_same_side": len(same)}
    if len(same):
        q = same["len"].quantile([0.5, 0.75, 0.9, 0.95])
        out.update({"median_len": float(q[0.5]), "p75_len": float(q[0.75]), "p90_len": float(q[0.9]),
                    "p95_len": float(q[0.95]), "max_len": int(same["len"].max()),
                    "share_reaching_today": float((same["len"] >= L).mean())})
    reached = same[same["len"] >= L]
    for h in horizons:
        rets, ended, drops = [], [], []
        for x in reached.itertuples():
            i = x.start + L - 1
            if i + h >= len(c):
                continue
            rets.append(c[i + h] / c[i] - 1)
            ended.append(x.len - L + 1 <= h)
            t = vol[i] * math.sqrt(h)
            drops.append(bool(np.isfinite(t) and c[i + 1: i + h + 1].min() / c[i] - 1 <= -t))
        base_i = np.flatnonzero(side[: len(side) - h] == cur["side"])
        base_ret = c[base_i + h] / c[base_i] - 1 if len(base_i) else np.array([])
        base_drop = []
        for i in base_i:
            t = vol[i] * math.sqrt(h)
            if np.isfinite(t):
                base_drop.append(c[i + 1: i + h + 1].min() / c[i] - 1 <= -t)
        out[f"h{h}"] = {
            "n": len(rets),
            "median_ret_pct": 100 * float(np.median(rets)) if rets else np.nan,
            "p10_ret_pct": 100 * float(np.percentile(rets, 10)) if len(rets) >= 5 else np.nan,
            "pct_streak_ended": 100 * float(np.mean(ended)) if ended else np.nan,
            "pct_drop_gt_typical": 100 * float(np.mean(drops)) if drops else np.nan,
            "base_n": len(base_ret),
            "base_median_ret_pct": 100 * float(np.median(base_ret)) if len(base_ret) else np.nan,
            "base_pct_drop_gt_typical": 100 * float(np.mean(base_drop)) if base_drop else np.nan,
        }
    return out

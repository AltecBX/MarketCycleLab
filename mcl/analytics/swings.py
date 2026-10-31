"""Swing structure: peaks, troughs, rallies and declines.

A swing pivot is confirmed only once price has reversed by `threshold` from it.
Every pivot carries two dates:

* date          when the high or low printed (known only in hindsight)
* confirm_date  first bar on which the pivot was knowable

Descriptive statistics may use `date`. Anything used as a signal must use
`confirm_date` or the causal `swing_state` frame, which never looks ahead.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def zigzag(close: pd.Series, threshold: float) -> pd.DataFrame:
    """Close-based zigzag pivots.

    Returns columns: date, price, kind ('peak'|'trough'), i, confirm_date,
    confirm_i, confirmed. The last row is the unconfirmed candidate extreme.
    """
    c = close.dropna()
    v = c.to_numpy(dtype=float)
    idx = c.index
    n = len(v)
    rows: list[tuple] = []
    if n < 2:
        return _pivot_frame(rows)
    th = float(threshold)
    hi = lo = 0
    trend = 0
    ext = 0
    for i in range(1, n):
        x = v[i]
        if trend == 0:
            if x > v[hi]:
                hi = i
            if x < v[lo]:
                lo = i
            if hi < i and x <= v[hi] * (1 - th):
                rows.append((hi, "peak", i))
                trend, ext = -1, i
            elif lo < i and x >= v[lo] * (1 + th):
                rows.append((lo, "trough", i))
                trend, ext = 1, i
        elif trend == -1:
            if x < v[ext]:
                ext = i
            elif x >= v[ext] * (1 + th):
                rows.append((ext, "trough", i))
                trend, ext = 1, i
        else:
            if x > v[ext]:
                ext = i
            elif x <= v[ext] * (1 - th):
                rows.append((ext, "peak", i))
                trend, ext = -1, i
    if trend != 0:
        rows.append((ext, "trough" if trend == -1 else "peak", None))
    out = []
    for i, kind, ci in rows:
        out.append({
            "date": idx[i], "price": v[i], "kind": kind, "i": i,
            "confirm_date": idx[ci] if ci is not None else pd.NaT,
            "confirm_i": ci if ci is not None else -1,
            "confirmed": ci is not None,
        })
    return _pivot_frame(out)


def _pivot_frame(rows) -> pd.DataFrame:
    cols = ["date", "price", "kind", "i", "confirm_date", "confirm_i", "confirmed"]
    if not rows:
        return pd.DataFrame(columns=cols)
    return pd.DataFrame(rows, columns=cols)


def swing_legs(close: pd.Series, threshold: float) -> pd.DataFrame:
    """Legs between consecutive pivots, with size, duration and speed.

    `complete` is True when both ends are confirmed. The final leg runs to the
    unconfirmed candidate extreme and is marked incomplete.
    """
    c = close.dropna()
    piv = zigzag(c, threshold)
    cols = ["direction", "start_date", "end_date", "start_price", "end_price", "change",
            "bars", "cal_days", "speed_per_bar", "start_confirm_date", "end_confirm_date",
            "complete", "start_i", "end_i"]
    if len(piv) < 2:
        return pd.DataFrame(columns=cols)
    out = []
    for a, b in zip(piv.itertuples(index=False), piv.iloc[1:].itertuples(index=False)):
        chg = b.price / a.price - 1.0
        bars = int(b.i - a.i)
        out.append({
            "direction": "up" if a.kind == "trough" else "down",
            "start_date": a.date, "end_date": b.date,
            "start_price": a.price, "end_price": b.price, "change": chg,
            "bars": bars, "cal_days": (b.date - a.date).days,
            "speed_per_bar": chg / bars if bars else np.nan,
            "start_confirm_date": a.confirm_date, "end_confirm_date": b.confirm_date,
            "complete": bool(a.confirmed and b.confirmed),
            "start_i": int(a.i), "end_i": int(b.i),
        })
    return pd.DataFrame(out, columns=cols)


def swing_state(close: pd.Series, threshold: float) -> pd.DataFrame:
    """Causal daily swing state.

    For each bar: direction of the current leg as known that day, the last
    confirmed pivot, the move from it, bars since it, the extreme reached so
    far in this leg, and the pullback from that extreme.
    """
    c = close.dropna()
    v = c.to_numpy(dtype=float)
    n = len(v)
    th = float(threshold)
    direction = np.full(n, np.nan)
    piv_price = np.full(n, np.nan)
    piv_i = np.full(n, -1, dtype=int)
    ext_price = np.full(n, np.nan)
    leg_no = np.zeros(n, dtype=int)
    hi = lo = 0
    trend = 0
    ext = 0
    last_p = -1
    legs = 0
    for i in range(n):
        x = v[i]
        if i > 0:
            if trend == 0:
                if x > v[hi]:
                    hi = i
                if x < v[lo]:
                    lo = i
                if hi < i and x <= v[hi] * (1 - th):
                    last_p, trend, ext, legs = hi, -1, i, legs + 1
                elif lo < i and x >= v[lo] * (1 + th):
                    last_p, trend, ext, legs = lo, 1, i, legs + 1
            elif trend == -1:
                if x < v[ext]:
                    ext = i
                elif x >= v[ext] * (1 + th):
                    last_p, trend, legs = ext, 1, legs + 1
                    ext = i
            else:
                if x > v[ext]:
                    ext = i
                elif x <= v[ext] * (1 - th):
                    last_p, trend, legs = ext, -1, legs + 1
                    ext = i
        if trend != 0:
            direction[i] = trend
            piv_price[i] = v[last_p]
            piv_i[i] = last_p
            ext_price[i] = v[ext]
            leg_no[i] = legs
    out = pd.DataFrame(index=c.index)
    out["direction"] = direction
    out["pivot_price"] = piv_price
    out["pivot_date"] = pd.Series(c.index[np.clip(piv_i, 0, None)], index=c.index).where(piv_i >= 0)
    out["leg_move"] = v / piv_price - 1.0
    out["bars_in_leg"] = np.where(piv_i >= 0, np.arange(n) - piv_i, np.nan)
    out["leg_extreme"] = ext_price
    out["leg_extreme_move"] = ext_price / piv_price - 1.0
    out["from_leg_extreme"] = v / ext_price - 1.0
    out["leg_no"] = leg_no
    return out


def completed_leg_sizes(legs: pd.DataFrame, direction: str, as_of=None) -> pd.Series:
    """Absolute sizes of completed legs, optionally only those knowable by `as_of`."""
    d = legs[(legs["direction"] == direction) & legs["complete"]]
    if as_of is not None:
        d = d[d["end_confirm_date"] <= pd.Timestamp(as_of)]
    return d["change"].abs().reset_index(drop=True)


def remaining_move_odds(sizes: pd.Series, current: float, extras=(0.05, 0.10, 0.20)) -> dict:
    """Given completed leg sizes, P(final size >= current + extra | final size >= current).

    `current` and `extras` are absolute magnitudes (0.25 = 25%). Answers how much
    further rallies or declines of this size usually ran once they got this far.
    """
    s = pd.Series(sizes, dtype=float).dropna()
    reached = s[s >= current]
    res = {"current": current, "n_completed": int(len(s)), "n_reached": int(len(reached)),
           "pctile_of_current": float((s < current).mean()) if len(s) else np.nan,
           "median_final_if_reached": float(reached.median()) if len(reached) else np.nan}
    for e in extras:
        k = int((reached >= current + e).sum())
        res[f"p_extra_{int(round(e * 100))}"] = k / len(reached) if len(reached) else np.nan
    return res

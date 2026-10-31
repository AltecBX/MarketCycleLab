"""Event studies for rallies, selloffs, bounces and pullbacks (research areas 6, 7, 8).

Every event is stamped on the first bar it was knowable. Features come from
data up to that bar. Outcomes come from the bars after it and are only used
to score the event, never to define it.

Outcome labeling uses first passage ("which comes first"): from the event
close, does price reach +up before -down within `horizon` bars? That captures
both the favorable move and the pain endured first (MAE).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .indicators import technical_features
from .swings import swing_legs, swing_state


def first_passage(close: pd.Series, start_i: int, up: float, down: float, horizon: int,
                  high: pd.Series | None = None, low: pd.Series | None = None) -> dict:
    """Which barrier price touches first after bar `start_i`.

    Uses highs and lows when given (touch), otherwise closes. If both barriers
    are touched on the same bar the outcome is 'both' and treated as a failure
    for the upside barrier, the conservative reading.
    """
    v = close.to_numpy(dtype=float)
    n = len(v)
    entry = v[start_i]
    end = min(n - 1, start_i + horizon)
    res = {"entry": entry, "outcome": "open", "bars_to_outcome": np.nan, "mae": np.nan, "mfe": np.nan,
           "ret_horizon": np.nan, "complete": end - start_i >= horizon}
    if end <= start_i:
        return res
    hv = (high.to_numpy(dtype=float) if high is not None else v)[start_i + 1: end + 1]
    lv = (low.to_numpy(dtype=float) if low is not None else v)[start_i + 1: end + 1]
    up_hits = np.nonzero(hv >= entry * (1 + up))[0]
    dn_hits = np.nonzero(lv <= entry * (1 - down))[0]
    u = up_hits[0] if len(up_hits) else None
    d = dn_hits[0] if len(dn_hits) else None
    if u is None and d is None:
        res["outcome"] = "none" if res["complete"] else "open"
        stop = len(hv) - 1
    elif d is None or (u is not None and u < d):
        res["outcome"], stop = "up", u
    elif u is None or d < u:
        res["outcome"], stop = "down", d
    else:
        res["outcome"], stop = "both", u
    if res["outcome"] in ("up", "down", "both"):
        res["bars_to_outcome"] = int(stop + 1)
    res["mae"] = min(0.0, float(lv[: stop + 1].min() / entry - 1.0))
    res["mfe"] = max(0.0, float(hv[: stop + 1].max() / entry - 1.0))
    if res["complete"]:
        res["ret_horizon"] = float(v[end] / entry - 1.0)
    return res


def forward_returns(close: pd.Series, horizons=(5, 21, 63, 126, 252)) -> pd.DataFrame:
    out = pd.DataFrame(index=close.index)
    for h in horizons:
        out[f"fwd_{h}"] = close.shift(-h) / close - 1.0
    return out


def forward_mae(close: pd.Series, horizon: int) -> pd.Series:
    """Worst close within the next `horizon` bars relative to today's close."""
    v = close.to_numpy(dtype=float)
    n = len(v)
    out = np.full(n, np.nan)
    for i in range(n - horizon):
        out[i] = v[i + 1: i + horizon + 1].min() / v[i] - 1.0
    return pd.Series(out, index=close.index)


def _attach_features(events: pd.DataFrame, feats: pd.DataFrame) -> pd.DataFrame:
    if events.empty:
        return events
    f = feats.reindex(pd.DatetimeIndex(events["date"]))
    f.index = events.index
    return pd.concat([events, f], axis=1)


def _first_per_leg(st: pd.DataFrame, mask: pd.Series) -> list:
    """First date in each swing leg (same pivot) where mask is true."""
    hit = st[mask.to_numpy()]
    if hit.empty:
        return []
    return list(hit.groupby("pivot_date", sort=True).head(1).index)


def _race(fut: np.ndarray, up_level: float, down_level: float, down_strict: bool = False):
    """First index where fut >= up_level and first where fut <= (or <) down_level."""
    u = np.nonzero(fut >= up_level)[0]
    d = np.nonzero(fut < down_level)[0] if down_strict else np.nonzero(fut <= down_level)[0]
    return (int(u[0]) if len(u) else None), (int(d[0]) if len(d) else None)


def rally_checkpoints(df: pd.DataFrame, threshold: float = 0.10, checkpoints=(0.15, 0.25, 0.40),
                      extend: float = 0.10, pullback: float = 0.10, horizon: int = 126,
                      context: pd.DataFrame | None = None) -> pd.DataFrame:
    """Rally exhaustion study (area 6).

    Event: the first bar on which a rally, measured from its confirmed swing
    low, reaches each checkpoint gain. Outcome: does it extend a further
    `extend` before a `pullback` from the event close (hit = continued)?
    Also records how far the whole rally ran in the end (final_gain), known
    only in hindsight, for the "how far do rallies go" distribution.
    """
    c = df["close"].dropna()
    st = swing_state(c, threshold)
    legs = swing_legs(c, threshold)
    feats = technical_features(df.loc[c.index])
    if context is not None:
        feats = feats.join(context, how="left")
    up_legs = legs[legs["direction"] == "up"]
    rows = []
    for cp in checkpoints:
        if cp < threshold:
            continue
        m = (st["direction"] == 1) & (st["leg_move"] >= cp)
        for t in _first_per_leg(st, m):
            i = c.index.get_loc(t)
            piv = st.at[t, "pivot_date"]
            leg = up_legs[up_legs["start_date"] == piv]
            fp = first_passage(c, i, extend, pullback, horizon)
            rows.append({
                "date": t, "checkpoint": cp, "rally_start": piv, "gain_at_event": st.at[t, "leg_move"],
                "bars_since_low": st.at[t, "bars_in_leg"],
                "speed": st.at[t, "leg_move"] / max(st.at[t, "bars_in_leg"], 1),
                "from_rally_high": st.at[t, "from_leg_extreme"],
                "final_gain": leg["change"].iloc[0] if len(leg) else np.nan,
                "final_bars": leg["bars"].iloc[0] if len(leg) else np.nan,
                "rally_complete": bool(leg["complete"].iloc[0]) if len(leg) else False,
                **{f"fp_{k}": v for k, v in fp.items()},
            })
    ev = pd.DataFrame(rows)
    if ev.empty:
        return ev
    ev["continued"] = ev["fp_outcome"].map({"up": True, "down": False, "both": False, "none": False}).astype("boolean")
    return _attach_features(ev.sort_values("date").reset_index(drop=True), feats)


def selloff_checkpoints(df: pd.DataFrame, threshold: float = 0.10, checkpoints=(0.15, 0.25, 0.35),
                        further: float = 0.10, rebound: float = 0.15, horizon: int = 126,
                        context: pd.DataFrame | None = None) -> pd.DataFrame:
    """Selling exhaustion study (area 7).

    Event: first bar a decline from its confirmed swing high reaches each
    checkpoint depth. Outcome: does price fall a further `further` before it
    rebounds `rebound` (hit = more downside first)? Also: additional downside
    to the eventual trough and bars until the durable low.
    """
    c = df["close"].dropna()
    v = c.to_numpy(dtype=float)
    st = swing_state(c, threshold)
    legs = swing_legs(c, threshold)
    feats = technical_features(df.loc[c.index])
    if context is not None:
        feats = feats.join(context, how="left")
    dn_legs = legs[legs["direction"] == "down"]
    rows = []
    for cp in checkpoints:
        if cp < threshold:
            continue
        m = (st["direction"] == -1) & (st["leg_move"] <= -cp)
        for t in _first_per_leg(st, m):
            i = c.index.get_loc(t)
            piv = st.at[t, "pivot_date"]
            leg = dn_legs[dn_legs["start_date"] == piv]
            fp = first_passage(c, i, rebound, further, horizon)
            final = leg["change"].iloc[0] if len(leg) else np.nan
            extra, bars_to_low = np.nan, np.nan
            if len(leg) and bool(leg["complete"].iloc[0]):
                trough_i = int(leg["end_i"].iloc[0])
                extra = v[trough_i] / v[i] - 1.0 if trough_i > i else 0.0
                bars_to_low = max(trough_i - i, 0)
            rows.append({
                "date": t, "checkpoint": cp, "selloff_start": piv, "depth_at_event": st.at[t, "leg_move"],
                "bars_since_high": st.at[t, "bars_in_leg"],
                "final_depth": final,
                "extra_downside": extra,
                "bars_to_low": bars_to_low,
                "selloff_complete": bool(leg["complete"].iloc[0]) if len(leg) else False,
                **{f"fp_{k}": val for k, val in fp.items()},
            })
    ev = pd.DataFrame(rows)
    if ev.empty:
        return ev
    ev["more_downside_first"] = ev["fp_outcome"].map({"down": True, "up": False, "both": True, "none": False}).astype("boolean")
    return _attach_features(ev.sort_values("date").reset_index(drop=True), feats)


def bounce_events(df: pd.DataFrame, decline: float = 0.20, bounce: float = 0.10, retrace: float = 0.5,
                  lookback: int = 252, horizon: int = 252, context: pd.DataFrame | None = None) -> pd.DataFrame:
    """Temporary rebound vs sustained recovery (area 8, first half).

    Event: a swing low that sits at least `decline` below the highest close of
    the prior `lookback` bars, stamped on the bar a `bounce` off that low
    confirms it. Outcome: sustained = price retraces `retrace` of the whole
    drawdown (low back toward the lookback high) before closing below the low.
    Bounces inside one long bear market each count as separate events.
    """
    c = df["close"].dropna()
    v = c.to_numpy(dtype=float)
    legs = swing_legs(c, bounce)
    feats = technical_features(df.loc[c.index])
    if context is not None:
        feats = feats.join(context, how="left")
    roll_high = c.rolling(lookback, min_periods=1).max().to_numpy()
    rows = []
    for leg in legs[legs["direction"] == "down"].itertuples(index=False):
        if pd.isna(leg.end_confirm_date):
            continue
        lo_i = leg.end_i
        low, high = v[lo_i], roll_high[lo_i]
        dd = low / high - 1.0
        if dd > -decline:
            continue
        t = leg.end_confirm_date
        i = c.index.get_loc(t)
        target = low + retrace * (high - low)
        fut = v[i + 1: i + 1 + horizon]
        u, d = _race(fut, target, low, down_strict=True)
        if u is None and d is None:
            outcome, stop = ("open" if len(fut) < horizon else "neither"), len(fut) - 1
        elif d is None or (u is not None and u < d):
            outcome, stop = "sustained", u
        else:
            outcome, stop = "failed", d
        rows.append({
            "date": t, "low_date": leg.end_date, "drawdown_at_low": dd, "leg_depth": leg.change,
            "leg_bars": leg.bars, "bounce_bars": i - lo_i, "bounce_at_event": v[i] / low - 1.0,
            "bounce_speed_vs_decline": ((v[i] / low - 1.0) / max(i - lo_i, 1)) / (abs(leg.change) / max(leg.bars, 1)),
            "outcome": outcome,
            "bars_to_outcome": stop + 1 if outcome in ("sustained", "failed") else np.nan,
            "mae_before_outcome": min(0.0, float(fut[: stop + 1].min() / v[i] - 1.0)) if len(fut) else np.nan,
        })
    ev = pd.DataFrame(rows)
    if ev.empty:
        return ev
    ev["sustained"] = ev["outcome"].map({"sustained": True, "failed": False, "neither": False}).astype("boolean")
    return _attach_features(ev.sort_values("date").reset_index(drop=True), feats)


def pullback_events(df: pd.DataFrame, pullback: float = 0.08, deep: float = 0.20, horizon: int = 252,
                    require_uptrend: bool = True, context: pd.DataFrame | None = None) -> pd.DataFrame:
    """Normal pullback vs start of a larger downturn (area 8, second half).

    Event: the bar a `pullback` decline from a swing high is first confirmed,
    taken only while the 200-day average is rising (uptrend). Outcome: normal =
    closes back at or above that high before closing `deep` below it.
    """
    c = df["close"].dropna()
    v = c.to_numpy(dtype=float)
    st = swing_state(c, pullback)
    feats = technical_features(df.loc[c.index])
    if context is not None:
        feats = feats.join(context, how="left")
    m = st["direction"] == -1
    first = m & ~m.shift(1, fill_value=False)
    rows = []
    for t in st.index[first.to_numpy()]:
        if require_uptrend and not (feats.at[t, "sma200_slope"] > 0):
            continue
        i = c.index.get_loc(t)
        high = st.at[t, "pivot_price"]
        fut = v[i + 1: i + 1 + horizon]
        u, d = _race(fut, high, high * (1 - deep))
        if u is None and d is None:
            outcome, stop = ("open" if len(fut) < horizon else "neither"), len(fut) - 1
        elif d is None or (u is not None and u < d):
            outcome, stop = "normal", u
        else:
            outcome, stop = "downturn", d
        rows.append({
            "date": t, "swing_high_date": st.at[t, "pivot_date"], "depth_at_event": v[i] / high - 1.0,
            "bars_from_high": st.at[t, "bars_in_leg"], "outcome": outcome,
            "bars_to_outcome": stop + 1 if outcome in ("normal", "downturn") else np.nan,
            "max_depth_before_outcome": float(fut[: stop + 1].min() / high - 1.0) if len(fut) else np.nan,
        })
    ev = pd.DataFrame(rows)
    if ev.empty:
        return ev
    ev["normal_pullback"] = ev["outcome"].map({"normal": True, "downturn": False, "neither": False}).astype("boolean")
    return _attach_features(ev.sort_values("date").reset_index(drop=True), feats)

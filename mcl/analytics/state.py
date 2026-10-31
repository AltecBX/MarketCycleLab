"""Where is it in its cycle right now? Snapshot, phase label, and alerts.

The phase label is a transparent rule set, not a forecast. Each alert cites
the historical comparison it came from (how many completed swings, which
percentile), so it can be checked rather than trusted.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .indicators import technical_features
from .swings import swing_legs, swing_state, completed_leg_sizes, remaining_move_odds
from .drawdowns import underwater_episodes

PHASES = {
    "early_recovery": "Starting: new swing low confirmed, early in the rebound",
    "uptrend": "Continuing: rising trend, rally size still typical",
    "extended": "Stretched: rally already large versus its own history",
    "stalling": "Stalling: off the rally high, momentum fading",
    "pullback_in_uptrend": "Pullback inside a rising long-term trend",
    "downtrend": "Declining: below a falling 200-day average",
    "late_selloff": "Selloff already large versus its own history",
    "range": "Sideways: no clear trend",
}


def snapshot(df: pd.DataFrame, threshold: float = 0.10, as_of=None, valuation: pd.DataFrame | None = None,
             val_metric: str | None = None, next_earnings=None) -> dict:
    c = df["close"].dropna()
    if as_of is not None:
        c = c[c.index <= pd.Timestamp(as_of)]
        df = df.loc[c.index]
    t = c.index[-1]
    f = technical_features(df).iloc[-1]
    st = swing_state(c, threshold).iloc[-1]
    legs = swing_legs(c, threshold)
    snap = {"date": t, "close": float(c.iloc[-1]), "threshold": threshold}
    for k in ("ret_21d", "ret_63d", "ret_252d", "from_252d_high", "vs_sma50", "vs_sma200", "sma200_slope",
              "rsi14", "vol20_pctile", "volume_ratio"):
        if k in f:
            snap[k] = float(f[k]) if pd.notna(f[k]) else np.nan
    d = st["direction"]
    snap["swing_direction"] = "up" if d == 1 else "down" if d == -1 else "n/a"
    snap["leg_move"] = float(st["leg_move"])
    snap["bars_in_leg"] = float(st["bars_in_leg"])
    snap["from_leg_extreme"] = float(st["from_leg_extreme"])
    snap["leg_start"] = st["pivot_date"]
    direction = "up" if d == 1 else "down"
    sizes = completed_leg_sizes(legs, direction, as_of=t)
    snap["leg_history_n"] = int(len(sizes))
    if len(sizes) and np.isfinite(snap["leg_move"]):
        odds = remaining_move_odds(sizes, abs(snap["leg_move"]))
        snap["leg_pctile"] = odds["pctile_of_current"]
        snap["leg_median_size"] = float(sizes.median())
        snap.update({f"leg_{k}": v for k, v in odds.items() if k.startswith("p_extra")})
        dur = legs[(legs["direction"] == direction) & legs["complete"] & (legs["end_confirm_date"] <= t)]["bars"]
        snap["leg_bars_pctile"] = float((dur < snap["bars_in_leg"]).mean()) if len(dur) else np.nan
    ep = underwater_episodes(c, 0.0)
    cur_dd = float(c.iloc[-1] / c.cummax().iloc[-1] - 1.0)
    snap["drawdown_from_ath"] = cur_dd
    if valuation is not None and val_metric and val_metric in valuation:
        v = valuation[val_metric].dropna()
        v = v[v.index <= t]
        if len(v) > 252:
            snap["valuation_metric"] = val_metric
            snap["valuation"] = float(v.iloc[-1])
            snap["valuation_pctile"] = float((v < v.iloc[-1]).mean())
    if next_earnings is not None and pd.notna(next_earnings):
        snap["days_to_earnings"] = int(np.busday_count(t.date(), pd.Timestamp(next_earnings).date()))
    snap["phase"] = phase_label(snap)
    snap["phase_text"] = PHASES.get(snap["phase"], "")
    snap["alerts"] = alerts(snap)
    return snap


def phase_label(s: dict) -> str:
    up = s.get("swing_direction") == "up"
    slope = s.get("sma200_slope", np.nan)
    vs200 = s.get("vs_sma200", np.nan)
    pct = s.get("leg_pctile", np.nan)
    bars = s.get("bars_in_leg", np.nan)
    off_high = s.get("from_leg_extreme", 0.0)
    if up:
        if np.isfinite(bars) and bars <= 15:
            return "early_recovery"
        if np.isfinite(pct) and pct >= 0.75:
            return "stalling" if off_high <= -0.05 else "extended"
        if off_high <= -0.05:
            return "stalling"
        if slope > 0:
            return "uptrend"
        return "range"
    if np.isfinite(pct) and pct >= 0.75:
        return "late_selloff"
    if slope > 0 and vs200 > -0.05:
        return "pullback_in_uptrend"
    if slope < 0 and vs200 < 0:
        return "downtrend"
    return "range"


def alerts(s: dict) -> list[str]:
    a = []
    n = s.get("leg_history_n", 0)
    pct = s.get("leg_pctile", np.nan)
    move = s.get("leg_move", np.nan)
    if np.isfinite(pct) and n >= 5:
        kind = "rally" if s.get("swing_direction") == "up" else "decline"
        if pct >= 0.75:
            a.append(f"{kind.title()} of {move:+.0%} is larger than {pct:.0%} of {n} completed {kind}s "
                     f"(median {s.get('leg_median_size', np.nan):.0%}).")
        p10 = s.get("leg_p_extra_10", np.nan)
        if np.isfinite(p10):
            a.append(f"Of past {kind}s that got this far, {p10:.0%} went at least 10% further.")
    elif n < 5:
        a.append(f"Only {n} completed swings at this threshold. Too few to compare.")
    vp = s.get("valuation_pctile", np.nan)
    if np.isfinite(vp) and (vp >= 0.9 or vp <= 0.1):
        a.append(f"{s.get('valuation_metric', 'valuation').upper()} {s.get('valuation', np.nan):.1f} is at the "
                 f"{vp:.0%} percentile of its own history.")
    de = s.get("days_to_earnings")
    if de is not None and 0 <= de <= 10:
        a.append(f"Earnings in {de} trading days.")
    r = s.get("rsi14", np.nan)
    if np.isfinite(r) and (r >= 75 or r <= 25):
        a.append(f"RSI(14) at {r:.0f}.")
    vr = s.get("volume_ratio", np.nan)
    if np.isfinite(vr) and vr >= 1.5:
        a.append(f"20-day volume {vr:.1f}x its 100-day average.")
    return a


def scan(bundles: dict[str, dict], threshold: float = 0.10) -> pd.DataFrame:
    """Watchlist table. bundles[ticker] = {'prices': df, 'valuation': df?, 'metric': str?, 'next_earnings': ts?}."""
    rows = []
    for tk, b in bundles.items():
        try:
            s = snapshot(b["prices"], threshold, valuation=b.get("valuation"), val_metric=b.get("metric"),
                         next_earnings=b.get("next_earnings"))
        except Exception as e:  # keep scanning the rest
            rows.append({"ticker": tk, "error": str(e)})
            continue
        rows.append({"ticker": tk, "phase": s["phase"], "close": s["close"], "leg": s["swing_direction"],
                     "leg_move": s["leg_move"], "leg_pctile": s.get("leg_pctile"), "leg_n": s.get("leg_history_n"),
                     "from_252d_high": s.get("from_252d_high"), "vs_sma200": s.get("vs_sma200"),
                     "rsi14": s.get("rsi14"), "valuation_pctile": s.get("valuation_pctile"),
                     "days_to_earnings": s.get("days_to_earnings"), "alerts": " | ".join(s["alerts"])})
    return pd.DataFrame(rows)

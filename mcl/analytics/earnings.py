"""Behavior before and after earnings (research area 3).

Reaction day (t0) depends on report timing:
* 'amc' (after the close): t0 = next trading day
* 'bmo' (before the open) or 'dmh' (during market hours): t0 = report date
* 'unknown': t0 = report date or next trading day if the date is not a session; flagged

Windows are in trading days around t0 using closes:
pre_N   close[t0-1] / close[t0-1-N]   run-up into the report
gap     open[t0] / close[t0-1]         overnight reaction (needs opens)
day0    close[t0] / close[t0-1]        full reaction day
post_K  close[t0+K] / close[t0]        drift after the reaction
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .evidence import conditional_table

PRE = (5, 10, 20)
POST = (1, 5, 10, 20, 40, 60)


def reaction_index(trading_index: pd.DatetimeIndex, report_date, timing: str = "unknown") -> int | None:
    d = pd.Timestamp(report_date).normalize()
    pos = int(trading_index.searchsorted(d, side="left"))
    if pos >= len(trading_index):
        return None
    on_session = trading_index[pos].normalize() == d
    if str(timing).lower() == "amc" and on_session:
        pos += 1
    return pos if pos < len(trading_index) else None


def classify_timing(ts) -> str:
    """Map a report timestamp (US Eastern) to bmo / dmh / amc / unknown."""
    t = pd.Timestamp(ts)
    if t.tzinfo is not None:
        t = t.tz_convert("America/New_York")
    if t.hour == 0 and t.minute == 0:
        return "unknown"
    minutes = t.hour * 60 + t.minute
    if minutes < 9 * 60 + 30:
        return "bmo"
    if minutes >= 16 * 60:
        return "amc"
    return "dmh"


def event_study(prices: pd.DataFrame, events: pd.DataFrame, benchmark: pd.Series | None = None,
                context: pd.DataFrame | None = None, path_window=(-20, 60)) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Per-report table plus the price path around each report.

    `events` needs 'date' and optionally 'timing', 'eps_actual', 'eps_estimate',
    'surprise_pct', 'rev_actual', 'rev_estimate', 'guidance'. `context` is a
    daily frame (e.g. valuation percentile, regime) sampled at t0-1, the last
    close before the report, so it reflects what was known going in.
    """
    p = prices.dropna(subset=["close"])
    idx = p.index
    c = p["close"].to_numpy(dtype=float)
    o = p["open"].to_numpy(dtype=float) if "open" in p else None
    b = benchmark.reindex(idx).ffill().to_numpy(dtype=float) if benchmark is not None else None
    rows, paths = [], {}
    ev = events.copy()
    ev["date"] = pd.to_datetime(ev["date"])
    if "timing" not in ev:
        ev["timing"] = "unknown"
    for e in ev.sort_values("date").itertuples(index=False):
        t0 = reaction_index(idx, e.date, getattr(e, "timing", "unknown"))
        if t0 is None or t0 < 1:
            continue
        base = c[t0 - 1]
        r = {"report_date": pd.Timestamp(e.date), "timing": e.timing, "t0": idx[t0], "t0_i": t0,
             "close_before": base}
        for n in PRE:
            r[f"pre_{n}"] = base / c[t0 - 1 - n] - 1.0 if t0 - 1 - n >= 0 else np.nan
            if b is not None and t0 - 1 - n >= 0:
                r[f"pre_{n}_excess"] = r[f"pre_{n}"] - (b[t0 - 1] / b[t0 - 1 - n] - 1.0)
        r["gap"] = o[t0] / base - 1.0 if o is not None and np.isfinite(o[t0]) else np.nan
        r["day0"] = c[t0] / base - 1.0
        r["intraday"] = c[t0] / o[t0] - 1.0 if o is not None and np.isfinite(o[t0]) else np.nan
        if b is not None:
            r["day0_excess"] = r["day0"] - (b[t0] / b[t0 - 1] - 1.0)
        for k in POST:
            if t0 + k < len(c):
                r[f"post_{k}"] = c[t0 + k] / c[t0] - 1.0
                r[f"total_{k}"] = c[t0 + k] / base - 1.0
                if b is not None:
                    r[f"post_{k}_excess"] = r[f"post_{k}"] - (b[t0 + k] / b[t0] - 1.0)
            else:
                r[f"post_{k}"] = r[f"total_{k}"] = np.nan
        fut = c[t0: t0 + 61]
        if r["day0"] < 0:
            back = np.nonzero(fut[1:] >= base)[0]
            r["recovered_bars"] = int(back[0] + 1) if len(back) else np.nan
            r["recovered_within_20"] = bool(len(back) and back[0] + 1 <= 20) if len(fut) > 20 else pd.NA
            r["faded_within_20"] = pd.NA
        else:
            under = np.nonzero(fut[1:] < base)[0]
            r["recovered_bars"] = np.nan
            r["recovered_within_20"] = pd.NA
            r["faded_within_20"] = bool(len(under) and under[0] + 1 <= 20) if len(fut) > 20 else pd.NA
        r["mae_post_20"] = min(0.0, fut[: 21].min() / c[t0] - 1.0) if len(fut) > 1 else np.nan
        for col in ("eps_actual", "eps_estimate", "surprise_pct", "rev_actual", "rev_estimate", "guidance"):
            if hasattr(e, col):
                r[col] = getattr(e, col)
        rows.append(r)
        lo, hi = path_window
        pts = {}
        for j in range(lo, hi + 1):
            k = t0 + j
            pts[j] = c[k] / base - 1.0 if 0 <= k < len(c) else np.nan
        paths[pd.Timestamp(e.date)] = pts
    tab = pd.DataFrame(rows)
    if tab.empty:
        return tab, pd.DataFrame()
    if "surprise_pct" not in tab and {"eps_actual", "eps_estimate"} <= set(tab.columns):
        est = tab["eps_estimate"].astype(float)
        tab["surprise_pct"] = (tab["eps_actual"].astype(float) - est) / est.abs().replace(0, np.nan)
    if "surprise_pct" in tab:
        s = pd.to_numeric(tab["surprise_pct"], errors="coerce")
        tab["result"] = np.select([s > 0.02, s < -0.02], ["beat", "miss"], default="inline")
        tab.loc[s.isna(), "result"] = pd.NA
        # beat rate over the prior 4 reports, known before this report
        beat = (s > 0).astype(float).where(s.notna())
        tab["prior4_beat_rate"] = beat.shift(1).rolling(4, min_periods=2).mean()
    tab["day0_up"] = tab["day0"] > 0
    tab["pattern"] = np.select(
        [(tab["pre_20"] > 0) & (tab["day0"] < 0), (tab["pre_20"] > 0) & (tab["day0"] >= 0),
         (tab["pre_20"] <= 0) & (tab["day0"] >= 0), (tab["pre_20"] <= 0) & (tab["day0"] < 0)],
        ["ran_up_then_fell", "ran_up_then_rose", "fell_in_then_rose", "fell_in_then_fell"], default="n/a")
    if context is not None:
        ctx = context.reindex(idx).ffill()
        pre = ctx.iloc[[r - 1 for r in tab["t0_i"]]].reset_index(drop=True)
        pre.columns = [f"pre_{col}" if not str(col).startswith("pre_") else col for col in pre.columns]
        tab = pd.concat([tab.reset_index(drop=True), pre], axis=1)
    path = pd.DataFrame(paths)
    path.index.name = "bars_from_t0"
    return tab, path


def summary(tab: pd.DataFrame) -> dict:
    """Headline earnings behavior for one stock."""
    if tab is None or tab.empty:
        return {"n": 0}
    d = tab
    down = d[d["day0"] < 0]
    up = d[d["day0"] >= 0]
    out = {
        "n": int(len(d)),
        "pct_ran_up_into_report": float((d["pre_20"] > 0).mean()),
        "median_pre_20": float(d["pre_20"].median()),
        "pct_day0_up": float((d["day0"] > 0).mean()),
        "median_abs_day0": float(d["day0"].abs().median()),
        "median_day0_up": float(up["day0"].median()) if len(up) else np.nan,
        "median_day0_down": float(down["day0"].median()) if len(down) else np.nan,
        "pct_ran_up_then_fell": float((d["pattern"] == "ran_up_then_fell").mean()),
        "pct_drops_recovered_20": float(down["recovered_within_20"].astype("boolean").mean()) if len(down) else np.nan,
        "median_bars_to_recover": float(down["recovered_bars"].median()) if len(down) else np.nan,
        "pct_pops_faded_20": float(up["faded_within_20"].astype("boolean").mean()) if len(up) else np.nan,
        "median_post_20": float(d["post_20"].median()),
        "drift_same_direction_20": float((np.sign(d["post_20"]) == np.sign(d["day0"])).mean()),
    }
    if "result" in d:
        for res in ("beat", "miss"):
            g = d[d["result"] == res]
            out[f"n_{res}"] = int(len(g))
            out[f"pct_day0_up_on_{res}"] = float((g["day0"] > 0).mean()) if len(g) else np.nan
    return out


def priced_in_table(tab: pd.DataFrame, runup_col: str = "pre_20") -> pd.DataFrame:
    """Reaction by result x run-up tercile: what was already priced in going into the report."""
    d = tab.dropna(subset=[runup_col, "day0"]).copy()
    if "result" not in d or d["result"].isna().all() or len(d) < 6:
        return pd.DataFrame()
    d["runup"] = pd.qcut(d[runup_col], 3, labels=["weak_into", "flat_into", "strong_into"], duplicates="drop")
    g = d.groupby(["result", "runup"], observed=True)
    out = g.agg(n=("day0", "size"), day0_median=("day0", "median"), pct_day0_up=("day0_up", "mean"),
                post_20_median=("post_20", "median")).reset_index()
    return out


def conditional(tab: pd.DataFrame, by: str, hit: str = "day0_up") -> pd.DataFrame:
    return conditional_table(tab.rename(columns={"t0": "date"}), by, hit, ret_col="day0", mae_col="mae_post_20")

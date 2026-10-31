"""Patterns throughout the year (research area 2).

The walk-forward test is the honest check: for each year it predicts every
month using only earlier years, then scores the call. Because markets rise in
most months, the call has to beat the "always up" base rate known at the
time, not 50%.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .evidence import wilson_ci

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _period_close(close: pd.Series, freq: str) -> pd.Series:
    """Last close of each period, dropping a trailing period that has not finished."""
    c = close.dropna()
    rule = {"month": "ME", "quarter": "QE", "year": "YE"}[freq]
    last = c.resample(rule).last().dropna()
    if len(last) and c.index[-1] < last.index[-1] - pd.Timedelta(days=3):
        last = last.iloc[:-1]
    return last


def period_returns(close: pd.Series, freq: str = "month", benchmark: pd.Series | None = None) -> pd.DataFrame:
    """Return per completed month/quarter; excess vs benchmark when given."""
    pc = _period_close(close, freq)
    out = pd.DataFrame({"ret": pc.pct_change()})
    if benchmark is not None:
        bc = _period_close(benchmark, freq).reindex(pc.index)
        out["bench"] = bc.pct_change()
        out["excess"] = out["ret"] - out["bench"]
    out["year"] = out.index.year
    out["period"] = out.index.month if freq == "month" else out.index.quarter
    return out.dropna(subset=["ret"])


def calendar_table(close: pd.Series, freq: str = "month", col: str = "ret",
                   benchmark: pd.Series | None = None) -> pd.DataFrame:
    """Year x month (or quarter) grid of returns, the heatmap input."""
    pr = period_returns(close, freq, benchmark)
    t = pr.pivot_table(index="year", columns="period", values=col, aggfunc="first")
    if freq == "month":
        t.columns = [MONTHS[m - 1] for m in t.columns]
    else:
        t.columns = [f"Q{q}" for q in t.columns]
    return t


def seasonal_stats(close: pd.Series, freq: str = "month", col: str = "ret",
                   benchmark: pd.Series | None = None, recent_years: int = 5) -> pd.DataFrame:
    """Per month: n, mean, median, hit rate with CI, spread, and the years it failed."""
    pr = period_returns(close, freq, benchmark)
    rows = []
    last_year = pr["year"].max() if len(pr) else None
    for p, g in pr.groupby("period"):
        x = g[col].dropna()
        n = len(x)
        k = int((x > 0).sum())
        lo, hi = wilson_ci(k, n)
        typical_up = k / n >= 0.5 if n else True
        failed = g.loc[(x <= 0) if typical_up else (x > 0), "year"].tolist()
        rec = x[g["year"] > last_year - recent_years] if last_year is not None else x
        rows.append({
            "period": MONTHS[p - 1] if freq == "month" else f"Q{p}", "n": n, "mean": x.mean(), "median": x.median(),
            "hit_rate": k / n if n else np.nan, "ci_low": lo, "ci_high": hi, "std": x.std(),
            "best": x.max(), "worst": x.min(),
            f"hit_rate_last{recent_years}y": (rec > 0).mean() if len(rec) else np.nan,
            "failed_years": failed,
        })
    return pd.DataFrame(rows)


def seasonal_walk_forward(close: pd.Series, freq: str = "month", col: str = "ret", min_years: int = 5,
                          conviction: float = 0.65, benchmark: pd.Series | None = None) -> tuple[pd.DataFrame, dict]:
    """Predict each period from prior years only, then score it.

    A call is made when the historical hit rate (years before the test year)
    is >= conviction (call up) or <= 1 - conviction (call down). Returns the
    calls and a summary comparing accuracy with the point-in-time base rate.
    """
    pr = period_returns(close, freq, benchmark).dropna(subset=[col])
    years = sorted(pr["year"].unique())
    # numpy masks instead of filtering the frame per row; the hit rates are the same k / n
    yr, per, up = pr["year"].to_numpy(), pr["period"].to_numpy(), (pr[col] > 0).to_numpy()
    calls = []
    for y in years:
        before = yr < y
        if len(np.unique(yr[before])) < min_years:
            continue
        base_up = float(up[before].mean())
        cur = pr[pr["year"] == y]
        for row in cur.itertuples():
            same = before & (per == row.period)
            n_hist = int(same.sum())
            if n_hist < min_years:
                continue
            hr = float(up[same].mean())
            call = "up" if hr >= conviction else "down" if hr <= 1 - conviction else None
            if call is None:
                continue
            realized = getattr(row, col)
            calls.append({"year": y, "period": row.period, "call": call, "hist_hit_rate": hr,
                          "hist_n": n_hist, "realized": realized,
                          "correct": (realized > 0) == (call == "up"),
                          "base_up_rate": base_up,
                          "naive_correct": (realized > 0) == (base_up >= 0.5)})
    cdf = pd.DataFrame(calls)
    if cdf.empty:
        return cdf, {"n_calls": 0}
    n, k = len(cdf), int(cdf["correct"].sum())
    lo, hi = wilson_ci(k, n)
    summary = {"n_calls": n, "accuracy": k / n, "ci_low": lo, "ci_high": hi,
               "naive_accuracy_same_periods": float(cdf["naive_correct"].mean()),
               "n_up_calls": int((cdf["call"] == "up").sum()), "n_down_calls": int((cdf["call"] == "down").sum()),
               "up_call_accuracy": float(cdf.loc[cdf["call"] == "up", "correct"].mean()) if (cdf["call"] == "up").any() else np.nan,
               "down_call_accuracy": float(cdf.loc[cdf["call"] == "down", "correct"].mean()) if (cdf["call"] == "down").any() else np.nan,
               "avg_return_up_calls": float(cdf.loc[cdf["call"] == "up", "realized"].mean()) if (cdf["call"] == "up").any() else np.nan,
               "avg_return_down_calls": float(cdf.loc[cdf["call"] == "down", "realized"].mean()) if (cdf["call"] == "down").any() else np.nan}
    summary["edge_vs_naive"] = summary["accuracy"] - summary["naive_accuracy_same_periods"]
    return cdf, summary


def seasonal_path(close: pd.Series) -> pd.DataFrame:
    """Cumulative return by trading day of year, across years (median, quartiles) plus the latest year."""
    c = close.dropna()
    paths = {}
    for y, g in c.groupby(c.index.year):
        prev = c[c.index.year < y]
        if prev.empty:
            continue
        base = prev.iloc[-1]
        paths[y] = (g / base - 1.0).reset_index(drop=True)
    if not paths:
        return pd.DataFrame()
    P = pd.DataFrame(paths)
    last = max(paths)
    full = P.drop(columns=[last])
    out = pd.DataFrame({"median": full.median(axis=1), "p25": full.quantile(0.25, axis=1),
                        "p75": full.quantile(0.75, axis=1), "mean": full.mean(axis=1),
                        "n_years": full.notna().sum(axis=1), f"{last}": P[last]})
    out.index.name = "trading_day"
    return out


def earnings_season_label(dates: pd.DatetimeIndex, pre: tuple = (-20, 9), peak: tuple = (10, 45)) -> pd.Series:
    """Tag dates by calendar position relative to quarter ends.

    peak_season: 10 to 45 days after a quarter end (when most US companies report)
    pre_season:  20 days before to 9 days after a quarter end
    off_season:  everything else
    """
    d = pd.DatetimeIndex(dates).normalize()
    fwd = d + pd.offsets.QuarterEnd(0)
    last_qe = pd.DatetimeIndex(np.where(fwd == d, d, d - pd.offsets.QuarterEnd(1)))
    days_after = np.asarray((d - last_qe).days)
    days_before = np.asarray((fwd - d).days)
    lab = np.full(len(d), "off_season", dtype=object)
    lab[(days_after >= peak[0]) & (days_after <= peak[1])] = "peak_season"
    lab[(days_after >= 0) & (days_after <= pre[1])] = "pre_season"
    lab[(days_before > 0) & (days_before <= -pre[0])] = "pre_season"
    return pd.Series(lab, index=pd.DatetimeIndex(dates))


def earnings_season_stats(close: pd.Series, benchmark: pd.Series | None = None) -> pd.DataFrame:
    """Annualized drift and daily hit rate by earnings-season phase."""
    c = close.dropna()
    r = c.pct_change().dropna()
    lab = earnings_season_label(r.index)
    df = pd.DataFrame({"ret": r, "phase": lab})
    if benchmark is not None:
        df["excess"] = r - benchmark.reindex(c.index).pct_change().reindex(r.index)
    rows = []
    for ph, g in df.groupby("phase"):
        rec = {"phase": ph, "days": len(g), "ann_drift": g["ret"].mean() * 252, "daily_hit_rate": (g["ret"] > 0).mean(),
               "ann_vol": g["ret"].std() * np.sqrt(252)}
        if "excess" in g:
            rec["ann_excess_drift"] = g["excess"].mean() * 252
        rows.append(rec)
    return pd.DataFrame(rows)

"""Evidence engine: counts, hit rates, ranges, failures, and out-of-sample checks.

Conventions
* A "hit" is the expected outcome of a pattern. Every table reports hits AND
  failures, never hit rates alone.
* n_eff counts events after de-clustering (events closer than `min_gap_days`
  collapse to the first one), because overlapping events are not independent.
* Hit-rate intervals are Wilson 95% intervals.
* `lift` compares a condition with the base rate of the same outcome over all
  events, which is what the pattern has to beat.
* Benjamini-Hochberg q-values are given when many conditions are scanned.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

try:
    from scipy.stats import binomtest as _binomtest
except Exception:  # pragma: no cover
    _binomtest = None


def wilson_ci(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n <= 0:
        return (np.nan, np.nan)
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (max(0.0, centre - half), min(1.0, centre + half))


def binom_pvalue(k: int, n: int, p0: float) -> float:
    if n <= 0 or not (0 < p0 < 1):
        return np.nan
    if _binomtest is not None:
        return float(_binomtest(k, n, p0).pvalue)
    mu, sd = n * p0, math.sqrt(n * p0 * (1 - p0))
    zv = abs(k - mu) / sd
    return float(math.erfc(zv / math.sqrt(2)))


def bh_qvalues(p: pd.Series) -> pd.Series:
    s = p.dropna().sort_values()
    m = len(s)
    if m == 0:
        return p * np.nan
    ranks = np.arange(1, m + 1)
    q = (s.to_numpy() * m / ranks)
    q = np.minimum.accumulate(q[::-1])[::-1]
    return pd.Series(np.minimum(q, 1.0), index=s.index).reindex(p.index)


def decluster(df: pd.DataFrame, date_col: str = "date", min_gap_days: int = 20) -> pd.DataFrame:
    """Keep the first event of any run of events closer than min_gap_days."""
    if df.empty:
        return df
    d = df.sort_values(date_col)
    keep, last = [], None
    for t in pd.to_datetime(d[date_col]):
        ok = last is None or (t - last).days >= min_gap_days
        keep.append(ok)
        if ok:
            last = t
    return d[np.array(keep)]


def outcome_summary(df: pd.DataFrame, hit_col: str, ret_col: str | None = None,
                    mae_col: str | None = None, days_col: str | None = None,
                    date_col: str = "date", min_gap_days: int = 0, base_rate: float | None = None,
                    horizon_days: int | None = None) -> dict:
    """One-line evidence summary for a set of events.

    horizon_days: when outcomes are measured over overlapping windows (for
    example monthly samples of 12-month returns), n_eff counts how many
    non-overlapping events exist. Grades use n_eff, not n.
    """
    d = df.dropna(subset=[hit_col])
    if min_gap_days and date_col in d:
        d = decluster(d, date_col, min_gap_days)
    n = int(len(d))
    k = int(d[hit_col].astype(bool).sum()) if n else 0
    lo, hi = wilson_ci(k, n)
    res = {"n": n, "hits": k, "fails": n - k, "hit_rate": k / n if n else np.nan,
           "ci_low": lo, "ci_high": hi}
    if horizon_days and n and date_col in d:
        res["n_eff"] = int(len(decluster(d, date_col, horizon_days)))
        # widen the interval to the effective sample size
        lo2, hi2 = wilson_ci(int(round(res["hit_rate"] * res["n_eff"])), res["n_eff"])
        res["ci_low"], res["ci_high"] = lo2, hi2
    if base_rate is not None and n:
        res["base_rate"] = base_rate
        res["lift"] = (k / n) / base_rate if base_rate else np.nan
        res["p_value"] = binom_pvalue(k, n, base_rate)
    if ret_col and n:
        r = d[ret_col].dropna()
        res.update({"ret_median": r.median(), "ret_mean": r.mean(), "ret_p10": r.quantile(0.10),
                    "ret_p25": r.quantile(0.25), "ret_p75": r.quantile(0.75), "ret_p90": r.quantile(0.90),
                    "ret_worst": r.min(), "ret_best": r.max()})
        fails = d.loc[~d[hit_col].astype(bool), ret_col].dropna()
        res["ret_median_when_failed"] = fails.median() if len(fails) else np.nan
    if mae_col and n:
        m = d[mae_col].dropna()
        res.update({"mae_median": m.median(), "mae_p25": m.quantile(0.25), "mae_worst": m.min()})
        wins = d.loc[d[hit_col].astype(bool), mae_col].dropna()
        res["mae_median_before_hit"] = wins.median() if len(wins) else np.nan
    if days_col and n:
        t = d[days_col].dropna()
        res.update({"days_median": t.median(), "days_p25": t.quantile(0.25), "days_p75": t.quantile(0.75)})
    return res


def conditional_table(df: pd.DataFrame, by: str | list[str], hit_col: str, ret_col: str | None = None,
                      mae_col: str | None = None, days_col: str | None = None,
                      date_col: str = "date", min_gap_days: int = 0, min_n: int = 1,
                      horizon_days: int | None = None) -> pd.DataFrame:
    """Outcome summary for each bucket of `by`, compared with the all-events base rate."""
    d = df.dropna(subset=[hit_col])
    if min_gap_days and date_col in d:
        d = decluster(d, date_col, min_gap_days)
    base = float(d[hit_col].astype(bool).mean()) if len(d) else np.nan
    rows = []
    for key, g in d.groupby(by, observed=True, dropna=True):
        s = outcome_summary(g, hit_col, ret_col, mae_col, days_col, date_col, 0, base, horizon_days)
        if s["n"] < min_n:
            continue
        s["bucket"] = key if not isinstance(key, tuple) or len(key) > 1 else key[0]
        rows.append(s)
    allrow = outcome_summary(d, hit_col, ret_col, mae_col, days_col, date_col, 0, None, horizon_days)
    allrow["bucket"] = "ALL"
    allrow["base_rate"] = base
    allrow["lift"] = 1.0
    out = pd.DataFrame(rows + [allrow])
    if "p_value" in out:
        if "n_eff" in out:  # recompute the test on the effective sample
            out["p_value"] = [binom_pvalue(int(round(r["hit_rate"] * r["n_eff"])), int(r["n_eff"]), base)
                              if pd.notna(r.get("n_eff")) and r["bucket"] != "ALL" else np.nan for r in out.to_dict("records")]
        out["q_value"] = bh_qvalues(out["p_value"])
    out["grade"] = [evidence_grade(r) for r in out.to_dict("records")]
    cols = ["bucket"] + [c for c in out.columns if c != "bucket"]
    return out[cols]


def tercile_labels(train: pd.Series, values: pd.Series, labels=("low", "mid", "high")) -> pd.Series:
    """Bucket `values` with cutoffs learned from `train` only."""
    t = train.dropna()
    if len(t) < 6:
        return pd.Series(pd.NA, index=values.index, dtype="object")
    q1, q2 = t.quantile([1 / 3, 2 / 3])
    out = pd.Series(labels[1], index=values.index, dtype="object")
    out[values <= q1] = labels[0]
    out[values > q2] = labels[2]
    out[values.isna()] = pd.NA
    return out


def walk_forward(df: pd.DataFrame, feature: str, hit_col: str, date_col: str = "date",
                 split: str | pd.Timestamp | None = None, train_frac: float = 0.6,
                 ret_col: str | None = None, min_gap_days: int = 0) -> pd.DataFrame:
    """Learn tercile cutoffs on the earlier period, then test them on the later period.

    Answers: did a condition that looked useful in earlier years still separate
    outcomes in later years, using only cutoffs that were known at the time?
    """
    d = df.dropna(subset=[feature, hit_col]).sort_values(date_col)
    if min_gap_days:
        d = decluster(d, date_col, min_gap_days)
    if d.empty:
        return pd.DataFrame()
    if split is None:
        split = d[date_col].iloc[int(len(d) * train_frac)] if len(d) > 4 else d[date_col].iloc[-1]
    split = pd.Timestamp(split)
    train = d[d[date_col] < split]
    test = d[d[date_col] >= split]
    rows = []
    for name, part in (("in_sample", train), ("out_of_sample", test)):
        if part.empty:
            continue
        b = tercile_labels(train[feature], part[feature])
        base = float(part[hit_col].astype(bool).mean())
        for lab in ("low", "mid", "high"):
            g = part[b == lab]
            s = outcome_summary(g, hit_col, ret_col, base_rate=base)
            s.update({"period": name, "bucket": f"{feature}:{lab}", "split": split.date()})
            rows.append(s)
    out = pd.DataFrame(rows)
    if out.empty:
        return out
    front = ["period", "bucket", "split", "n", "hits", "fails", "hit_rate", "ci_low", "ci_high", "base_rate", "lift"]
    return out[[c for c in front if c in out] + [c for c in out.columns if c not in front]]


def oos_holds(wf: pd.DataFrame, bucket: str) -> bool | None:
    """True if a bucket beat (or lagged) its base rate on the same side in both periods."""
    if wf is None or wf.empty:
        return None
    a = wf[(wf["period"] == "in_sample") & (wf["bucket"] == bucket)]
    b = wf[(wf["period"] == "out_of_sample") & (wf["bucket"] == bucket)]
    if a.empty or b.empty or b["n"].iloc[0] < 5:
        return None
    return bool(np.sign(a["lift"].iloc[0] - 1) == np.sign(b["lift"].iloc[0] - 1) and a["lift"].iloc[0] != 1)


def evidence_grade(row: dict, oos: bool | None = None) -> str:
    """A/B/C/Insufficient from sample size, separation from base rate and out-of-sample result.

    Sample size is n_eff (non-overlapping events) when available.

    A: n >= 30, Wilson CI excludes the base rate, out-of-sample held.
    B: n >= 20 and (CI excludes base rate or out-of-sample held).
    C: n >= 10.
    Insufficient: fewer than 10 events.
    """
    n = row.get("n_eff") if row.get("n_eff") is not None and not pd.isna(row.get("n_eff")) else row.get("n", 0) or 0
    lo, hi, base = row.get("ci_low"), row.get("ci_high"), row.get("base_rate")
    separated = base is not None and lo is not None and not (pd.isna(base) or pd.isna(lo)) and (lo > base or hi < base)
    if n < 10:
        return "Insufficient"
    if n >= 30 and separated and oos is True:
        return "A"
    if n >= 20 and (separated or oos is True):
        return "B"
    return "C"


def describe(series: pd.Series) -> dict:
    s = pd.Series(series).dropna()
    if s.empty:
        return {"n": 0}
    return {"n": int(len(s)), "median": s.median(), "mean": s.mean(), "p10": s.quantile(0.1),
            "p25": s.quantile(0.25), "p75": s.quantile(0.75), "p90": s.quantile(0.9),
            "min": s.min(), "max": s.max()}

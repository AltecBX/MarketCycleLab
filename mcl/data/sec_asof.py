"""Fundamentals as known on each filing date: a restatement counts from the day it was filed.

The default basis ("first") keeps each quarter's first filed value forever
(sec.quarterly_fundamentals + valuation.ttm). With this basis ("asof") every
10-Q, 10-K or amendment is a knowledge date K, and the trailing twelve months
for the latest period are rebuilt from what had been filed by K:

  at a 10-K   TTM = the full year in that 10-K
  at a 10-Q   TTM = prior full year - prior year to date + year to date

The prior year to date is taken on the prior full year's basis (the latest
version filed on or before that full year was filed), so the remainder of last
year is internally consistent; the current year to date is the latest filed.
When a 10-K/A restates the full year and the next 10-Q carries restated
comparatives, everything is on the new basis (Apple, January 2010). When a 10-Q
recasts last year's comparatives before the full year is restated, the
remainder stays on the old basis, which is no worse than the first-reported
basis. A field with no year-to-date facts falls back to its four latest
quarters as known at K. The prior-year TTM (for growth) is the same formula one
year back, as known at K.

Balance sheet items are the latest values filed by K for the period end; the
share count is the latest cover-page count filed by K.

Example (JPMorgan 2012): from 2012-05-10 TTM net income includes Q1 2012 as
first reported (5,383M); from 2012-08-09, when a 10-Q/A restated Q1 to 4,924M and
the Q2 10-Q reported the half year on the restated basis, TTM uses the restated
half year. The first-reported basis keeps 5,383M until Q1 2012 rolls out.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import sec

TOL = pd.Timedelta(days=10)
YEAR = pd.Timedelta(days=365)
FACT_COLS = ["start", "end", "val", "filed", "form", "accn"]


def _field_facts(data: dict, key: str) -> pd.DataFrame:
    """All duration facts for a field across its tags, with tag rank (0 = preferred)."""
    parts = []
    for rank, tag in enumerate(sec.TAGS[key]):
        f = sec._facts(data, tag)
        if f.empty or "start" not in f:
            continue
        f = f.dropna(subset=["start"])
        if "accn" not in f:
            f = f.assign(accn="")
        f = sec._drop_inconsistent_quarter_tables(f)
        parts.append(f[FACT_COLS].assign(tag=tag, rank=rank))
    if not parts:
        return pd.DataFrame(columns=FACT_COLS + ["tag", "rank", "days"])
    F = pd.concat(parts, ignore_index=True)
    F["days"] = (F["end"] - F["start"]).dt.days
    return F[F["days"].between(80, 380)].reset_index(drop=True)


class _Facts:
    """Numpy view of a field's facts for fast repeated lookups (dates as day numbers)."""

    def __init__(self, F: pd.DataFrame):
        self.F = F
        day = lambda c: F[c].to_numpy(dtype="datetime64[D]").astype(np.int64)  # noqa: E731
        self.start, self.end, self.filed = day("start"), day("end"), day("filed")
        self.days = F["days"].to_numpy(dtype=np.int64)
        self.val = F["val"].to_numpy(dtype=float)
        self.rank = F["rank"].to_numpy(dtype=np.int64)
        self.tag = F["tag"].to_numpy()

    def pick(self, end: int, known: int, days=None, tag=None, longest=False, filed_by=None) -> int | None:
        """Index of the latest filed fact ending within 10 days of `end`, filed by `known`."""
        m = (np.abs(self.end - end) <= TOL.days) & (self.filed <= known)
        if days is not None:
            m &= (self.days >= days[0]) & (self.days <= days[1])
        if filed_by is not None:
            m &= self.filed <= filed_by
        idx = np.flatnonzero(m)
        if not len(idx):
            return None
        if tag is not None:
            same = idx[self.tag[idx] == tag]
            idx = same if len(same) else idx
        keys = (self.rank[idx], -self.filed[idx]) + ((-self.days[idx],) if longest else ())
        return int(idx[np.lexsort(keys)[0]])


def _day(ts) -> int:
    return int(np.datetime64(pd.Timestamp(ts), "D").astype(np.int64))


def _ttm_ytd(fx: _Facts, end: int, known: int) -> float:
    i = fx.pick(end, known, longest=True)
    if i is None:
        return np.nan
    if fx.days[i] >= 350:
        return float(fx.val[i])
    j = fx.pick(fx.start[i] - 1, known, days=(350, 380), tag=fx.tag[i])
    if j is None:
        return np.nan
    span = (fx.days[i] - 10, fx.days[i] + 10)
    k = fx.pick(fx.end[i] - YEAR.days, known, days=span, tag=fx.tag[i], filed_by=fx.filed[j])
    if k is None:   # no version on the full year's basis (e.g. the first XBRL year): latest
        k = fx.pick(fx.end[i] - YEAR.days, known, days=span, tag=fx.tag[i])
    if k is None:
        return np.nan
    return float(fx.val[j] - fx.val[k] + fx.val[i])


def _ttm_quarters(fx: _Facts, end: int, known: int) -> float:
    """Fallback: sum of the four latest quarters known (reported preferred over derived)."""
    F = fx.F[fx.filed <= known]
    if (np.abs(fx.end[fx.filed <= known] - end) > TOL.days).all():
        return np.nan
    parts = []
    for (tag, rank), g in F.groupby(["tag", "rank"]):
        q = sec.discrete_quarters(g[FACT_COLS], keep="last")
        if len(q):
            parts.append(q.assign(tag=tag, rank=rank))
    if not parts:
        return np.nan
    m = pd.concat(parts, ignore_index=True)
    m["derived"] = m["derived"].astype(bool)
    m = m.sort_values(["period_end", "derived", "filed", "rank"], ascending=[True, True, False, True], kind="mergesort")
    m = m.drop_duplicates("period_end")
    endts = pd.Timestamp(np.datetime64(end, "D"))
    w = m[m["period_end"] <= endts + TOL].tail(4)
    if len(w) < 4 or abs(w["period_end"].iloc[-1] - endts) > TOL:
        return np.nan
    if not 250 <= (w["period_end"].iloc[-1] - w["period_end"].iloc[0]).days <= 290:
        return np.nan
    return float(w["val"].sum())


def ttm_at(fx: _Facts, end: int, known: int) -> float:
    v = _ttm_ytd(fx, end, known)
    return v if np.isfinite(v) else _ttm_quarters(fx, end, known)


def _instant_frame(data: dict, tags: list[str]) -> pd.DataFrame:
    parts = []
    for rank, tag in enumerate(tags):
        f = sec._facts(data, tag)
        if not f.empty:
            parts.append(f[["end", "val", "filed"]].assign(rank=rank))
    return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=["end", "val", "filed", "rank"])


def _instant(inst: pd.DataFrame, end) -> float:
    if inst.empty:
        return np.nan
    c = inst[(inst["end"] - end).abs() <= pd.Timedelta(days=3)]
    if c.empty:
        return np.nan
    return float(c.sort_values(["rank", "filed"], ascending=[True, False], kind="mergesort").iloc[0]["val"])


def fundamentals_asof(data: dict) -> pd.DataFrame:
    """One row per knowledge date: the latest period's TTM flows (and prior-year TTM), balance sheet, shares."""
    flows = {k: _field_facts(data, k) for k in sec.TAGS}
    base = flows["revenue"] if len(flows["revenue"]) else flows["net_income"]
    if base.empty:
        return pd.DataFrame()
    inst = {k: _instant_frame(data, tags) for k, tags in sec.INSTANT_TAGS.items()}
    debt = {t: _instant_frame(data, [t]) for t in ("LongTermDebtNoncurrent", "LongTermDebtCurrent", "LongTermDebt")}
    sh = sec._shares(data)
    if not sh.empty:
        sh = sh.dropna(subset=["shares_date", "shares_filed"]).copy()
        for c in ("shares_date", "shares_filed"):
            sh[c] = pd.to_datetime(sh[c])
        sh = sh.sort_values(["shares_filed", "shares_date"])
    fxs = {k: _Facts(F) for k, F in flows.items() if len(F)}
    rows = []
    for K in sorted(base["filed"].unique()):
        K = pd.Timestamp(K)
        end = base.loc[base["filed"] <= K, "end"].max()
        row = {"knowledge_date": K, "period_end": end}
        k_day, e_day = _day(K), _day(end)
        for key, fx in fxs.items():
            if not (fx.filed <= k_day).any():
                continue
            row[f"ttm_{key}"] = ttm_at(fx, e_day, k_day)
            row[f"ttm_{key}_prev"] = ttm_at(fx, e_day - YEAR.days, k_day)
        for key, frame in inst.items():
            row[key] = _instant(frame[frame["filed"] <= K], end)
        nonc, cur, tot = (_instant(d[d["filed"] <= K], end) for d in debt.values())
        lt = nonc + (0.0 if np.isnan(cur) else cur) if np.isfinite(nonc) else tot
        st = row.get("st_debt", np.nan)
        row["total_debt"] = np.nan if np.isnan(lt) and np.isnan(st) else np.nansum([lt, st])
        if not sh.empty:
            known = sh[sh["shares_filed"] <= K]
            if len(known):
                row["shares"], row["shares_date"] = float(known["shares"].iloc[-1]), known["shares_date"].iloc[-1]
        rows.append(row)
    return pd.DataFrame(rows)

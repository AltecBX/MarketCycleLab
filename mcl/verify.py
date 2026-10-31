"""Verify the SEC quarterly fundamentals (python -m mcl verify TICKER ...).

Valuation rests on quarters rebuilt from XBRL facts: three-month values where
filed, otherwise differences of year-to-date values (Q4 = full year minus
nine months). Every check below writes the numbers it compared to
reports/verify_<TICKER>.csv with a link to the filing, so any row can be
confirmed by hand in the 10-Q or 10-K.

1. fiscal_years  Q1+Q2+Q3+Q4 vs the full-year value in the 10-K (first filed).
                 Where Q2 and Q3 were filed as three-month values this is a real
                 cross-filing check; where they were derived from year-to-date
                 values it holds by construction and is marked so.
2. yahoo         Each quarter Yahoo publishes vs the first-filed SEC value (what
                 the tool uses) and the latest-filed value (after restatements).
3. restated      Quarters whose value changed in a later filing. Point-in-time
                 studies use the first value; data vendors show the latest.
4. integrity     Missing quarters, negative revenue, revenue far out of line with
                 neighboring quarters, quarters first filed long after period end.
5. shares        Cover-page shares vs diluted weighted shares in the same basis
                 (catches partial multi-class counts and split errors) and
                 quarter-to-quarter jumps.
6. earnings      8-K Item 2.02 dates and before-open / after-close timing vs
                 Yahoo's report times (SEC acceptance converted from UTC to Eastern),
                 and 2.02 filings with no report near them.

Row status: ok, info (explained difference), warn (look at it), fail (wrong number).
"""
from __future__ import annotations

from functools import partial

import numpy as np
import pandas as pd

from .analytics.valuation import split_factor_after
from .data import sec

FLOWS = ["revenue", "net_income", "op_income", "ocf", "capex"]
HARD = {"revenue", "net_income"}    # a mismatch here is a fail; elsewhere definitions differ more often
RANK = {"ok": 0, "info": 1, "warn": 2, "fail": 3}
COLS = ["check", "metric", "period_end", "sec_value", "sec_latest", "compare_to", "compare_value", "rel_diff",
        "status", "note", "source"]
TOL, ABS_TOL = 0.005, 2e6           # 0.5%, or $2M for rounding to millions across filings


def _close(a, b) -> bool:
    if a is None or b is None or not (np.isfinite(a) and np.isfinite(b)):
        return False
    return abs(a - b) <= max(TOL * max(abs(a), abs(b)), ABS_TOL)


def _rel(a, b) -> float:
    return float((a - b) / abs(b)) if np.isfinite(a) and np.isfinite(b) and b != 0 else np.nan


def filing_url(cik: int | None, accn) -> str:
    if cik is None or not isinstance(accn, str) or not accn:
        return ""
    return f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accn.replace('-', '')}/"


def _row(check, metric, period_end=None, sec_value=np.nan, sec_latest=np.nan, compare_to="", compare_value=np.nan,
         status="ok", note="", source="") -> dict:
    return {"check": check, "metric": metric, "period_end": period_end, "sec_value": sec_value,
            "sec_latest": sec_latest, "compare_to": compare_to, "compare_value": compare_value,
            "rel_diff": _rel(sec_value, compare_value), "status": status, "note": note, "source": source}


def flow(data: dict, key: str, keep: str = "first") -> pd.DataFrame:
    """Discrete quarters for one field, same tag priority as the pipeline."""
    return sec._first_available(data, sec.TAGS[key], partial(sec.discrete_quarters, keep=keep))


def _annual_facts(data: dict, key: str) -> pd.DataFrame:
    parts = []
    for tag in sec.TAGS[key]:
        f = sec._facts(data, tag)
        if f.empty or "start" not in f:
            continue
        f = f.dropna(subset=["start"])
        f = f[f["form"].astype(str).str.match(r"^(10-K|20-F|40-F)") & (f["end"] - f["start"]).dt.days.between(350, 380)]
        if len(f):
            parts.append(f.sort_values("filed").drop_duplicates(["start", "end"], keep="first").assign(tag=tag))
    return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()


def _fy_versions(data: dict, key: str, start, end) -> list[float]:
    """Every value any 10-K filed for this fiscal year (restatements included), across the field's tags."""
    vals = []
    for tag in sec.TAGS[key]:
        f = sec._facts(data, tag)
        if f.empty or "start" not in f:
            continue
        f = f[(f["start"] == start) & (f["end"] == end) & f["form"].astype(str).str.match(r"^(10-K|20-F|40-F)")]
        vals += f["val"].astype(float).tolist()
    return vals


def fiscal_years(data: dict, cik=None) -> list[dict]:
    out = []
    for key in FLOWS:
        q = flow(data, key)
        fy = _annual_facts(data, key)
        q_last = flow(data, key, "last")
        if q.empty or fy.empty:
            continue
        for end, g in fy.groupby("end", sort=True):
            inq = q[(q["period_end"] > g["start"].iloc[0]) & (q["period_end"] <= end)]
            if inq.empty:
                continue
            q4 = inq[(inq["period_end"] - end).abs() <= pd.Timedelta(days=3)]
            pick = g[g["tag"] == q4["tag"].iloc[0]] if len(q4) and (g["tag"] == q4["tag"].iloc[0]).any() else g
            f = pick.iloc[0]
            src = filing_url(cik, f.get("accn"))
            if len(inq) != 4:
                out.append(_row("fiscal_years", key, end, inq["val"].sum(), compare_to="10-K full year",
                                compare_value=f["val"], status="info",
                                note=f"only {len(inq)} quarters on file for this fiscal year", source=src))
                continue
            direct = int((~inq["derived"].astype(bool)).sum())
            tags = sorted(set(inq["tag"]))
            notes = []
            if len(tags) > 1:
                notes.append("quarters use different tags: " + ", ".join(tags))
            if direct <= 1 and len(tags) == 1 and f["tag"] == tags[0]:
                notes.append("holds by construction (Q2 to Q4 derived from year-to-date values)")
            ok = _close(inq["val"].sum(), f["val"])
            status = "ok" if ok else ("fail" if key in HARD else "warn")
            if not ok:
                start = g["start"].iloc[0]
                inl = q_last[(q_last["period_end"] > start) & (q_last["period_end"] <= end)]
                sums = [float(inq["val"].sum())] + ([float(inl["val"].sum())] if len(inl) == 4 else [])
                hit = next(((a, v) for a in sums for v in _fy_versions(data, key, start, end) if _close(a, v)), None)
                if hit:
                    status = "warn"
                    notes.append(f"restatement mix: the first-filed quarters straddle a restatement; quarters add up to "
                                 f"a filed version of the year ({hit[0] / 1e6:,.0f}M vs {hit[1] / 1e6:,.0f}M). Parser is "
                                 f"fine; TTM rows with these quarters mix old and new accounting until they roll off")
                else:
                    notes.append("quarters match no filed version of the year: likely a tag or scope problem; "
                                 "open the filing")
            out.append(_row("fiscal_years", key, end, inq["val"].sum(), compare_to=f"10-K full year ({f['tag']})",
                            compare_value=f["val"], status=status, note="; ".join(notes), source=src))
    return out


def restated(data: dict, cik=None) -> list[dict]:
    out = []
    for key in FLOWS:
        a, b = flow(data, key, "first"), flow(data, key, "last")
        if a.empty or b.empty:
            continue
        m = a.merge(b[["period_end", "val", "filed", "accn"]], on="period_end", how="inner", suffixes=("", "_latest"))
        for r in m.itertuples():
            if _close(r.val, r.val_latest):
                continue
            out.append(_row("restated", key, r.period_end, r.val, r.val_latest, "latest filed", r.val_latest, "info",
                            f"first filed {pd.Timestamp(r.filed).date()}, changed in filing of "
                            f"{pd.Timestamp(r.filed_latest).date()}; studies use the first value",
                            filing_url(cik, r.accn_latest)))
    return out


def vs_yahoo(data: dict, ystm: pd.DataFrame, cik=None) -> list[dict]:
    out = []
    if ystm is None or ystm.empty:
        return out
    un = ystm[ystm["metric"] == "unusual"]
    unusual = dict(zip(un["period_end"], un["value"]))
    for key in FLOWS:
        ys = ystm[ystm["metric"] == key]
        if ys.empty:
            continue
        a, b = flow(data, key, "first"), flow(data, key, "last")
        latest = b.set_index("period_end")["val"] if not b.empty else pd.Series(dtype=float)
        for r in ys.sort_values("period_end").itertuples():
            yv = abs(r.value) if key == "capex" else r.value
            if a.empty:
                out.append(_row("yahoo", key, r.period_end, compare_to="Yahoo", compare_value=yv, status="warn",
                                note="no SEC quarters for this field"))
                continue
            d = (a["period_end"] - r.period_end).abs()
            i = d.idxmin()
            if d[i] > pd.Timedelta(days=10):
                out.append(_row("yahoo", key, r.period_end, compare_to="Yahoo", compare_value=yv, status="warn",
                                note="Yahoo has this quarter, the SEC reconstruction does not"))
                continue
            pe, first = a.loc[i, "period_end"], float(a.loc[i, "val"])
            last = float(latest.get(pe, np.nan))
            if key == "capex":
                first, last = abs(first), abs(last)
            if _close(first, yv):
                status, note = "ok", ""
            elif _close(last, yv):
                status, note = "info", "matches the latest filed value; first filed value was later restated"
            elif key == "revenue" and np.isfinite(unusual.get(r.period_end, np.nan)) and \
                    abs((first - yv) - unusual[r.period_end]) <= 0.1 * abs(unusual[r.period_end]):
                status = "warn"
                note = (f"gap equals Yahoo's unusual items ({unusual[r.period_end] / 1e6:,.0f}M), which Yahoo leaves out "
                        f"of revenue; the SEC value is the company's reported total")
            else:
                status = "fail" if key in HARD else "warn"
                note = ("derived quarter (from year-to-date values)" if bool(a.loc[i, "derived"]) else "reported quarter") \
                    + "; open the filing and compare"
            out.append(_row("yahoo", key, pe, first, last, "Yahoo", yv, status, note, filing_url(cik, a.loc[i, "accn"])))
    return out


def integrity(q: pd.DataFrame, cik=None) -> list[dict]:
    out = []
    if q is None or q.empty:
        return [_row("integrity", "all", status="fail", note="no quarters reconstructed")]
    q = q.sort_values("period_end").reset_index(drop=True)
    gap = q["period_end"].diff().dt.days
    for i in q.index[gap > 100]:
        n = int(round(gap[i] / 91.3)) - 1
        out.append(_row("integrity", "periods", q.loc[i, "period_end"], status="warn",
                        note=f"{n} quarter(s) missing between {q.loc[i - 1, 'period_end'].date()} and "
                             f"{q.loc[i, 'period_end'].date()}; TTM is blank across the gap"))
    if "revenue" in q:
        rev = q["revenue"].astype(float)
        for i in q.index[rev < 0]:
            out.append(_row("integrity", "revenue", q.loc[i, "period_end"], rev[i], status="fail",
                            note="negative revenue: the year-to-date difference spans different scopes"))
        neigh = pd.concat([rev.shift(k) for k in (-2, -1, 1, 2)], axis=1).median(axis=1)
        ratio = rev / neigh
        # same fiscal quarter a year earlier, else a year later (this is a check, not a signal)
        pe = q["period_end"]
        yago = rev / rev.shift(4).where(pe.diff(4).dt.days.between(350, 380))
        yahead = rev / rev.shift(-4).where((pe.shift(-4) - pe).dt.days.between(350, 380))
        same_q = yago.fillna(yahead)
        off = lambda r: (r < 0.5) | (r > 2.0)  # noqa: E731
        # out of line with neighbors AND with the same quarter in another year, so seasonality is not flagged
        for i in q.index[off(ratio) & (off(same_q) | same_q.isna()) & (rev >= 0)]:
            out.append(_row("integrity", "revenue", q.loc[i, "period_end"], rev[i], compare_to="median of 4 neighbors",
                            compare_value=neigh[i], status="warn",
                            note="far out of line with neighboring quarters and the year-ago quarter "
                                 "(acquisition, divestiture, or a bad year-to-date difference)"))
    lag = (pd.to_datetime(q["filed"]) - pd.to_datetime(q["period_end"])).dt.days
    late = q.index[lag > 150]
    if len(late):
        out.append(_row("integrity", "filed", q.loc[late[-1], "period_end"], status="info",
                        note=f"{len(late)} quarter(s) first filed 150+ days after period end (usually the first XBRL "
                             f"years, filed later as comparatives); they count only from that later date"))
    if len(q) < 8:
        out.append(_row("integrity", "periods", q["period_end"].iloc[-1], status="warn",
                        note=f"only {len(q)} quarters: if the company recently moved under a new holding company "
                             f"(new CIK, same ticker), add the old CIK to data/user/cik_predecessors.json"))
    if not out:
        out.append(_row("integrity", "all", q["period_end"].iloc[-1], status="ok",
                        note=f"{len(q)} quarters, {q['period_end'].iloc[0].date()} to {q['period_end'].iloc[-1].date()}"))
    return out


def shares(data: dict, q: pd.DataFrame, splits: pd.Series | None) -> list[dict]:
    out = []
    if q is None or q.empty or "shares" not in q or q["shares"].isna().all():
        return [_row("shares", "shares", status="warn", note="no share count: market cap and multiples unavailable")]
    q = q.dropna(subset=["shares"]).sort_values("period_end").reset_index(drop=True)
    cover = q["shares"].astype(float) * split_factor_after(q["shares_date"], splits)
    # rows first filed long after their quarter carry the count at that later filing: not comparable
    late = (pd.to_datetime(q["filed"]) - pd.to_datetime(q["period_end"])).dt.days > 150
    q, cover = q[~late].reset_index(drop=True), cover[~late].reset_index(drop=True)
    if q.empty:
        return [_row("shares", "shares", status="info", note="all share counts come from late first filings")]
    # latest filed diluted counts: early filings sometimes carry scale errors that later filings correct
    w = sec.discrete_quarters(sec._facts(data, "WeightedAverageNumberOfDilutedSharesOutstanding", ("shares",)), keep="last")
    w = w[~w["derived"].astype(bool)] if not w.empty else w
    if not w.empty:
        wm = w.set_index("period_end")
        wv = q["period_end"].map(wm["val"]).astype(float)
        wf = q["period_end"].map(wm["filed"])
        wadj = wv * split_factor_after(wf.fillna(q["filed"]), splits)
        ratio = cover / wadj
        bad = ratio[(ratio < 0.85) | (ratio > 1.15)].index
        for i in bad:
            note = ("diluted shares look 1,000x too small: a units error in that filing's XBRL; the cover count is used"
                    if 500 <= ratio[i] <= 2000 else
                    "cover-page count differs from diluted shares by more than 15% (one share class only on the cover, "
                    "a split, convertibles or options in diluted shares, or a large buyback/issue)")
            out.append(_row("shares", "shares", q.loc[i, "period_end"], cover[i], compare_to="diluted weighted shares",
                            compare_value=wadj[i], status="info" if 500 <= ratio[i] <= 2000 else "warn", note=note))
    jump = cover.pct_change()
    for i in jump[jump.abs() > 0.2].index:
        out.append(_row("shares", "shares", q.loc[i, "period_end"], cover[i], compare_to="prior quarter",
                        compare_value=cover[i - 1], status="warn",
                        note="share count moved 20%+ in one quarter after split adjustment"))
    look = q[pd.to_datetime(q["shares_filed"]) > pd.to_datetime(q["filed"])] if "shares_filed" in q else q.iloc[0:0]
    for r in look.itertuples():
        out.append(_row("shares", "shares", r.period_end, status="fail", note="share count from a later filing (look-ahead)"))
    if splits is None:
        out.append(_row("shares", "splits", status="info", note="Yahoo splits unavailable; counts compared unadjusted"))
    if not out:
        out.append(_row("shares", "shares", q["period_end"].iloc[-1], cover.iloc[-1], status="ok",
                        note=f"{len(q)} quarters consistent with diluted shares"))
    return out


def earnings_dates(sec_dates: pd.DataFrame, yahoo_dates: pd.DataFrame, today=None) -> list[dict]:
    out = []
    if sec_dates is None or sec_dates.empty:
        return [_row("earnings", "dates", status="warn", note="no 8-K Item 2.02 filings found")]
    s = sec_dates.copy()
    s["date"] = pd.to_datetime(s["date"])
    acc = pd.to_datetime(s["accepted"], errors="coerce")
    mins = acc.dt.hour * 60 + acc.dt.minute
    timed = acc.notna() & (mins > 0)
    inside = ((mins >= 6 * 60) & (mins <= 22 * 60))[timed]
    if len(inside):
        st = "ok" if inside.mean() >= 0.95 else "warn"
        out.append(_row("earnings", "acceptance_clock", status=st, sec_value=float(inside.mean()),
                        note=f"{inside.mean():.0%} of {len(inside)} acceptance stamps fall inside EDGAR hours "
                             f"(06:00 to 22:00 US Eastern)"))
    if yahoo_dates is None or yahoo_dates.empty:
        out.append(_row("earnings", "dates", status="info", note="Yahoo report dates unavailable; timing not cross-checked"))
        return out
    y = yahoo_dates.copy()
    y["date"] = pd.to_datetime(y["date"])
    today = pd.Timestamp(today or pd.Timestamp.today()).normalize()
    y = y[y["date"] <= today]
    if y.empty:
        out.append(_row("earnings", "dates", status="info", note="no past Yahoo report dates; timing not cross-checked"))
        return out
    lo = max(s["date"].min(), y["date"].min()) - pd.Timedelta(days=5)
    s, y = s[s["date"] >= lo], y[y["date"] >= lo]
    agree = n_both = 0
    used = set()
    for r in s.itertuples():
        d = (y["date"] - r.date).abs()
        if d.empty or d.min() > pd.Timedelta(days=3):
            out.append(_row("earnings", "extra_8k", r.date, status="warn",
                            note=f"8-K Item 2.02 with no Yahoo report within 3 days (accepted {r.accepted}); "
                                 f"may be a non-earnings 2.02 that adds a false event"))
            continue
        j = d.idxmin()
        used.add(j)
        yt, stt = str(y.loc[j, "timing"]), str(r.timing)
        if y.loc[j, "date"] != r.date:
            out.append(_row("earnings", "date_diff", r.date, status="warn",
                            note=f"Yahoo date {y.loc[j, 'date'].date()} vs SEC {r.date.date()} ({stt}, accepted {r.accepted})"))
        if yt in ("bmo", "amc") and stt in ("bmo", "amc", "dmh"):
            n_both += 1
            if yt == stt:
                agree += 1
            else:
                out.append(_row("earnings", "timing_diff", r.date, status="warn",
                                note=f"SEC {stt} (accepted {r.accepted}) vs Yahoo {yt} ({y.loc[j, 'timestamp']})"))
    for j in y.index.difference(list(used)):
        out.append(_row("earnings", "missing_8k", y.loc[j, "date"], status="info",
                        note="Yahoo report with no 8-K Item 2.02 within 3 days; the study uses the Yahoo date"))
    if n_both:
        st = "ok" if agree / n_both >= 0.9 else "warn"
        out.append(_row("earnings", "timing", status=st, sec_value=agree / n_both,
                        note=f"before-open / after-close agrees with Yahoo on {agree} of {n_both} reports"))
    return out


def run(ticker: str, use_yahoo: bool = True) -> dict:
    """All checks for one ticker. Returns {'rows': DataFrame, 'summary': DataFrame, 'spot': DataFrame, 'notes': [...]}."""
    from .data import yahoo
    tk = ticker.upper()
    notes = []
    cik, data = sec.company_data(tk)
    preds = sec.predecessors(tk, cik)
    if preds:
        notes.append(f"history merged from predecessor CIK(s) {', '.join(map(str, preds))}")
    q = sec.quarterly_fundamentals(data)
    splits = ystm = ydates = None
    if use_yahoo:
        try:
            splits = yahoo.splits(tk, yahoo.prices(tk))
        except Exception as e:
            notes.append(f"Yahoo prices/splits unavailable: {e}")
        try:
            ystm = yahoo.quarterly_statements(tk)
            if ystm.empty:
                notes.append("Yahoo returned no quarterly statements")
        except Exception as e:
            notes.append(f"Yahoo statements unavailable: {e}")
        try:
            ydates = yahoo.earnings_dates(tk)
        except Exception as e:
            notes.append(f"Yahoo earnings dates unavailable: {e}")
    try:
        sdates = sec.earnings_releases(tk)
    except Exception as e:
        sdates = None
        notes.append(f"SEC 8-K list unavailable: {e}")
    rows = (fiscal_years(data, cik) + vs_yahoo(data, ystm, cik) + restated(data, cik) + integrity(q, cik)
            + shares(data, q, splits) + earnings_dates(sdates, ydates))
    df = pd.DataFrame(rows, columns=COLS)
    df.insert(0, "ticker", tk)
    summary = summarize(df)
    spot = spot_check(data, cik)
    return {"ticker": tk, "cik": cik, "rows": df, "summary": summary, "spot": spot, "notes": notes,
            "quarters": q}


def summarize(df: pd.DataFrame) -> pd.DataFrame:
    out = []
    for (tk, check), g in df.groupby(["ticker", "check"], sort=False):
        worst = max(g["status"], key=lambda s: RANK.get(s, 0))
        counts = g["status"].value_counts()
        parts = [f"{counts.get(s, 0)} {s}" for s in ("ok", "info", "warn", "fail") if counts.get(s, 0)]
        by_metric = []
        if check in ("fiscal_years", "yahoo"):
            for m, gm in g.groupby("metric", sort=False):
                good = gm["status"].isin(["ok", "info"]).sum()
                by_metric.append(f"{m} {good}/{len(gm)}")
        out.append({"ticker": tk, "check": check, "status": worst, "counts": ", ".join(parts),
                    "detail": ", ".join(by_metric)})
    return pd.DataFrame(out)


def spot_check(data: dict, cik, n: int = 4) -> pd.DataFrame:
    """Last n quarters of revenue and net income with the filing to open, for a by-hand check."""
    parts = []
    for key in ("revenue", "net_income"):
        f = flow(data, key)
        if f.empty:
            continue
        f = f.tail(n).assign(metric=key)
        parts.append(f)
    if not parts:
        return pd.DataFrame()
    s = pd.concat(parts)
    s["how"] = np.where(s["derived"].astype(bool), "derived from year-to-date", "reported 3-month value")
    s["filing"] = [filing_url(cik, a) for a in s["accn"]]
    return s[["metric", "period_end", "val", "filed", "how", "tag", "filing"]].reset_index(drop=True)


def text(res: dict) -> str:
    """Console summary for one ticker."""
    lines = [f"{res['ticker']}  CIK {res['cik']}"]
    q = res["quarters"]
    if q is not None and len(q):
        lines[0] += f"  {len(q)} quarters {q['period_end'].min().date()} to {q['period_end'].max().date()}"
    for r in res["summary"].itertuples():
        lines.append(f"  {r.check:<13} {r.status.upper():<5} {r.counts}" + (f"  [{r.detail}]" if r.detail else ""))
    bad = res["rows"][res["rows"]["status"].isin(["fail", "warn"])]
    for r in bad.head(12).itertuples():
        pe = pd.Timestamp(r.period_end).date() if pd.notna(r.period_end) else ""
        diff = f" {r.rel_diff:+.2%}" if pd.notna(r.rel_diff) else ""
        lines.append(f"    {r.status}: {r.check} {r.metric} {pe}{diff} {r.note}")
    if len(bad) > 12:
        lines.append(f"    ... {len(bad) - 12} more in the CSV")
    for n in res["notes"]:
        lines.append(f"  note: {n}")
    if len(res["spot"]):
        lines.append("  spot check (open the filing, compare with the income statement):")
        for r in res["spot"].itertuples():
            lines.append(f"    {r.metric:<10} {pd.Timestamp(r.period_end).date()} {r.val / 1e6:>12,.0f}M  {r.how:<26} {r.filing}")
    return "\n".join(lines)

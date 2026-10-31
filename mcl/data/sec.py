"""SEC EDGAR: point-in-time quarterly fundamentals and earnings release dates.

Why EDGAR: every XBRL fact carries the date it was filed, so a valuation on
any past day can be computed from only what had been published by then.
Restated values are ignored in favor of the first filed value for each
period, which is what an investor saw at the time.

Quarterly flows: 10-Qs report the quarter (about 90 days) and year-to-date
values; cash flow statements are usually year-to-date only, and 10-Ks only
report the full year. Discrete quarters are derived by differencing
cumulative values that share a start date (Q2 = H1 - Q1, Q4 = FY - 9M); a
derived quarter is dated with the later filing.

Earnings release dates: 8-K filings with Item 2.02 (Results of Operations).
The acceptance time indicates before-open or after-close. The submissions
feed gives it in UTC (the 'Z' is real): JPMorgan's pre-market 8-Ks are
stamped about 10:45 in summer and 11:45 in winter, which is 06:45 US Eastern
year round. It is converted to US Eastern before dating and classifying.
The event is dated by the Eastern acceptance day, not filingDate: EDGAR
gives anything accepted after 17:30 ET the next business day's filingDate.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from . import http, store
from ..config import SEC_USER_AGENT

TAGS = {
    "revenue": ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax",
                "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet", "SalesRevenueGoodsNet",
                "SalesRevenueServicesNet", "RevenuesNetOfInterestExpense", "TotalRevenuesAndOtherIncome"],
    "net_income": ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"],
    "op_income": ["OperatingIncomeLoss"],
    "gross_profit": ["GrossProfit"],
    "ocf": ["NetCashProvidedByUsedInOperatingActivities",
            "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
}
INSTANT_TAGS = {
    "equity": ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
    "cash": ["CashAndCashEquivalentsAtCarryingValue",
             "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "Cash"],
    "st_debt": ["ShortTermBorrowings", "CommercialPaper"],
}
QUARTER_DAYS = (80, 100)


def _get(url: str) -> dict:
    if not SEC_USER_AGENT:
        raise RuntimeError('Set MCL_SEC_USER_AGENT="Your Name your@email" (SEC requires a contact in the User-Agent).')
    raw = http.get_bytes(url, {"User-Agent": SEC_USER_AGENT, "Accept-Encoding": "identity"}, timeout=30)
    return json.loads(raw.decode("utf-8"))


def ticker_to_cik(ticker: str) -> int | None:
    m = store.load_json("sec", "company_tickers", 24 * 30)
    if m is None:
        raw = _get("https://www.sec.gov/files/company_tickers.json")
        m = {v["ticker"].upper(): int(v["cik_str"]) for v in raw.values()}
        store.save_json(m, "sec", "company_tickers")
    return m.get(ticker.upper().replace(".", "-")) or m.get(ticker.upper())


# A holding-company reorganization moves the ticker to a new CIK while the history stays under the old one.
# Verified: ExxonMobil Holdings Corp (CIK 2115436, first filing 2026-07-01, files 8-K12B as successor issuer)
# continues Exxon Mobil Corp (CIK 34088); its Q2 2025 comparative revenue (81,506M) equals 34088's own filing.
# Add others in data/user/cik_predecessors.json as {"TICKER": [predecessor CIKs]}.
PREDECESSORS = {2115436: [34088]}


def predecessors(ticker: str, cik: int | None) -> list[int]:
    from ..config import USER_DIR
    out = list(PREDECESSORS.get(cik, [])) if cik else []
    p = USER_DIR / "cik_predecessors.json"
    if p.exists():
        out += [int(c) for c in json.loads(p.read_text()).get(ticker.upper(), []) if int(c) not in out]
    return out


def _merge_facts(a: dict, b: dict) -> dict:
    """Union of two companyfacts payloads (facts lists concatenated per taxonomy, tag and unit)."""
    out = {**a, "facts": {}}
    for src in (a, b):
        for tax, tags in src.get("facts", {}).items():
            for tag, node in tags.items():
                dst = out["facts"].setdefault(tax, {}).setdefault(tag, {"units": {}})
                for unit, arr in node.get("units", {}).items():
                    dst["units"].setdefault(unit, []).extend(arr)
    return out


def company_data(ticker: str) -> tuple[int, dict]:
    """CIK and companyfacts for a ticker, merged with any predecessor CIKs."""
    cik = ticker_to_cik(ticker)
    if cik is None:
        raise RuntimeError(f"No SEC CIK for {ticker} (ETFs, indexes and many foreign listings have none)")
    data = companyfacts(cik)
    for p in predecessors(ticker, cik):
        data = _merge_facts(data, companyfacts(p))
    return cik, data


def companyfacts(cik: int, refresh_hours: float = 24.0) -> dict:
    key = f"facts_{cik:010d}"
    cached = store.load_json("sec", key, refresh_hours)
    if cached is not None:
        return cached
    data = _get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json")
    store.save_json(data, "sec", key)
    return data


def _facts(data: dict, tag: str, unit_pref=("USD", "shares", "USD/shares"), taxonomy: str = "us-gaap") -> pd.DataFrame:
    node = data.get("facts", {}).get(taxonomy, {}).get(tag)
    if not node:
        return pd.DataFrame()
    units = node.get("units", {})
    for u in unit_pref:
        if u in units:
            df = pd.DataFrame(units[u])
            break
    else:
        return pd.DataFrame()
    for c in ("start", "end", "filed"):
        if c in df:
            df[c] = pd.to_datetime(df[c], errors="coerce")
    if "form" in df:
        df = df[df["form"].astype(str).str.match(r"^(10-Q|10-K|20-F|40-F|6-K|10-KT|10-QT)")]
    return df.dropna(subset=["end", "filed", "val"])


def _drop_inconsistent_quarter_tables(df: pd.DataFrame) -> pd.DataFrame:
    """Drop three-month facts from a filing whose four quarters do not add up to that filing's own year.

    10-Ks often tag an unaudited quarterly table. When it is mis-tagged, its Q4 would beat the correct
    full-year-minus-nine-months value. Example: Amazon's FY2012 10-K tagged SalesRevenueNet quarters of
    9,857 / 9,913 / 10,876 / 17,431 against a 61,093 year in the same filing (true Q4: 21,268).
    """
    if df.empty or "accn" not in df or "start" not in df:
        return df
    days = (df["end"] - df["start"]).dt.days
    bad = pd.Series(False, index=df.index)
    for _, g in df.groupby("accn"):
        gd = days.loc[g.index]
        qs = g[gd.between(*QUARTER_DAYS)]
        if len(qs) < 4:
            continue
        for fy in g[gd.between(350, 380)].itertuples():
            inq = qs[(qs["end"] > fy.start) & (qs["end"] <= fy.end)]
            if len(inq) == 4 and inq["end"].nunique() == 4:
                total, year = float(inq["val"].sum()), float(fy.val)
                if abs(total - year) > max(0.005 * max(abs(total), abs(year)), 2e6):
                    bad.loc[inq.index] = True
    return df[~bad]


def discrete_quarters(df: pd.DataFrame, keep: str = "first") -> pd.DataFrame:
    """Discrete ~90-day values from a mix of quarterly and cumulative duration facts.

    Candidates for each quarter: reported three-month values, and differences of
    year-to-date values sharing a start date (dated with the later filing). One
    value per quarter end: the earliest filed (keep="first", what investors first
    saw; on the same date a reported value beats a derived one), or for
    verification (keep="last") the latest reported value, derived only when the
    quarter was never reported. Quarterly tables that do not add up to their own
    filing's year are ignored.
    Returns columns period_end, val, filed, derived, accn.
    """
    cols = ["period_end", "val", "filed", "derived", "accn"]
    if df.empty or "start" not in df:
        return pd.DataFrame(columns=cols)
    d = df.dropna(subset=["start"]).copy()
    if "accn" not in d:
        d["accn"] = ""
    d = _drop_inconsistent_quarter_tables(d)
    d = d.sort_values("filed").drop_duplicates(["start", "end"], keep=keep)
    d["days"] = (d["end"] - d["start"]).dt.days
    cands = [(r.end, r.val, r.filed, False, r.accn) for r in d[d["days"].between(*QUARTER_DAYS)].itertuples()]
    for _, g in d[d["days"] >= QUARTER_DAYS[0]].groupby("start"):
        g = g.sort_values("end")
        ends, vals, filed, accn = g["end"].tolist(), g["val"].tolist(), g["filed"].tolist(), g["accn"].tolist()
        for a in range(len(g)):
            for b in range(a + 1, len(g)):
                if QUARTER_DAYS[0] <= (ends[b] - ends[a]).days <= QUARTER_DAYS[1]:
                    later = b if filed[b] >= filed[a] else a
                    cands.append((ends[b], vals[b] - vals[a], max(filed[a], filed[b]), True, accn[later]))
    if not cands:
        return pd.DataFrame(columns=cols)
    out = pd.DataFrame(cands, columns=cols)
    if keep == "first":   # earliest filed; same date: reported beats derived
        out = out.sort_values(["period_end", "filed", "derived"], kind="mergesort")
    else:                 # latest reported value; derived only when no quarter was reported (a derived Q4 from a
        #                   restated year minus an unrestated 9 months would absorb the whole restatement)
        out = out.sort_values(["period_end", "derived", "filed"], ascending=[True, True, False], kind="mergesort")
    return out.drop_duplicates("period_end", keep="first").reset_index(drop=True)


def instants(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame(columns=["period_end", "val", "filed"])
    d = df.sort_values("filed").drop_duplicates(["end"], keep="first")
    return d.rename(columns={"end": "period_end"})[["period_end", "val", "filed"]].sort_values("period_end")


def _first_available(data: dict, tags: list[str], fn, keep: str = "first") -> pd.DataFrame:
    """Merge a field's tags by period.

    keep="first": for each period the earliest filed value across tags; tag order only breaks ties
    within one filing. When a company switches tags (most did in 2018 for ASC 606), its new filings
    re-tag two prior years of quarters with restated values; ranking by tag would let those 2018
    values replace what was first reported (MSFT Q1 FY2017 revenue: 20,453M filed Oct 2016 became
    21,928M filed Aug 2018) and hold every multiple for those years back until 2018.
    keep="last" (verification): latest reported value, derived only when none was reported.
    """
    parts = []
    for rank, tag in enumerate(tags):
        part = fn(_facts(data, tag))
        if not part.empty:
            parts.append(part.assign(tag=tag, rank=rank))
    if not parts:
        return pd.DataFrame(columns=["period_end", "val", "filed", "tag"])
    m = pd.concat(parts, ignore_index=True)
    if "derived" not in m:
        m["derived"] = False
    m["derived"] = m["derived"].astype(bool)
    if keep == "first":
        m = m.sort_values(["period_end", "filed", "derived", "rank"], kind="mergesort")
    else:
        m = m.sort_values(["period_end", "derived", "filed", "rank"], ascending=[True, True, False, True], kind="mergesort")
    return m.drop_duplicates("period_end").drop(columns="rank").reset_index(drop=True)


def _shares(data: dict) -> pd.DataFrame:
    dei = _facts(data, "EntityCommonStockSharesOutstanding", ("shares",), "dei")
    if not dei.empty:
        d = dei.sort_values("filed").drop_duplicates(["accn"], keep="first") if "accn" in dei else dei
        return pd.DataFrame({"shares_date": d["end"], "shares": d["val"], "shares_filed": d["filed"]})
    w = discrete_quarters(_facts(data, "WeightedAverageNumberOfDilutedSharesOutstanding", ("shares",)))
    # averages are not additive: FY minus 9M of an average is meaningless, keep reported quarters only
    w = w[~w["derived"].astype(bool)] if not w.empty else w
    if w.empty:
        return pd.DataFrame(columns=["shares_date", "shares", "shares_filed"])
    return pd.DataFrame({"shares_date": w["period_end"], "shares": w["val"], "shares_filed": w["filed"]})


def quarterly_fundamentals(data: dict) -> pd.DataFrame:
    """One row per fiscal quarter end with point-in-time `filed` dates."""
    flows = {k: _first_available(data, tags, discrete_quarters) for k, tags in TAGS.items()}
    base = flows["revenue"] if not flows["revenue"].empty else flows["net_income"]
    if base.empty:
        return pd.DataFrame()
    q = pd.DataFrame({"period_end": base["period_end"]})
    filed_cols = []
    for k, f in flows.items():
        if f.empty:
            continue
        m = f.set_index("period_end")
        q[k] = q["period_end"].map(m["val"])
        q[f"{k}_filed"] = q["period_end"].map(m["filed"])
        if k in ("revenue", "net_income"):
            filed_cols.append(f"{k}_filed")
    q["filed"] = q[filed_cols].max(axis=1)
    for k, tags in INSTANT_TAGS.items():
        f = _first_available(data, tags, instants)
        if f.empty:
            continue
        m = f.set_index("period_end")
        q[k] = q["period_end"].map(m["val"])
    # long-term debt: noncurrent + current portion when reported that way, else the
    # LongTermDebt total (which already includes the current portion); plus short-term borrowings
    nonc, cur, tot = (instants(_facts(data, t)).set_index("period_end")["val"] if not _facts(data, t).empty
                      else pd.Series(dtype=float) for t in ("LongTermDebtNoncurrent", "LongTermDebtCurrent", "LongTermDebt"))
    lt_split = q["period_end"].map(nonc) + q["period_end"].map(cur).fillna(0.0)
    q["lt_debt"] = lt_split.fillna(q["period_end"].map(tot))
    q["total_debt"] = q["lt_debt"].fillna(0.0) + (q["st_debt"].fillna(0.0) if "st_debt" in q else 0.0)
    q.loc[q["lt_debt"].isna() & (q["st_debt"].isna() if "st_debt" in q else True), "total_debt"] = np.nan
    q = q.dropna(subset=["filed"])
    sh = _shares(data)
    if not sh.empty:
        # point in time: the latest share count filed on or before the quarter's own filing date,
        # normally the cover page of that same 10-Q or 10-K, never a later filing
        sh = sh.dropna(subset=["shares_date", "shares_filed"]).copy()
        for c in ("shares_date", "shares_filed"):
            sh[c] = pd.to_datetime(sh[c]).astype("datetime64[ns]")
        sh = sh.sort_values(["shares_filed", "shares_date"])
        q["filed"] = pd.to_datetime(q["filed"]).astype("datetime64[ns]")
        q = pd.merge_asof(q.sort_values("filed"), sh, left_on="filed", right_on="shares_filed", direction="backward")
    return q.sort_values("period_end").reset_index(drop=True)


FUNDAMENTALS_CACHE = "fundamentals_v3"   # v3: earliest filed across tags; first-known quarters; predecessors


def fundamentals(ticker: str) -> pd.DataFrame:
    cached = store.load_frame(FUNDAMENTALS_CACHE, ticker, 24.0, parse_index=False)
    if cached is not None:
        for c in [c for c in cached.columns if c.endswith("filed") or c in ("period_end", "shares_date")]:
            cached[c] = pd.to_datetime(cached[c], errors="coerce")
        return cached
    _, data = company_data(ticker)
    q = quarterly_fundamentals(data)
    store.save_frame(q, FUNDAMENTALS_CACHE, ticker)
    return q


EARNINGS_CACHE = "earnings_sec_v2"   # v2: acceptance times converted from UTC to US Eastern


def _eastern(acceptance: str) -> pd.Timestamp:
    """EDGAR acceptanceDateTime (UTC, e.g. 2024-07-12T10:46:30.000Z) as naive US Eastern time."""
    ts = pd.Timestamp(acceptance)
    if ts.tzinfo is None:
        ts = ts.tz_localize("UTC")
    return ts.tz_convert("America/New_York").tz_localize(None)


ASOF_CACHE = "fundamentals_asof_v1"


def fundamentals_asof(ticker: str) -> pd.DataFrame:
    """Restated-as-of rows (see sec_asof): one per filing date, cached a day."""
    cached = store.load_frame(ASOF_CACHE, ticker, 24.0, parse_index=False)
    if cached is not None:
        for c in ("knowledge_date", "period_end", "shares_date"):
            if c in cached:
                cached[c] = pd.to_datetime(cached[c], errors="coerce")
        return cached
    from . import sec_asof
    _, data = company_data(ticker)
    rows = sec_asof.fundamentals_asof(data)
    store.save_frame(rows, ASOF_CACHE, ticker)
    return rows


def earnings_releases(ticker: str, refresh_hours: float = 24.0) -> pd.DataFrame:
    """8-K Item 2.02 filings: date and acceptance time (US Eastern), before/after-market timing."""
    from ..analytics.earnings import classify_timing
    cached = store.load_frame(EARNINGS_CACHE, ticker, refresh_hours, parse_index=False)
    if cached is not None:
        cached["date"] = pd.to_datetime(cached["date"])
        return cached
    cik = ticker_to_cik(ticker)
    if cik is None:
        return pd.DataFrame(columns=["date", "accepted", "timing"])
    blocks = []
    for c in [cik] + predecessors(ticker, cik):
        sub = _get(f"https://data.sec.gov/submissions/CIK{c:010d}.json")
        blocks.append(sub.get("filings", {}).get("recent", {}))
        for f in sub.get("filings", {}).get("files", []):
            try:
                blocks.append(_get(f"https://data.sec.gov/submissions/{f['name']}"))
            except Exception:
                pass
    rows = []
    for b in blocks:
        n = len(b.get("form", []))
        for i in range(n):
            if b["form"][i] != "8-K" or "2.02" not in str(b.get("items", [""] * n)[i]):
                continue
            acc = str(b.get("acceptanceDateTime", [""] * n)[i])
            ts = _eastern(acc) if acc else pd.Timestamp(b["filingDate"][i])
            # EDGAR gives anything accepted after 17:30 ET the next business day's filingDate.
            # The release went out on the acceptance day, so date the event by acceptance.
            rows.append({"date": ts.normalize(), "filing_date": pd.Timestamp(b["filingDate"][i]), "accepted": str(ts),
                         "timing": classify_timing(ts) if acc else "unknown"})
    out = pd.DataFrame(rows).drop_duplicates("date").sort_values("date").reset_index(drop=True) if rows else \
        pd.DataFrame(columns=["date", "accepted", "timing"])
    store.save_frame(out, EARNINGS_CACHE, ticker)
    return out


def merge_earnings(sec_dates: pd.DataFrame, yahoo: pd.DataFrame, tolerance_days: int = 3) -> pd.DataFrame:
    """SEC dates and timing (authoritative) joined to Yahoo EPS estimate/actual by nearest date.

    Yahoo rows with no SEC match (for example the upcoming report) are kept.
    """
    if sec_dates is None or sec_dates.empty:
        return yahoo.copy() if yahoo is not None else pd.DataFrame()
    s = sec_dates.copy()
    s["date"] = pd.to_datetime(s["date"]).astype("datetime64[ns]")
    s = s.sort_values("date")
    if yahoo is None or yahoo.empty:
        return s
    y = yahoo.copy()
    y["date"] = pd.to_datetime(y["date"]).astype("datetime64[ns]")
    y = y.sort_values("date")
    y["y_date"] = y["date"]
    y = y.rename(columns={"timing": "timing_yahoo"}) if "timing" in y else y
    j = pd.merge_asof(s, y, on="date", direction="nearest", tolerance=pd.Timedelta(days=tolerance_days))
    # Item 2.02 also covers pre-announcements, guidance cuts and conference updates. Where Yahoo covers the
    # period (a report within 60 days) and none is within tolerance, the filing is not a quarterly report.
    # Two filings matching one Yahoo report: the closer one is the report.
    j["kind"] = "report"
    # A 2.02 filing 1 to 3 days from Yahoo's report date is a different event (AAPL 2005-01-11 Macworld vs the
    # 2005-01-12 report): the Yahoo row stands as the report.
    off_date = j["y_date"].notna() & (j["date"] != j["y_date"])
    j.loc[off_date, "kind"] = "other_2.02"
    dist = (j["date"] - j["y_date"]).abs()
    dup = j["y_date"].notna() & (j["kind"] == "report") & j.duplicated("y_date", keep=False) & ~off_date
    if dup.any():
        best = dist[dup].groupby(j.loc[dup, "y_date"]).idxmin()
        j.loc[dup & ~j.index.isin(best.to_numpy()), "kind"] = "other_2.02"
    yahoo_cols = [c for c in y.columns if c not in ("date", "y_date")]
    j.loc[j["kind"] == "other_2.02", yahoo_cols] = np.nan
    # SEC acceptance bounds the release time from above: an 8-K accepted during market hours often follows a
    # pre-market press release (XOM: release ~07:00, 8-K ~09:40) or lands just before an after-close release.
    if "timing_yahoo" in j:
        fix = (j["kind"] == "report") & (j["timing"] == "dmh") & j["timing_yahoo"].isin(["bmo", "amc"])
        j["timing_sec"] = j["timing"]
        j.loc[fix, "timing"] = j.loc[fix, "timing_yahoo"]
    nomatch = j["y_date"].isna()
    covered = [bool(((y["date"] - d).abs() <= pd.Timedelta(days=60)).any()) for d in j.loc[nomatch, "date"]]
    j.loc[nomatch, "kind"] = np.where(covered, "other_2.02", "report")
    extra = y[~y["y_date"].isin(j.loc[j["kind"] == "report", "y_date"].dropna())].assign(kind="report")
    if "timing_yahoo" in extra:
        extra = extra.assign(timing=extra["timing_yahoo"])
    out = pd.concat([j, extra], ignore_index=True).sort_values("date").reset_index(drop=True)
    return out.drop(columns=["y_date", "timing_yahoo"], errors="ignore")

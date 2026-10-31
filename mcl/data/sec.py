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
feed labels that time with a 'Z' suffix, but it reads as US Eastern clock
time in practice (for example an after-close 8-K shows 16:30); verify on one
known report before relying on timing.
"""
from __future__ import annotations

import json
import time
import urllib.request

import numpy as np
import pandas as pd

from . import store
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
    req = urllib.request.Request(url, headers={"User-Agent": SEC_USER_AGENT, "Accept-Encoding": "identity"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)
    return {}


def ticker_to_cik(ticker: str) -> int | None:
    m = store.load_json("sec", "company_tickers", 24 * 30)
    if m is None:
        raw = _get("https://www.sec.gov/files/company_tickers.json")
        m = {v["ticker"].upper(): int(v["cik_str"]) for v in raw.values()}
        store.save_json(m, "sec", "company_tickers")
    return m.get(ticker.upper().replace(".", "-")) or m.get(ticker.upper())


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


def discrete_quarters(df: pd.DataFrame) -> pd.DataFrame:
    """Discrete ~90-day values from a mix of quarterly and cumulative duration facts.

    Keeps the first filed value for each (start, end). Returns columns
    period_end, val, filed, derived.
    """
    if df.empty or "start" not in df:
        return pd.DataFrame(columns=["period_end", "val", "filed", "derived"])
    d = df.dropna(subset=["start"]).sort_values("filed").drop_duplicates(["start", "end"], keep="first").copy()
    d["days"] = (d["end"] - d["start"]).dt.days
    direct = d[d["days"].between(*QUARTER_DAYS)]
    rows = {r.end: (r.val, r.filed, False) for r in direct.itertuples()}
    for start, g in d[d["days"] >= QUARTER_DAYS[0]].groupby("start"):
        g = g.sort_values("end")
        ends, vals, filed = g["end"].tolist(), g["val"].tolist(), g["filed"].tolist()
        for a in range(len(g)):
            for b in range(a + 1, len(g)):
                gap = (ends[b] - ends[a]).days
                if QUARTER_DAYS[0] <= gap <= QUARTER_DAYS[1] and ends[b] not in rows:
                    rows[ends[b]] = (vals[b] - vals[a], max(filed[a], filed[b]), True)
    out = pd.DataFrame([(k, v[0], v[1], v[2]) for k, v in rows.items()],
                       columns=["period_end", "val", "filed", "derived"]).sort_values("period_end")
    return out.reset_index(drop=True)


def instants(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame(columns=["period_end", "val", "filed"])
    d = df.sort_values("filed").drop_duplicates(["end"], keep="first")
    return d.rename(columns={"end": "period_end"})[["period_end", "val", "filed"]].sort_values("period_end")


def _first_available(data: dict, tags: list[str], fn) -> pd.DataFrame:
    """Merge tags by period: for each period, the highest-priority tag that has it."""
    merged = None
    for tag in tags:
        part = fn(_facts(data, tag))
        if part.empty:
            continue
        part = part.assign(tag=tag)
        merged = part if merged is None else pd.concat([merged, part[~part["period_end"].isin(merged["period_end"])]])
    if merged is None:
        return pd.DataFrame(columns=["period_end", "val", "filed", "tag"])
    return merged.sort_values("period_end").reset_index(drop=True)


def _shares(data: dict) -> pd.DataFrame:
    dei = _facts(data, "EntityCommonStockSharesOutstanding", ("shares",), "dei")
    if not dei.empty:
        d = dei.sort_values("filed").drop_duplicates(["accn"], keep="first") if "accn" in dei else dei
        return pd.DataFrame({"shares_date": d["end"], "shares": d["val"], "shares_filed": d["filed"]})
    w = discrete_quarters(_facts(data, "WeightedAverageNumberOfDilutedSharesOutstanding", ("shares",)))
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
    sh = _shares(data).sort_values("shares_date")
    if not sh.empty:
        # share count from the cover page of the filing for that quarter, else the nearest one
        sh = sh.dropna(subset=["shares_date"])
        sh["shares_date"] = pd.to_datetime(sh["shares_date"]).astype("datetime64[ns]")
        q["period_end"] = pd.to_datetime(q["period_end"]).astype("datetime64[ns]")
        j = pd.merge_asof(q.sort_values("period_end"), sh, left_on="period_end", right_on="shares_date",
                          direction="forward", tolerance=pd.Timedelta(days=120))
        q = j
        miss = q["shares"].isna()
        if miss.any():
            j2 = pd.merge_asof(q.loc[miss, ["period_end"]].sort_values("period_end"), sh, left_on="period_end",
                               right_on="shares_date", direction="backward")
            q.loc[miss, ["shares_date", "shares"]] = j2[["shares_date", "shares"]].to_numpy()
    q = q.dropna(subset=["filed"])
    return q.sort_values("period_end").reset_index(drop=True)


def fundamentals(ticker: str) -> pd.DataFrame:
    cached = store.load_frame("fundamentals", ticker, 24.0, parse_index=False)
    if cached is not None:
        for c in [c for c in cached.columns if c.endswith("filed") or c in ("period_end", "shares_date")]:
            cached[c] = pd.to_datetime(cached[c], errors="coerce")
        return cached
    cik = ticker_to_cik(ticker)
    if cik is None:
        raise RuntimeError(f"No SEC CIK for {ticker} (ETFs, indexes and many foreign listings have none)")
    q = quarterly_fundamentals(companyfacts(cik))
    store.save_frame(q, "fundamentals", ticker)
    return q


def earnings_releases(ticker: str, refresh_hours: float = 24.0) -> pd.DataFrame:
    """8-K Item 2.02 filings: date, acceptance time and before/after-market timing."""
    from ..analytics.earnings import classify_timing
    cached = store.load_frame("earnings_sec", ticker, refresh_hours, parse_index=False)
    if cached is not None:
        cached["date"] = pd.to_datetime(cached["date"])
        return cached
    cik = ticker_to_cik(ticker)
    if cik is None:
        return pd.DataFrame(columns=["date", "accepted", "timing"])
    sub = _get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json")
    blocks = [sub.get("filings", {}).get("recent", {})]
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
            acc = str(b.get("acceptanceDateTime", [""] * n)[i]).replace("Z", "").replace(".000", "")
            ts = pd.Timestamp(acc) if acc else pd.Timestamp(b["filingDate"][i])
            rows.append({"date": pd.Timestamp(b["filingDate"][i]), "accepted": str(ts),
                         "timing": classify_timing(ts) if acc else "unknown"})
    out = pd.DataFrame(rows).drop_duplicates("date").sort_values("date").reset_index(drop=True) if rows else \
        pd.DataFrame(columns=["date", "accepted", "timing"])
    store.save_frame(out, "earnings_sec", ticker)
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
    j = pd.merge_asof(s, y.drop(columns=["timing"], errors="ignore"), on="date", direction="nearest",
                      tolerance=pd.Timedelta(days=tolerance_days))
    extra = y[~y["y_date"].isin(j["y_date"].dropna())]
    out = pd.concat([j, extra], ignore_index=True).sort_values("date").reset_index(drop=True)
    return out.drop(columns=["y_date"], errors="ignore")

"""Verified facts for the case studies (needs network and MCL_SEC_USER_AGENT).

    python scripts/case_study_facts.py AAPL SNDK > reports/case_study_facts.txt

Prints, per ticker, from SEC EDGAR and Yahoo:
  splits                Yahoo split history
  company               SEC name, CIK, fiscal year end, first filing
  quarters              last 8 fiscal quarters: period end, fiscal label, revenue, net income, diluted EPS,
                        filing date and accession (first-reported basis)
  earnings              last 12 reports and the next one: date, timing, 8-K acceptance (ET), EPS estimate and
                        actual (Yahoo), surprise
  market cap milestones first close and first intraday at $1T..$4T, number of separate crossings, returns and
                        drawdown after the first close (closing price x latest cover-page share count filed
                        on or before that day, split adjusted)
  moving averages       5/20/50/200-day SMA status now, streak history, and what followed past streaks that had
                        already reached today's length (historical association, not validated)
  earnings lead-in      run-up into the report vs the reaction (historical association, not validated)

Every number comes from the data at run time; nothing is typed in by hand.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mcl.analytics import earnings, valuation  # noqa: E402
from mcl.data import loader, sec, yahoo  # noqa: E402

pd.set_option("display.width", 200)
pd.set_option("display.max_columns", 30)
pd.set_option("display.max_rows", 200)
M = 1e6


def section(title: str) -> None:
    print(f"\n### {title}")


def fiscal_label(period_end: pd.Timestamp, fy_end_month: int) -> str:
    p = pd.Timestamp(period_end) - pd.Timedelta(days=10)   # 52/53-week years can end in the first days of a month
    months_after = (p.month - fy_end_month) % 12
    q = 4 if months_after == 0 else math.ceil(months_after / 3)
    fy = p.year + (1 if p.month > fy_end_month else 0)
    return f"FY{fy} Q{q}"


def streak_stats(close: pd.Series, n: int, horizons=(3, 5, 10)) -> dict:
    """Moving-average status now and outcomes after past same-side streaks that reached today's length."""
    sma = close.rolling(n).mean()
    ok = sma.notna()
    c, s = close[ok].to_numpy(float), sma[ok].to_numpy(float)
    dates = close.index[ok]
    side = np.where(c > s, 1, -1)
    starts = np.r_[0, np.flatnonzero(np.diff(side)) + 1]
    ends = np.r_[starts[1:] - 1, len(side) - 1]
    runs = pd.DataFrame({"start": starts, "end": ends, "side": side[starts], "len": ends - starts + 1})
    cur = runs.iloc[-1]
    done = runs.iloc[:-1]
    same = done[done["side"] == cur["side"]]
    L = int(cur["len"])
    lr = np.r_[np.nan, np.diff(np.log(c))]
    vol20 = pd.Series(lr).rolling(20).std().to_numpy()
    out = {"sma": n, "as_of": dates[-1].date(), "side": "above" if cur["side"] > 0 else "below", "streak": L,
           "distance_pct": round(100 * (c[-1] / s[-1] - 1), 2),
           "sma_change_5d_pct": round(100 * (s[-1] / s[-6] - 1), 2) if len(s) > 6 else np.nan,
           "pct_days_above": round(100 * float((side > 0).mean()), 1), "crossings": int(len(runs) - 1),
           "completed_same_side_runs": int(len(same))}
    if len(same):
        q = same["len"].quantile([0.5, 0.75, 0.9, 0.95])
        out.update({"median_len": float(q[0.5]), "p75": float(q[0.75]), "p90": float(q[0.9]), "p95": float(q[0.95]),
                    "max_len": int(same["len"].max()),
                    "share_of_runs_reaching_today": round(float((same["len"] >= L).mean()), 3)})
    reached = same[same["len"] >= L]
    for h in horizons:
        rets, ended, drop = [], [], []
        for r in reached.itertuples():
            i = r.start + L - 1
            if i + h >= len(c):
                continue
            rets.append(c[i + h] / c[i] - 1)
            ended.append(r.len - L + 1 <= h)
            typical = vol20[i] * math.sqrt(h) if np.isfinite(vol20[i]) else np.nan
            mae = c[i + 1: i + h + 1].min() / c[i] - 1
            drop.append(bool(np.isfinite(typical) and mae <= -typical))
        base_i = np.flatnonzero(side[: len(side) - h] == cur["side"])
        base_ret = c[base_i + h] / c[base_i] - 1
        out[f"h{h}"] = {"n": len(rets),
                        "median_ret_pct": round(100 * float(np.median(rets)), 2) if rets else np.nan,
                        "p10_ret_pct": round(100 * float(np.percentile(rets, 10)), 2) if len(rets) >= 5 else np.nan,
                        "pct_streak_ended": round(100 * float(np.mean(ended)), 1) if ended else np.nan,
                        "pct_drop_gt_typical_move": round(100 * float(np.mean(drop)), 1) if drop else np.nan,
                        "baseline_median_ret_pct_all_same_side_days": round(100 * float(np.median(base_ret)), 2)}
    return out


def market_cap_milestones(b, data, thresholds=(1e12, 2e12, 3e12, 4e12)) -> pd.DataFrame:
    sh = sec._shares(data).dropna(subset=["shares_filed", "shares_date"]).copy()
    for col in ("shares_filed", "shares_date"):
        sh[col] = pd.to_datetime(sh[col])
    sh = sh.sort_values(["shares_filed", "shares_date"])
    splits = yahoo.splits(b.ticker, b.prices)
    sh["shares_adj"] = sh["shares"].astype(float) * valuation.split_factor_after(sh["shares_date"], splits)
    px = b.prices[["close", "high"]].copy()
    px.index.name = "date"
    px = px.reset_index()
    px["date"] = px["date"].astype("datetime64[ns]")
    sh["shares_filed"] = sh["shares_filed"].astype("datetime64[ns]")
    j = pd.merge_asof(px, sh[["shares_filed", "shares_date", "shares", "shares_adj"]], left_on="date",
                      right_on="shares_filed", direction="backward").dropna(subset=["shares_adj"])
    j["mcap_close"] = j["close"] * j["shares_adj"]
    j["mcap_high"] = j["high"] * j["shares_adj"]
    j["unadjusted_close"] = j["close"] * valuation.split_factor_after(j["date"], splits)
    c = j["close"].to_numpy(float)
    rows = []
    for T in thresholds:
        above = (j["mcap_close"] >= T).to_numpy()
        if not above.any():
            rows.append({"threshold_T": T / 1e12, "first_close": None})
            continue
        i = int(np.argmax(above))
        hi = (j["mcap_high"] >= T).to_numpy()
        k = int(np.argmax(hi))
        ups = int(((~above[:-1]) & above[1:]).sum()) + int(above[0])
        after = c[i: i + 121]
        below_after = np.flatnonzero(~above[i:])
        row = {"threshold_T": T / 1e12, "first_close": j["date"].iloc[i].date(),
               "close_adj": round(c[i], 2), "close_unadj": round(float(j["unadjusted_close"].iloc[i]), 2),
               "shares_used_M": round(float(j["shares"].iloc[i]) / M, 1),
               "shares_as_of": j["shares_date"].iloc[i].date(), "shares_filed": j["shares_filed"].iloc[i].date(),
               "mcap_close_T": round(float(j["mcap_close"].iloc[i]) / 1e12, 4),
               "first_intraday": j["date"].iloc[k].date(), "close_crossings_up": ups,
               "first_close_below_after": j["date"].iloc[i + below_after[0]].date() if len(below_after) else None}
        for h in (5, 20, 60, 120):
            row[f"ret_{h}d_pct"] = round(100 * (c[i + h] / c[i] - 1), 1) if i + h < len(c) else np.nan
        row["max_drawdown_120d_pct"] = round(100 * (after.min() / c[i] - 1), 1) if len(after) > 1 else np.nan
        rows.append(row)
    return pd.DataFrame(rows)


def run(t: str) -> None:
    print(f"\n\n======================== {t} ========================")
    b = loader.load(t)
    px = b.prices
    section("prices")
    print(f"Yahoo daily bars {px.index[0].date()} to {px.index[-1].date()} ({len(px)} bars); last close "
          f"{px['close'].iloc[-1]:.2f} (split adjusted); 252-day high {px['close'].tail(252).max():.2f}; "
          f"from that high {100 * (px['close'].iloc[-1] / px['close'].tail(252).max() - 1):.1f}%")
    print("first 3 bars:")
    print(px[["open", "high", "low", "close", "volume"]].head(3).to_string())
    section("splits (Yahoo)")
    s = yahoo.splits(t, px)
    print(s.to_string() if len(s) else "none in the downloaded history")
    for n in b.notes:
        print("note:", n)

    section("company (SEC)")
    cik, data = sec.company_data(t)
    sub = sec._get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json")
    r = sub["filings"]["recent"]
    print(f"name={sub.get('name')} CIK={cik} fiscalYearEnd={sub.get('fiscalYearEnd')} "
          f"first filing in recent list={min(r['filingDate'])} formerNames={sub.get('formerNames')} "
          f"predecessor CIKs merged={sec.predecessors(t, cik)}")
    fy_end_month = int(str(sub.get("fiscalYearEnd") or "1231")[:2])

    section("quarters (first-reported basis, $M)")
    q = sec.quarterly_fundamentals(data).tail(8).copy()
    eps = sec._first_available(data, ["EarningsPerShareDiluted"], sec.discrete_quarters)
    eps = eps[~eps["derived"].astype(bool)].set_index("period_end")["val"] if not eps.empty else pd.Series(dtype=float)
    rev = sec._first_available(data, sec.TAGS["revenue"], sec.discrete_quarters).set_index("period_end")
    q["fiscal"] = [fiscal_label(p, fy_end_month) for p in q["period_end"]]
    q["eps_diluted_reported"] = q["period_end"].map(eps)
    q["revenue_M"], q["net_income_M"] = q["revenue"] / M, q["net_income"] / M
    q["revenue_how"] = q["period_end"].map(rev["derived"]).map({True: "FY minus 9M", False: "reported"})
    q["filing"] = q["period_end"].map(rev["accn"])
    print(q[["period_end", "fiscal", "revenue_M", "net_income_M", "eps_diluted_reported", "revenue_how", "filed",
             "filing"]].to_string(index=False))

    section("earnings reports (SEC 8-K Item 2.02 time, Yahoo EPS)")
    e = b.earnings[b.earnings["kind"].fillna("report") == "report"].copy() if b.earnings is not None else pd.DataFrame()
    if len(e):
        e["surprise_pct"] = 100 * (e["eps_actual"] - e["eps_estimate"]) / e["eps_estimate"].abs()
        last = pd.Timestamp(px.index[-1])
        show = pd.concat([e[e["date"] <= last].tail(12), e[e["date"] > last].head(1)])
        cols = [c for c in ["date", "timing", "accepted", "eps_estimate", "eps_actual", "surprise_pct"] if c in show]
        print(show[cols].to_string(index=False))
        med = e.loc[e["date"] <= last, "surprise_pct"].dropna()
        print(f"median EPS surprise over {len(med)} past reports: {med.median():.1f}%; last 8: {med.tail(8).median():.1f}%")

    if t == "AAPL":
        section("market cap milestones (close x latest cover-page shares filed by that day)")
        print(market_cap_milestones(b, data).to_string(index=False))

    section("moving averages on split-adjusted closes (historical association, not validated)")
    for n in (5, 20, 50, 200):
        st = streak_stats(px["close"], n)
        flat = {k: v for k, v in st.items() if not k.startswith("h")}
        print(flat)
        for h in (3, 5, 10):
            print(f"   next {h:>2} sessions after past streaks that reached {st['streak']}: {st[f'h{h}']}")

    section("earnings lead-in vs reaction (historical association, not validated)")
    pe = b.past_earnings
    if pe is None or len(pe) < 4:
        print("fewer than 4 reports with prices: not enough for any statistic")
        return
    tab, _ = earnings.event_study(px, pe, benchmark=b.market["close"] if b.market is not None else None)
    ends = pd.DatetimeIndex(sorted(sec.quarterly_fundamentals(data)["period_end"]))
    tab["quarter_reported"] = [ends[ends < d][-1] if (ends < d).any() else pd.NaT for d in tab["report_date"]]
    tab["fiscal_q"] = [fiscal_label(p, fy_end_month)[-2:] if pd.notna(p) else None for p in tab["quarter_reported"]]
    print(f"reports with prices: {len(tab)} ({tab['report_date'].min().date()} to {tab['report_date'].max().date()})")
    print("pattern counts:", tab["pattern"].value_counts().to_dict())
    if "result" in tab:
        beats = tab[tab["result"] == "beat"]
        print(f"beats: {len(beats)}; day-0 down after a beat: {int((beats['day0'] < 0).sum())}")
    tab["runup_tercile"] = pd.qcut(tab["pre_20"], 3, labels=["low", "mid", "high"])
    g = tab.groupby("runup_tercile", observed=True).agg(n=("day0", "size"), pre_20_median=("pre_20", "median"),
                                                        day0_median=("day0", "median"),
                                                        pct_day0_down=("day0", lambda x: (x < 0).mean()),
                                                        post_20_median=("post_20", "median"))
    print((g * [1, 100, 100, 100, 100]).round(1).to_string())
    by_q = tab.dropna(subset=["fiscal_q"]).groupby("fiscal_q").agg(
        n=("day0", "size"), pre_20_median=("pre_20", "median"), day0_median=("day0", "median"),
        post_20_median=("post_20", "median"))
    print("by fiscal quarter reported (% except n):")
    print((by_q * [1, 100, 100, 100]).round(1).to_string())


if __name__ == "__main__":
    for tk in (sys.argv[1:] or ["AAPL", "SNDK"]):
        try:
            run(tk.upper())
        except Exception as ex:  # keep going for the next ticker
            print(f"\n{tk}: failed: {type(ex).__name__}: {ex}")

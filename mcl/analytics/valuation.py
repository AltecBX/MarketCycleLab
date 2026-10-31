"""Valuation versus the stock's own history (research area 4).

Point-in-time rules
* Each quarter's fundamentals become usable the trading day AFTER the filing
  date (`filed`), never on the period end.
* TTM flows are the sum of four contiguous discrete quarters; the TTM row is
  usable once the latest of those four filings is public.
* Share counts are converted to today's split basis using the share count's
  own date, so market cap stays correct against split-adjusted prices.
* Bands and percentiles are expanding (or rolling) so each day only compares
  with history that existed then.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .indicators import expanding_pct_rank, expanding_quantiles, rolling_quantiles

FLOWS = ["revenue", "net_income", "op_income", "ocf", "capex", "gross_profit"]
STOCKS = ["shares", "equity", "total_debt", "cash"]


def split_factor_after(dates: pd.Series, splits: pd.Series | None) -> np.ndarray:
    """Product of split ratios strictly after each date (1.0 when no splits)."""
    d = pd.to_datetime(pd.Series(dates)).to_numpy()
    if splits is None or len(splits) == 0:
        return np.ones(len(d))
    s = splits[splits > 0].sort_index()
    s.index = pd.DatetimeIndex(s.index).tz_localize(None) if getattr(s.index, "tz", None) else pd.DatetimeIndex(s.index)
    out = np.ones(len(d))
    for when, ratio in s.items():
        out[d < np.datetime64(when)] *= float(ratio)
    return out


def ttm(quarters: pd.DataFrame, splits: pd.Series | None = None) -> pd.DataFrame:
    """Trailing-twelve-month fundamentals from discrete quarters.

    `quarters` columns: period_end, filed, plus any of FLOWS and STOCKS, and
    optionally shares_date. Returns one row per quarter with ttm_* flows,
    latest stocks, growth and margins, and `available`, the first date the
    row may be used.
    """
    q = quarters.copy()
    q["period_end"] = pd.to_datetime(q["period_end"])
    q["filed"] = pd.to_datetime(q["filed"])
    q = q.sort_values("period_end").drop_duplicates("period_end", keep="first").reset_index(drop=True)
    out = pd.DataFrame({"period_end": q["period_end"]})
    span = (q["period_end"] - q["period_end"].shift(3)).dt.days
    contiguous = span.between(250, 290)
    filed = q["filed"]
    out["available"] = pd.to_datetime([filed.iloc[i - 3: i + 1].max() if i >= 3 else pd.NaT
                                       for i in range(len(filed))]) + pd.Timedelta(days=1)
    for f in FLOWS:
        if f in q:
            s = q[f].astype(float).rolling(4, min_periods=4).sum()
            out[f"ttm_{f}"] = s.where(contiguous)
    for f in STOCKS:
        if f in q:
            out[f] = q[f].astype(float)
    if "shares" in q:
        sd = q["shares_date"] if "shares_date" in q else q["period_end"]
        out["shares_adj"] = q["shares"].astype(float) * split_factor_after(sd, splits)
    if "ttm_ocf" in out and "ttm_capex" in out:
        out["ttm_fcf"] = out["ttm_ocf"] - out["ttm_capex"].abs()
    if "ttm_revenue" in out:
        out["rev_growth_yoy"] = out["ttm_revenue"] / out["ttm_revenue"].shift(4) - 1.0
        out["rev_growth_accel"] = out["rev_growth_yoy"] - out["rev_growth_yoy"].shift(2)
        for f in ("net_income", "op_income", "fcf", "gross_profit"):
            if f"ttm_{f}" in out:
                out[f"{f}_margin"] = out[f"ttm_{f}"] / out["ttm_revenue"]
        if "op_income_margin" in out:
            out["op_margin_change"] = out["op_income_margin"] - out["op_income_margin"].shift(4)
    if "ttm_net_income" in out:
        out["ni_growth_yoy"] = out["ttm_net_income"] / out["ttm_net_income"].shift(4).where(lambda x: x > 0) - 1.0
    out["available"] = out["available"].fillna(q["filed"] + pd.Timedelta(days=1))
    return out


def daily_multiples(close: pd.Series, t: pd.DataFrame) -> pd.DataFrame:
    """As-of join of TTM fundamentals onto trading days, then valuation multiples.

    `close` should be split-adjusted but NOT dividend-adjusted.
    """
    px = close.dropna().rename("close").to_frame()
    px.index.name = "date"
    px = px.reset_index()
    px["date"] = pd.to_datetime(px["date"]).astype("datetime64[ns]")
    f = t.dropna(subset=["available"]).copy()
    f["available"] = pd.to_datetime(f["available"]).astype("datetime64[ns]")
    f = f.sort_values("available")
    j = pd.merge_asof(px.sort_values("date"), f, left_on="date", right_on="available", direction="backward")
    j = j.set_index("date")
    out = pd.DataFrame(index=j.index)
    out["close"] = j["close"]
    if "shares_adj" in j:
        mcap = j["close"] * j["shares_adj"]
        out["market_cap"] = mcap
        debt = j["total_debt"].fillna(0.0) if "total_debt" in j else 0.0
        cash = j["cash"].fillna(0.0) if "cash" in j else 0.0
        ev = mcap + debt - cash
        out["ev"] = ev

        def ratio(num, den):
            return (num / den).where(den > 0)

        if "ttm_net_income" in j:
            out["pe"] = ratio(mcap, j["ttm_net_income"])
            out["earnings_yield"] = j["ttm_net_income"] / mcap
        if "ttm_revenue" in j:
            out["ps"] = ratio(mcap, j["ttm_revenue"])
            out["ev_sales"] = ratio(ev, j["ttm_revenue"])
        if "ttm_fcf" in j:
            out["pfcf"] = ratio(mcap, j["ttm_fcf"])
            out["fcf_yield"] = j["ttm_fcf"] / mcap
        if "ttm_op_income" in j:
            out["ev_ebit"] = ratio(ev, j["ttm_op_income"])
        if "equity" in j:
            out["pb"] = ratio(mcap, j["equity"])
    for col in ("rev_growth_yoy", "rev_growth_accel", "net_income_margin", "op_income_margin", "fcf_margin",
                "op_margin_change", "period_end", "available"):
        if col in j:
            out[col] = j[col]
    return out


def suggest_metric(sector: str | None, t: pd.DataFrame | None) -> str:
    """Pick the multiple that fits the business.

    Financials -> P/B. Real Estate -> P/FCF (operating cash flow proxy for FFO).
    Unprofitable in more than 1 of the last 8 quarters' TTM -> EV/Sales.
    Otherwise P/E.
    """
    sec = (sector or "").lower()
    if "financial" in sec or "bank" in sec or "insurance" in sec:
        return "pb"
    if "real estate" in sec or "reit" in sec:
        return "pfcf"
    if t is not None and "ttm_net_income" in t:
        last8 = t["ttm_net_income"].dropna().tail(8)
        if len(last8) and (last8 <= 0).sum() > 1:
            return "ev_sales"
    return "pe"


def bands(mult: pd.Series, window: int | None = None, min_periods: int = 252) -> pd.DataFrame:
    """Point-in-time valuation bands (expanding, or rolling `window` bars)."""
    s = mult.dropna()
    q = rolling_quantiles(s, window, min_periods=min_periods) if window else expanding_quantiles(s, min_periods=min_periods)
    q["value"] = s
    q["pctile"] = (s.rolling(window, min_periods=min_periods).rank(pct=True) if window
                   else expanding_pct_rank(s, min_periods))
    return q


def at_pivots(mult: pd.Series, pivots: pd.DataFrame, pctile: pd.Series | None = None) -> pd.DataFrame:
    """Multiple at each swing peak and trough (the stall and support levels)."""
    p = pivots[pivots["confirmed"]].copy()
    m = mult.reindex(pd.DatetimeIndex(p["date"]), method="ffill")
    p["multiple"] = m.to_numpy()
    if pctile is not None:
        p["pctile"] = pctile.reindex(pd.DatetimeIndex(p["date"]), method="ffill").to_numpy()
    return p.dropna(subset=["multiple"]).reset_index(drop=True)


def ceiling_levels(values: pd.Series, band: float = 0.075, min_hits: int = 3) -> pd.DataFrame:
    """Multiples where several peaks (or troughs) clustered within +/- band.

    Greedy: take the level with the most values inside its band, remove those
    values, repeat. Returns level, hits, and the member values.
    """
    v = pd.Series(values).dropna().sort_values().to_numpy()
    out = []
    remaining = list(v)
    while remaining:
        arr = np.array(remaining)
        counts = [((arr >= x * (1 - band)) & (arr <= x * (1 + band))).sum() for x in arr]
        k = int(np.argmax(counts))
        if counts[k] < min_hits:
            break
        lvl = arr[k]
        members = arr[(arr >= lvl * (1 - band)) & (arr <= lvl * (1 + band))]
        out.append({"level": float(np.median(members)), "hits": int(len(members)),
                    "low": float(members.min()), "high": float(members.max())})
        remaining = [x for x in remaining if not (lvl * (1 - band) <= x <= lvl * (1 + band))]
    return pd.DataFrame(out)


def pivot_valuation_summary(piv_vals: pd.DataFrame, current: float | None = None, band: float = 0.075) -> dict:
    """Where the stock stalled and found support, in multiple terms."""
    pk = piv_vals[piv_vals["kind"] == "peak"]["multiple"]
    tr = piv_vals[piv_vals["kind"] == "trough"]["multiple"]
    res = {"n_peaks": int(len(pk)), "n_troughs": int(len(tr)),
           "median_at_peaks": float(pk.median()) if len(pk) else np.nan,
           "median_at_troughs": float(tr.median()) if len(tr) else np.nan,
           "ceilings": ceiling_levels(pk, band).to_dict("records") if len(pk) >= 3 else [],
           "floors": ceiling_levels(tr, band).to_dict("records") if len(tr) >= 3 else []}
    if current is not None and np.isfinite(current):
        res["current"] = float(current)
        res["share_of_peaks_below_current"] = float((pk < current).mean()) if len(pk) else np.nan
        res["share_of_troughs_above_current"] = float((tr > current).mean()) if len(tr) else np.nan
    return res


def explain_multiple(daily: pd.DataFrame, metric: str, drivers=("rev_growth_yoy", "op_income_margin"),
                     as_of=None) -> dict:
    """Is today's multiple explained by growth and profitability?

    Fits log(multiple) on the drivers using quarterly samples up to `as_of`,
    then reports the current residual: positive = richer than its own
    growth/margin history would imply.
    """
    d = daily if as_of is None else daily[daily.index <= pd.Timestamp(as_of)]
    cols = [c for c in drivers if c in d]
    if metric not in d or not cols:
        return {"ok": False, "reason": "missing columns"}
    x = d[[metric] + cols].dropna()
    x = x[x[metric] > 0]
    qs = x.groupby(x.index.to_period("Q")).tail(1) if len(x) else x
    if len(qs) < 12:
        return {"ok": False, "reason": f"only {len(qs)} quarterly samples", "n": int(len(qs))}
    X = np.column_stack([np.ones(len(qs))] + [qs[c].to_numpy() for c in cols])
    y = np.log(qs[metric].to_numpy())
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    fit = X @ beta
    resid = y - fit
    r2 = 1 - resid.var() / y.var() if y.var() > 0 else np.nan
    cur = x.iloc[-1]
    xc = np.r_[1.0, [cur[c] for c in cols]]
    implied = float(np.exp(xc @ beta))
    return {"ok": True, "n": int(len(qs)), "r2": float(r2), "coef": dict(zip(["const"] + cols, map(float, beta))),
            "current": float(cur[metric]), "implied_by_fundamentals": implied,
            "premium_vs_implied": float(cur[metric] / implied - 1.0),
            "residual_pctile": float((resid < (np.log(cur[metric]) - xc @ beta)).mean())}

"""Market-level study on long-run public data (works without Yahoo or SEC).

Data: Shiller monthly S&P 500 (datahub mirror), CBOE VIX daily, 10y yield.
Shiller prices are monthly AVERAGES of daily closes. That makes drawdowns
shallower and short-term moves smoother than daily closes show, and it
shifts calendar effects by about half a month. Every output says so.

Point-in-time rules used here
* CAPE / trailing P/E percentiles are expanding: each month compares only
  with months before it.
* Trailing earnings are lagged 3 months before use (publication delay).
* Trend uses the 10-month average (about 200 trading days).
* Walk-forward: buckets are learned before 1990 and tested from 1990.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .analytics import drawdowns, evidence, seasonality, swings
from .analytics.indicators import expanding_pct_rank
from .data import macro


def monthly_frame() -> pd.DataFrame:
    s = macro.shiller()
    df = pd.DataFrame(index=s.index)
    df["close"] = s["close"]
    df["dividend"] = s["dividend"]
    df["earnings"] = s["earnings"]
    df["cpi"] = s["cpi"]
    df["cape"] = s["cape"]
    df["long_rate"] = s["long_rate"]
    # point-in-time valuation inputs: earnings and CAPE lagged 3 months
    df["pe_trailing_pit"] = s["close"] / s["earnings"].shift(3)
    df["cape_pit"] = s["cape"].shift(3)
    df["ret_1m"] = df["close"].pct_change()
    tr = (df["close"] + df["dividend"].fillna(0) / 12.0) / df["close"].shift(1)
    df["tr_index"] = tr.fillna(1.0).cumprod()
    df["real_tr_index"] = df["tr_index"] / df["cpi"]
    for h in (1, 12, 36, 60, 120):
        df[f"fwd_{h}m"] = df["close"].shift(-h) / df["close"] - 1.0
        df[f"fwd_real_tr_{h}m"] = (df["real_tr_index"].shift(-h) / df["real_tr_index"]) ** (12.0 / h) - 1.0 if h >= 12 \
            else df["real_tr_index"].shift(-h) / df["real_tr_index"] - 1.0
    df["sma10"] = df["close"].rolling(10).mean()
    df["trend"] = np.where(df["close"] > df["sma10"], "above_10m_avg", "below_10m_avg")
    df.loc[df["sma10"].isna(), "trend"] = pd.NA
    seg = df["close"].to_numpy()
    mae12 = np.full(len(seg), np.nan)
    for i in range(len(seg) - 12):
        mae12[i] = min(0.0, seg[i + 1: i + 13].min() / seg[i] - 1.0)
    df["mae_12m"] = mae12
    return df


def run(since: str = "1950-01-01") -> dict:
    df = monthly_frame()
    out: dict = {"source": "Shiller monthly S&P 500 (monthly average prices), datahub mirror",
                 "last_month": str(df["close"].dropna().index[-1].date())}
    c = df["close"].dropna()
    cm = c[c.index >= since]

    # 1. drawdowns
    ep = drawdowns.underwater_episodes(cm, 0.10)
    out["episodes_10pct"] = ep
    out["swing_declines_10pct"] = drawdowns.swing_declines(cm, 0.10)
    out["annual"] = drawdowns.calendar_year_drawdowns(cm)
    per_decade = out["swing_declines_10pct"].assign(decade=lambda d: (d["year"] // 10) * 10).groupby("decade").agg(
        n=("depth", "size"), from_high=("from_high", "sum"), median_depth=("depth", "median"))
    out["declines_per_decade"] = per_decade

    # 2. seasonality with walk-forward (approximate: averaged prices)
    out["season_stats"] = seasonality.seasonal_stats(_as_month_end(cm))
    out["season_wf_calls"], out["season_wf"] = seasonality.seasonal_walk_forward(_as_month_end(cm), min_years=10,
                                                                                conviction=0.65)

    # 3. valuation regimes: CAPE percentile (point-in-time, history from 1881)
    d = df.copy()
    d["cape_pctile"] = expanding_pct_rank(d["cape_pit"], 120)
    d["cape_bucket"] = pd.cut(d["cape_pctile"], [-0.01, 0.2, 0.4, 0.6, 0.8, 1.01],
                              labels=["0-20", "20-40", "40-60", "60-80", "80-100"]).astype(object)
    d["date"] = d.index
    m = d[d.index >= since]
    d12 = m.dropna(subset=["fwd_12m", "cape_bucket"]).copy()
    d12["up_12m"] = d12["fwd_12m"] > 0
    out["cape_vs_12m"] = evidence.conditional_table(d12, "cape_bucket", "up_12m", "fwd_12m", "mae_12m", horizon_days=365)
    d120 = m.dropna(subset=["fwd_real_tr_120m", "cape_bucket"]).copy()
    d120["real_10y_above_5pct"] = d120["fwd_real_tr_120m"] > 0.05
    out["cape_vs_10y"] = evidence.conditional_table(d120, "cape_bucket", "real_10y_above_5pct", "fwd_real_tr_120m",
                                                    horizon_days=3650)
    # the same test over the full record since 1891 (more non-overlapping decades)
    full = d[d.index >= "1891-01-01"].dropna(subset=["fwd_real_tr_120m", "cape_bucket"]).copy()
    full["real_10y_above_5pct"] = full["fwd_real_tr_120m"] > 0.05
    out["cape_vs_10y_since_1891"] = evidence.conditional_table(full, "cape_bucket", "real_10y_above_5pct",
                                                               "fwd_real_tr_120m", horizon_days=3650)
    out["cape_wf_12m"] = evidence.walk_forward(d12, "cape_pctile", "up_12m", split="1990-01-01", ret_col="fwd_12m")
    out["cape_wf_10y"] = evidence.walk_forward(d120, "cape_pctile", "real_10y_above_5pct", split="1990-01-01",
                                               ret_col="fwd_real_tr_120m")
    out["cape_now"] = {"cape": float(d["cape"].dropna().iloc[-1]), "cape_month": str(d["cape"].dropna().index[-1].date()),
                       "pctile_since_1881": float(d["cape_pctile"].dropna().iloc[-1])}

    # 4. trend regime: above/below 10-month average
    t = m.dropna(subset=["trend", "fwd_12m"]).copy()
    t["up_12m"] = t["fwd_12m"] > 0
    t["dd_over_10_next_12m"] = t["mae_12m"] <= -0.10
    out["trend_vs_12m"] = evidence.conditional_table(t, "trend", "up_12m", "fwd_12m", "mae_12m", horizon_days=365)
    out["trend_vs_drawdown"] = evidence.conditional_table(t, "trend", "dd_over_10_next_12m", "mae_12m", horizon_days=365)
    out["trend_wf_drawdown"] = _binary_walk_forward(t, "trend", "dd_over_10_next_12m", "1990-01-01")

    # 5. VIX regime at month end (1990+), forward 12m on monthly averages
    try:
        vix = macro.vix()
        vm = vix.resample("ME").last()
        vm.index = vm.index.to_period("M").to_timestamp()
        v = m.join(vm.rename("vix"), how="inner").dropna(subset=["vix", "fwd_12m"])
        v["vix_regime"] = pd.cut(v["vix"], [0, 15, 20, 30, 200], labels=["<15", "15-20", "20-30", ">30"]).astype(object)
        v["up_12m"] = v["fwd_12m"] > 0
        out["vix_vs_12m"] = evidence.conditional_table(v, "vix_regime", "up_12m", "fwd_12m", "mae_12m", horizon_days=365)
        out["vix_last"] = {"vix": float(vix.dropna().iloc[-1]), "date": str(vix.dropna().index[-1].date())}
    except Exception as e:
        out["vix_error"] = str(e)

    # 6. rates: 6-month change in the 10-year yield (monthly series runs later than Shiller's long rate)
    r = m.copy()
    try:
        y = macro.yield10().resample("MS").mean()
        r["y10"] = y.reindex(r.index)
    except Exception:
        r["y10"] = r["long_rate"]
    r["rate_chg_6m"] = (r["y10"] - r["y10"].shift(6)) * 100
    r["rates"] = np.select([r["rate_chg_6m"] >= 50, r["rate_chg_6m"] <= -50], ["rising_50bp+", "falling_50bp+"], "stable")
    r.loc[r["rate_chg_6m"].isna(), "rates"] = pd.NA
    r = r.dropna(subset=["rates", "fwd_12m"])
    r["up_12m"] = r["fwd_12m"] > 0
    out["rates_vs_12m"] = evidence.conditional_table(r, "rates", "up_12m", "fwd_12m", "mae_12m", horizon_days=365)

    # 7. rallies and selloffs: how far they ran, and odds of going further
    legs = swings.swing_legs(cm, 0.10)
    up = swings.completed_leg_sizes(legs, "up")
    dn = swings.completed_leg_sizes(legs, "down")
    out["rally_sizes"] = evidence.describe(up)
    out["decline_sizes"] = evidence.describe(dn)
    out["rally_odds"] = pd.DataFrame([swings.remaining_move_odds(up, x) for x in (0.10, 0.20, 0.30, 0.50)])
    out["decline_odds"] = pd.DataFrame([swings.remaining_move_odds(dn, x) for x in (0.10, 0.15, 0.20, 0.30)])
    out["legs"] = legs
    out["rally_bars"] = evidence.describe(legs[(legs["direction"] == "up") & legs["complete"]]["bars"])
    out["decline_bars"] = evidence.describe(legs[(legs["direction"] == "down") & legs["complete"]]["bars"])

    # 8. bounce vs recovery: bounces of 10%+ off a low at least 20% below the prior 12-month high
    bounce_rows = []
    v_ = cm.to_numpy()
    roll = cm.rolling(12, min_periods=1).max().to_numpy()
    for leg in legs[(legs["direction"] == "down")].itertuples():
        if pd.isna(leg.end_confirm_date):
            continue
        lo = leg.end_i
        dd = v_[lo] / roll[lo] - 1.0
        if dd > -0.20:
            continue
        i = cm.index.get_loc(leg.end_confirm_date)
        target = v_[lo] + 0.5 * (roll[lo] - v_[lo])
        fut = v_[i + 1:]
        u = np.nonzero(fut >= target)[0]
        dn_ = np.nonzero(fut < v_[lo])[0]
        u0 = u[0] if len(u) else None
        d0 = dn_[0] if len(dn_) else None
        outcome = "open" if u0 is None and d0 is None else "sustained" if d0 is None or (u0 is not None and u0 < d0) else "failed"
        bounce_rows.append({"low_month": leg.end_date, "confirmed": leg.end_confirm_date, "drawdown_at_low": dd,
                            "outcome": outcome,
                            "months_to_outcome": (u0 if outcome == "sustained" else d0) + 1 if outcome != "open" else np.nan,
                            "extra_downside_if_failed": (fut.min() / v_[lo] - 1.0) if outcome == "failed" else np.nan})
    out["bounces"] = pd.DataFrame(bounce_rows)
    return out


def _binary_walk_forward(df: pd.DataFrame, label: str, hit: str, split: str) -> pd.DataFrame:
    """Hit rate per label before and after `split` (labels need no fitted cutoffs)."""
    rows = []
    for name, part in (("before", df[df.index < split]), ("after", df[df.index >= split])):
        base = part[hit].astype(bool).mean()
        for lab, g in part.groupby(label):
            s = evidence.outcome_summary(g, hit, base_rate=base, horizon_days=365)
            s.update({"period": f"{name} {split[:4]}", "bucket": lab})
            rows.append(s)
    return pd.DataFrame(rows)


def _as_month_end(c: pd.Series) -> pd.Series:
    s = c.copy()
    s.index = s.index + pd.offsets.MonthEnd(0)
    return s


def _table(df: pd.DataFrame, cols: list[str], pct_cols: set[str]) -> list[str]:
    cols = [c for c in cols if c in df]
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for r in df[cols].to_dict("records"):
        cells = []
        for c in cols:
            v = r[c]
            if isinstance(v, (float, np.floating)) and c in pct_cols:
                cells.append("" if pd.isna(v) else f"{v:.0%}" if "rate" in c or c.startswith("ci") else f"{v:+.1%}")
            elif isinstance(v, (float, np.floating)):
                cells.append("" if pd.isna(v) else f"{v:.2f}")
            else:
                cells.append(str(v))
        lines.append("| " + " | ".join(cells) + " |")
    return lines


EV_COLS = ["bucket", "n", "n_eff", "hit_rate", "ci_low", "ci_high", "base_rate", "lift", "grade", "ret_median", "ret_p10",
           "ret_p90", "mae_median"]
EV_PCT = {"hit_rate", "ci_low", "ci_high", "base_rate", "ret_median", "ret_p10", "ret_p90", "mae_median"}


def markdown(out: dict) -> str:
    """Readable summary of the market study, every table with counts, failures and intervals."""
    def pct(x, d=1):
        return "n/a" if x is None or pd.isna(x) else f"{x:.{d}%}"

    L = [f"# S&P 500 market study (monthly data through {out['last_month']})", "",
         f"Source: {out['source']}. Monthly averages make declines shallower than daily closes "
         "(2007 to 2009 shows about -51% here vs -57% on daily closes). n_eff = non-overlapping events; "
         "grades use n_eff. Intervals are Wilson 95%.", ""]
    ep = out["episodes_10pct"]
    L += ["## 1. Extended downturns of 10%+ since 1950 (high to full recovery)", "",
          "| Peak | Trough | Depth | Months down | Months to recover | Total months |", "|---|---|---|---|---|---|"]
    for r in ep.itertuples():
        L.append(f"| {r.peak_date:%Y-%m} | {r.trough_date:%Y-%m} | {pct(r.depth)} | {r.decline_bars} | "
                 f"{'ongoing' if r.ongoing else int(r.recovery_bars)} | {'' if r.ongoing else int(r.total_bars)} |")
    sd = out["swing_declines_10pct"]
    L += ["", f"Swing declines of 10%+: {len(sd)} since 1950. {int(sd['from_high'].sum())} started near an all-time "
          f"high; {int((~sd['from_high']).sum())} were repeat legs inside an existing downturn.", ""]
    L += ["## 2. Calendar months (walk-forward)", ""]
    w = out["season_wf"]
    if w.get("n_calls"):
        L += [f"Predicting each month from earlier years only: {w['n_calls']} calls, accuracy {pct(w['accuracy'], 0)} "
              f"(95% {pct(w['ci_low'], 0)} to {pct(w['ci_high'], 0)}) vs {pct(w['naive_accuracy_same_periods'], 0)} "
              f"for always calling 'up'. Edge {w['edge_vs_naive']:+.0%}. Down calls made: {w['n_down_calls']}.", ""]
    L += _table(out["season_stats"].assign(failed=lambda d: d["failed_years"].map(len)),
                ["period", "n", "hit_rate", "ci_low", "ci_high", "median", "worst", "failed"],
                {"hit_rate", "ci_low", "ci_high", "median", "worst"}) + [""]
    L += ["## 3. Trend: above or below the 10-month average", "",
          "Hit = a further decline of 10% or more within 12 months. In this table the ret columns are the worst "
          "decline within the next 12 months.", ""]
    L += _table(out["trend_vs_drawdown"], EV_COLS, EV_PCT) + [""]
    L += ["Held before and after 1990:", ""]
    L += _table(out["trend_wf_drawdown"], ["period", "bucket", "n", "n_eff", "hit_rate", "base_rate", "lift"],
                {"hit_rate", "base_rate"}) + [""]
    L += ["12-month return by trend (hit = positive):", ""] + _table(out["trend_vs_12m"], EV_COLS, EV_PCT) + [""]
    cn = out["cape_now"]
    L += ["## 4. Valuation: CAPE percentile vs its own history (point-in-time, from 1881)", "",
          f"Latest CAPE in this dataset: {cn['cape']:.1f} ({cn['cape_month']}), percentile {pct(cn['pctile_since_1881'], 0)}. "
          "The mirror stopped updating earnings and CAPE in 2023, so today's level is not in this data.", "",
          "Next 12 months (hit = positive):", ""] + _table(out["cape_vs_12m"], EV_COLS, EV_PCT) + [""]
    L += ["Next 10 years, real total return (hit = above 5% a year), since 1891:", ""]
    L += _table(out["cape_vs_10y_since_1891"], EV_COLS, EV_PCT) + [""]
    L += ["Walk-forward (tercile cutoffs learned before 1990, applied after):", ""]
    L += _table(out["cape_wf_10y"], ["period", "bucket", "n", "hit_rate", "base_rate", "lift", "ret_median"],
                {"hit_rate", "base_rate", "ret_median"}) + [""]
    if "vix_vs_12m" in out:
        L += ["## 5. Volatility regime: month-end VIX vs next 12 months (1990+)", ""]
        L += _table(out["vix_vs_12m"], EV_COLS, EV_PCT) + [""]
    L += ["## 6. Rates: 6-month change in the 10-year yield vs next 12 months", ""]
    L += _table(out["rates_vs_12m"], EV_COLS, EV_PCT) + [""]
    L += ["## 7. Rallies and selloffs (10% zigzag, monthly, since 1950)", "",
          f"Completed rallies: {out['rally_sizes']['n']}, median size {pct(out['rally_sizes']['median'])}, "
          f"median length {out['rally_bars']['median']:.0f} months. Completed declines: {out['decline_sizes']['n']}, "
          f"median {pct(out['decline_sizes']['median'])}, median length {out['decline_bars']['median']:.0f} months.", "",
          "Once a rally reached X, share that went further:", ""]
    L += _table(out["rally_odds"], ["current", "n_reached", "median_final_if_reached", "p_extra_5", "p_extra_10", "p_extra_20"],
                {"current", "median_final_if_reached", "p_extra_5", "p_extra_10", "p_extra_20"}) + [""]
    L += ["Once a decline reached X, share that went further:", ""]
    L += _table(out["decline_odds"], ["current", "n_reached", "median_final_if_reached", "p_extra_5", "p_extra_10", "p_extra_20"],
                {"current", "median_final_if_reached", "p_extra_5", "p_extra_10", "p_extra_20"}) + [""]
    L += ["## 8. Bounces of 10%+ off a low at least 20% below the 12-month high", "",
          "Sustained = recovered half the drawdown before a new low.", ""]
    b = out["bounces"]
    if len(b):
        L += _table(b.assign(low=b["low_month"].dt.strftime("%Y-%m")),
                    ["low", "drawdown_at_low", "outcome", "months_to_outcome", "extra_downside_if_failed"],
                    {"drawdown_at_low", "extra_downside_if_failed"})
    return "\n".join(L) + "\n"

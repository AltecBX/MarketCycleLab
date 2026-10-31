"""MarketCycleLab dashboard.

Run:  streamlit run app/dashboard.py
Live mode pulls Yahoo prices and SEC EDGAR fundamentals (set MCL_SEC_USER_AGENT).
Demo mode uses synthetic data to show the screens; its numbers are fake.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import streamlit as st

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mcl import study  # noqa: E402
from mcl.analytics import peers as peers_mod, state  # noqa: E402
from mcl.config import ROOT, SEC_USER_AGENT  # noqa: E402
from mcl.data import demo, loader, universe  # noqa: E402
from mcl.report import charts  # noqa: E402

st.set_page_config(page_title="MarketCycleLab", layout="wide")

PCT_HINTS = ("rate", "ret", "depth", "move", "gain", "change", "pct", "mae", "mfe", "drift", "premium", "decline",
             "return", "fwd", "ci_", "excess", "from_", "vs_", "pre_", "post_", "day0", "gap", "growth", "margin",
             "downside", "drawdown", "bounce", "total_", "yield", "market", "sector", "industry", "company", "lift_")
COUNTS = ("n", "hits", "fails", "n_eff", "year", "hist_n", "leg_n", "episode_no", "leg_in_episode", "days_to_earnings",
          "analog_n", "base_n", "recovered_bars", "decline_bars", "recovery_bars", "total_bars", "bars")
NOT_PCT = ("lift", "p_value", "q_value", "rsi14", "volume_ratio", "level", "multiple", "period", "distance")


def pretty(df: pd.DataFrame) -> pd.DataFrame:
    """Format ratios as percents for display; leave counts and levels alone."""
    if df is None or df.empty:
        return df
    out = df.copy()
    for c in out.columns:
        name = str(c).lower()
        if out[c].dtype == object and out[c].map(type).nunique() > 1:
            out[c] = out[c].map(lambda v: "" if v is None or (isinstance(v, float) and np.isnan(v)) else str(v))
            continue  # mixed types (e.g. bucket 1, 2, 'ALL') cannot go to Arrow as is
        if not pd.api.types.is_numeric_dtype(out[c]) or pd.api.types.is_bool_dtype(out[c]):
            continue
        if name in COUNTS or name.startswith(("n_", "bars", "days")) or name.endswith(("bars", "_n")):
            out[c] = out[c].map(lambda v: "" if pd.isna(v) else f"{v:,.0f}")
        elif name in NOT_PCT:
            out[c] = out[c].map(lambda v: "" if pd.isna(v) else f"{v:,.0f}" if abs(v) >= 100 else f"{v:,.2f}")
        elif any(h in name for h in PCT_HINTS):
            out[c] = out[c].map(lambda v: "" if pd.isna(v) else f"{v:+.1%}" if "ret" in name or "excess" in name
                                or name.startswith(("pre_", "post_", "day0", "fwd", "total_")) else f"{v:.1%}")
        else:
            out[c] = out[c].map(lambda v: "" if pd.isna(v) else f"{v:,.2f}")
    return out


EVIDENCE_COLS = ["bucket", "n", "hits", "fails", "hit_rate", "ci_low", "ci_high", "base_rate", "lift", "grade",
                 "ret_median", "ret_p10", "ret_p90", "ret_median_when_failed", "mae_median", "mae_median_before_hit",
                 "days_median", "q_value"]


def evidence_table(t: pd.DataFrame):
    if t is None or t.empty:
        st.caption("No events.")
        return
    st.dataframe(pretty(t[[c for c in EVIDENCE_COLS if c in t]]), hide_index=True, width="stretch")


@st.cache_data(show_spinner="Loading data and running studies...", ttl=6 * 3600)
def run_cached(mode: str, ticker: str, threshold: float):
    b = demo.bundle(ticker=ticker or "DEMO") if mode == "Demo (synthetic)" else loader.load(ticker)
    R = study.run(b, threshold)
    return b, R


@st.cache_data(show_spinner="Loading peer valuations...", ttl=12 * 3600)
def peer_valuations(tickers: tuple, metric: str):
    out, notes = {}, []
    for t in tickers:
        try:
            pb = loader.load(t, with_regimes=False)
            if pb.valuation is not None and metric in pb.valuation:
                out[t] = {"series": pb.valuation[metric],
                          "snap": pb.valuation.dropna(subset=[metric]).iloc[-1] if pb.valuation[metric].notna().any() else None}
        except Exception as e:
            notes.append(f"{t}: {e}")
    return out, notes


@st.cache_data(show_spinner="Scanning watchlist...", ttl=6 * 3600)
def scan_cached(mode: str, tickers: tuple, threshold: float):
    bundles = {}
    for i, t in enumerate(tickers):
        try:
            if mode == "Demo (synthetic)":
                b = demo.bundle(seed=11 + i, ticker=t)
            else:
                b = loader.load(t, with_regimes=False)
            bundles[t] = {"prices": b.prices, "valuation": b.valuation, "metric": b.metric, "next_earnings": b.next_earnings}
        except Exception as e:
            bundles[t] = {"prices": pd.DataFrame({"close": []}), "error": str(e)}
    return state.scan(bundles, threshold)


# ---------------- sidebar ----------------
st.sidebar.title("MarketCycleLab")
mode = st.sidebar.radio("Data", ["Live (Yahoo + SEC)", "Demo (synthetic)"], index=0 if SEC_USER_AGENT else 1)
wl = universe.load_watchlist()
pick = st.sidebar.selectbox("Watchlist", ["(type below)"] + wl)
typed = st.sidebar.text_input("Ticker (stock, sector or industry ETF, SPY, QQQ)", value="" if pick != "(type below)" else "SPY")
ticker = (typed or pick).strip().upper() if pick == "(type below)" else pick
threshold = st.sidebar.select_slider("Swing size that counts as a rally or selloff", options=[0.05, 0.08, 0.10, 0.15, 0.20, 0.25, 0.30],
                                     value=0.10, format_func=lambda x: f"{x:.0%}")
dark = st.sidebar.toggle("Dark charts", value=False)
if mode.startswith("Live") and not SEC_USER_AGENT:
    st.sidebar.warning('Set MCL_SEC_USER_AGENT="Name email" for SEC fundamentals and earnings dates. Prices still load from Yahoo.')

try:
    b, R = run_cached(mode, ticker, threshold)
except Exception as e:
    st.error(f"Could not load {ticker}: {e}")
    st.stop()

if mode == "Demo (synthetic)":
    st.warning("DEMO MODE: synthetic data. Every number below is fake and only shows how the screens work.")
for n in R["notes"]:
    if "SYNTHETIC" not in n:
        st.caption(f"Note: {n}")

# ---------------- header ----------------
s = R["snapshot"]
info = R["info"]
st.title(f"{ticker}")
st.caption(" · ".join(x for x in [info.get("sector"), info.get("industry"),
                                   f"sector proxy {info.get('sector_etf')}" if info.get("sector_etf") else None,
                                   f"industry proxy {info.get('industry_etf')}" if info.get("industry_etf") else None,
                                   f"as of {pd.Timestamp(s['date']).date()}"] if x))
st.subheader(s["phase_text"])
c1, c2, c3, c4, c5 = st.columns(5)
c1.metric("Close", f"{s['close']:,.2f}", f"{s.get('ret_21d', np.nan):+.1%} 1m" if np.isfinite(s.get("ret_21d", np.nan)) else None)
c2.metric("From 52w high", f"{s.get('from_252d_high', np.nan):.1%}")
c3.metric(f"Current {'rally' if s['swing_direction'] == 'up' else 'decline'}", f"{s['leg_move']:+.1%}",
          f"pctile {s['leg_pctile']:.0%} of {s['leg_history_n']}" if np.isfinite(s.get("leg_pctile", np.nan)) else None,
          delta_color="off")
c4.metric(f"{(s.get('valuation_metric') or 'valuation').upper()} pctile",
          f"{s['valuation_pctile']:.0%}" if np.isfinite(s.get("valuation_pctile", np.nan)) else "n/a",
          f"{s['valuation']:.1f}x" if np.isfinite(s.get("valuation", np.nan)) else None, delta_color="off")
c5.metric("Next earnings (trading days)", f"{s['days_to_earnings']}" if s.get("days_to_earnings") is not None else "n/a")
for a in s["alerts"]:
    st.markdown(f"- {a}")

tabs = st.tabs(["Overview", "Drawdowns", "Seasonality", "Earnings", "Valuation", "Peers", "Rallies & selloffs",
                "Bounce vs recovery", "Relative", "Conditions", "Similar situations", "Watchlist", "Method"])

with tabs[0]:
    st.plotly_chart(charts.price_overview(R, b.prices, b.earnings, dark, b.regimes), width="stretch")
    st.caption("Swing peaks and troughs are drawn at the bar they printed, which is only known in hindsight. "
               "Signals in the other tabs use the confirmation bar.")

with tabs[1]:
    es, ds = R["episode_summary"], R["decline_summary"]
    a, bcol, ccol, dcol = st.columns(4)
    a.metric("Extended downturns ≥5%", es.get("n", 0))
    bcol.metric("Median downturn depth", f"{es.get('median_depth', np.nan):.1%}")
    ccol.metric(f"Swing selloffs ≥{threshold:.0%}", ds.get("n", 0))
    dcol.metric("Median bars to recover (selloffs)", f"{ds.get('median_recovery_bars', np.nan):.0f}")
    st.plotly_chart(charts.annual_declines(R["annual"], dark), width="stretch")
    cols = ["year", "return", "max_intra_year_decline", "n_5pct", "n_5pct_from_high", "n_10pct", "n_10pct_from_high",
            "n_20pct", "n_20pct_from_high"]
    st.markdown("**Selloffs per year.** `from_high` counts declines that started near an all-time high; the rest were repeat legs inside an existing downturn.")
    st.dataframe(pretty(R["annual"][[c for c in cols if c in R["annual"]]]), hide_index=True, width="stretch")
    st.plotly_chart(charts.episodes_scatter(R["episodes"], dark), width="stretch")
    st.markdown("**Extended downturns** (all-time high to full recovery)")
    st.dataframe(pretty(R["episodes"].drop(columns=["peak_i", "trough_i", "recovery_i"], errors="ignore")), hide_index=True, width="stretch")
    st.markdown(f"**Swing selloffs ≥{threshold:.0%}**, tagged with the downturn they belong to")
    st.dataframe(pretty(R["declines"][[c for c in ["start_date", "end_date", "depth", "bars", "from_high", "episode_no",
                                                   "leg_in_episode", "episode_depth", "recovery_bars"] if c in R["declines"]]]),
                 hide_index=True, width="stretch")

with tabs[2]:
    st.plotly_chart(charts.season_heatmap(R["season_table"], dark), width="stretch")
    st.plotly_chart(charts.season_hit_rates(R["season_stats"], dark), width="stretch")
    if "season_stats_excess" in R:
        st.plotly_chart(charts.season_hit_rates(R["season_stats_excess"], dark, "Share of years each month beat SPY"), width="stretch")
    wf = R["season_wf"]
    st.markdown("**Did the seasonal pattern hold out of sample?** Each year is predicted from earlier years only.")
    if wf.get("n_calls"):
        st.write(f"{wf['n_calls']} calls, accuracy {wf['accuracy']:.0%} (95% {wf['ci_low']:.0%} to {wf['ci_high']:.0%}) "
                 f"vs {wf['naive_accuracy_same_periods']:.0%} for always calling the usual direction. "
                 f"Edge: {wf['edge_vs_naive']:+.0%}.")
    if "season_wf_excess" in R and R["season_wf_excess"].get("n_calls"):
        w2 = R["season_wf_excess"]
        st.write(f"Versus SPY: {w2['n_calls']} calls, accuracy {w2['accuracy']:.0%} vs naive {w2['naive_accuracy_same_periods']:.0%}.")
    st.dataframe(pretty(R["season_stats"].assign(failed_years=R["season_stats"]["failed_years"].map(lambda x: ", ".join(map(str, x))))),
                 hide_index=True, width="stretch")
    st.plotly_chart(charts.season_path(R["season_path"], dark), width="stretch")
    st.markdown("**Earnings season phases** (calendar position relative to quarter ends)")
    st.dataframe(pretty(R["season_phases"]), hide_index=True, width="stretch")

with tabs[3]:
    if "earn_table" not in R:
        st.info("No earnings history (ETF, index, or dates unavailable).")
    else:
        es = R["earn_summary"]
        a, bcol, ccol, dcol = st.columns(4)
        a.metric("Reports studied", es["n"])
        bcol.metric("Ran up into report", f"{es['pct_ran_up_into_report']:.0%}")
        ccol.metric("Rose on reaction day", f"{es['pct_day0_up']:.0%}")
        dcol.metric("Drops recovered in 20 bars", f"{es['pct_drops_recovered_20']:.0%}" if np.isfinite(es["pct_drops_recovered_20"]) else "n/a")
        st.plotly_chart(charts.earnings_path(R["earn_path"], dark), width="stretch")
        st.plotly_chart(charts.earnings_scatter(R["earn_table"], dark), width="stretch")
        if len(R.get("earn_priced_in", [])):
            st.markdown("**What was priced in:** reaction by result and by how the stock traded into the report")
            st.dataframe(pretty(R["earn_priced_in"]), hide_index=True, width="stretch")
        if "earn_by_valuation" in R:
            st.markdown("**Reaction by valuation going in** (hit = reaction day up; valuation percentile vs own history at t-1)")
            evidence_table(R["earn_by_valuation"])
        if "earn_by_result" in R:
            st.markdown("**Reaction by result**")
            evidence_table(R["earn_by_result"])
        cols = ["report_date", "timing", "result", "surprise_pct", "pre_20", "gap", "day0", "post_5", "post_20",
                "recovered_bars", "pattern", "pre_val_pctile"]
        st.dataframe(pretty(R["earn_table"][[c for c in cols if c in R["earn_table"]]].iloc[::-1]), hide_index=True, width="stretch")
        st.caption("Guidance is not in free structured data. Add a 'guidance' column (raised/maintained/lowered) "
                   "to data/user/earnings/<TICKER>.csv to condition on it.")

with tabs[4]:
    if "val_bands" not in R:
        st.info("No fundamentals (ETF/index, or SEC data unavailable).")
    else:
        st.plotly_chart(charts.valuation_bands(R["val_bands"], R["val_pivots"], b.metric, R["val_pivot_summary"], dark), width="stretch")
        ps = R["val_pivot_summary"]
        st.write(f"Median {b.metric.upper()} at swing peaks {ps['median_at_peaks']:.1f}, at swing troughs "
                 f"{ps['median_at_troughs']:.1f}, now {ps.get('current', np.nan):.1f}. "
                 f"{ps.get('share_of_peaks_below_current', np.nan):.0%} of past peaks happened at a lower multiple than today.")
        ex = R["val_explain"]
        if ex.get("ok"):
            st.write(f"Growth and margins explain {ex['r2']:.0%} of its multiple history (n={ex['n']} quarters). "
                     f"Today it trades {ex['premium_vs_implied']:+.0%} versus what its current growth and margin implied historically.")
        else:
            st.caption(f"Fundamental fit skipped: {ex.get('reason')}")
        vcols = [c for c in ("pe", "ps", "ev_sales", "pfcf", "ev_ebit", "pb", "rev_growth_yoy", "op_income_margin", "fcf_margin") if c in b.valuation]
        st.markdown("**Other multiples** (pick the one that fits the business; the default is chosen automatically)")
        vq = b.valuation[vcols].dropna(how="all")
        vq = vq.groupby(vq.index.to_period("Q")).tail(1).tail(12).iloc[::-1]
        vq.index = vq.index.strftime("%Y-%m-%d")
        st.dataframe(pretty(vq.reset_index(names="date")), hide_index=True, width="stretch")

with tabs[5]:
    peer_list = info.get("peers", [])[:12]
    if mode == "Demo (synthetic)" or not peer_list or b.metric is None:
        st.info("Peers come from the S&P 500 GICS sub-industry, or from data/user/peers.json. Live mode only.")
    elif st.button(f"Load {len(peer_list)} peers: {', '.join(peer_list)}"):
        pv, notes = peer_valuations(tuple(peer_list), b.metric)
        for n in notes:
            st.caption(n)
        if len(pv) >= 3:
            ph = peers_mod.premium_history(b.valuation[b.metric], {k: v["series"] for k, v in pv.items()})
            fig = charts._base(charts.go.Figure(), charts.theme(dark), f"{b.metric.upper()} premium vs peer median", 360)
            fig.add_trace(charts.go.Scatter(x=ph.index, y=ph["premium"], line=dict(color=charts.theme(dark)["s"][0], width=2),
                                            name="premium", hovertemplate="%{y:.0%}<extra></extra>"))
            fig.update_yaxes(tickformat=".0%")
            st.plotly_chart(fig, width="stretch")
            last = ph.dropna().iloc[-1]
            st.write(f"Premium now {last['premium']:+.0%}; median to date {last['premium_median_to_date']:+.0%}; "
                     f"percentile {last['premium_pctile']:.0%} of its own premium history.")
            snap = pd.DataFrame({k: v["snap"] for k, v in pv.items() if v["snap"] is not None}).T
            snap.loc[ticker] = b.valuation.dropna(subset=[b.metric]).iloc[-1]
            fit = peers_mod.cross_section_fit(snap, b.metric)
            st.markdown("**Is the premium earned?** Cross-section fit of the multiple on revenue growth and operating margin")
            st.dataframe(pretty(fit[[c for c in [b.metric, "rev_growth_yoy", "op_income_margin", "implied_multiple",
                                                 "premium_vs_implied"] if c in fit]].reset_index(names="ticker")),
                         hide_index=True, width="stretch")
    if "val_bands" in R and b.valuation is not None:
        from mcl.analytics import events as ev_mod
        fwd = ev_mod.forward_returns(b.prices["adj_close"])["fwd_126"]
        st.markdown("**Cheap vs value trap (own history):** next-126-bar return by valuation and fundamental momentum (revenue growth accelerating or not)")
        evidence_table(peers_mod.quadrant_study(b.valuation, b.metric, fwd))

with tabs[6]:
    for name, label, sizes, cur_dir in (("rallies", "Rallies", R["rally_sizes"], "up"), ("selloffs", "Selloffs", R["decline_sizes"], "down")):
        st.markdown(f"### {label}")
        cur = s["leg_move"] if s["swing_direction"] == cur_dir else None
        st.plotly_chart(charts.leg_distribution(sizes, cur, cur_dir, dark), width="stretch")
        e = R["evidence"].get(name)
        if not e:
            st.caption("No events.")
            continue
        hit = "continued: +10% more before a 10% pullback" if name == "rallies" else "more downside: another -10% before a +15% rebound"
        st.markdown(f"Hit = {hit}. Rows are checkpoints (how far it had already moved) and market conditions.")
        for k, t in e["tables"].items():
            st.markdown(f"by **{k}**")
            evidence_table(t)
        if e["walk_forward"]:
            st.markdown("**Walk-forward:** cutoffs learned on the earlier 60% of events, tested on the later 40%")
            for k, w in e["walk_forward"].items():
                st.markdown(f"_{k}_")
                st.dataframe(pretty(w[[c for c in ["period", "bucket", "n", "hits", "fails", "hit_rate", "base_rate", "lift"] if c in w]]),
                             hide_index=True, width="stretch")

with tabs[7]:
    for name, label in (("bounces", "Bounce after a ≥20% drawdown: sustained (retraces half) vs failed (new low)"),
                        ("pullbacks", "Pullback ≥8% in an uptrend: normal (new high first) vs downturn (-20% first)")):
        st.markdown(f"### {label}")
        e = R["evidence"].get(name)
        if not e:
            st.caption("No events.")
            continue
        o = e["overall"]
        st.write(f"{o['n']} events, {o['hits']} hits, {o['fails']} failures ({o['hit_rate']:.0%}, 95% {o['ci_low']:.0%} to {o['ci_high']:.0%}).")
        for k, t in e["tables"].items():
            st.markdown(f"by **{k}**")
            evidence_table(t)
        if e["walk_forward"]:
            for k, w in e["walk_forward"].items():
                st.markdown(f"_walk-forward {k}_")
                st.dataframe(pretty(w[[c for c in ["period", "bucket", "n", "hits", "fails", "hit_rate", "base_rate", "lift"] if c in w]]),
                             hide_index=True, width="stretch")
        st.dataframe(pretty(R[name].drop(columns=[c for c in R[name].columns if c.startswith("fp_")], errors="ignore").iloc[::-1].head(30)),
                     hide_index=True, width="stretch")

with tabs[8]:
    if "attribution_now" in R:
        st.plotly_chart(charts.attribution_bars(R["attribution_now"], dark), width="stretch")
        st.markdown("**How it behaved in each market selloff ≥8%** (lead_bars > 0: its low came before the market's)")
        st.dataframe(pretty(R["selloff_behavior"]), hide_index=True, width="stretch")
    else:
        st.info("No market series.")

with tabs[9]:
    rn = R.get("regime_now", {})
    st.write({k: (f"{v:.2f}" if isinstance(v, float) else v) for k, v in rn.items()})
    st.markdown("Every evidence table in the swing tabs is also split by market trend (bull/bear/sideways), VIX regime, "
                "and 10y yield direction at the time of each event. A pattern that only works in one regime shows up there.")

with tabs[10]:
    if "analogs" in R:
        st.plotly_chart(charts.analog_fan(R["analogs"], b.prices["adj_close"], 126, dark), width="stretch")
        st.markdown("**Analogs vs all eligible past dates (base rate)**")
        st.dataframe(pretty(R["analog_summary"]), hide_index=True, width="stretch")
        st.dataframe(pretty(R["analogs"]), hide_index=True, width="stretch")
        st.caption("Analogs are the past dates whose feature percentiles were closest to today, at least 21 bars apart, "
                   "using only dates whose outcome window finished before today.")

with tabs[11]:
    tks = st.text_input("Watchlist (comma separated; save to data/user/watchlist.json to persist)", ",".join(wl))
    lst = tuple(t.strip().upper() for t in tks.split(",") if t.strip())
    sc = scan_cached(mode, lst, threshold)
    st.dataframe(pretty(sc), hide_index=True, width="stretch")

with tabs[12]:
    p = ROOT / "RESEARCH_FRAMEWORK.md"
    st.markdown(p.read_text() if p.exists() else "See RESEARCH_FRAMEWORK.md")

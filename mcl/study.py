"""Run every study for one ticker and return plain DataFrames/dicts.

The dashboard, the HTML report and the CLI all call `run`, so a number shown
in one place is the same number everywhere.
"""
from __future__ import annotations

import pandas as pd

from .analytics import (analogs, drawdowns, earnings, evidence, events, indicators, regimes, relative,
                        seasonality, state, swings, valuation)
from .data.loader import Bundle


def _context(b: Bundle) -> pd.DataFrame | None:
    """Point-in-time context joined onto events: market regime, valuation percentile, relative strength."""
    idx = b.prices.index
    parts = []
    if b.regimes is not None:
        reg = b.regimes.reindex(idx).ffill()
        names = {"trend": "mkt_trend", "vol": "mkt_vol", "rates": "mkt_rates", "mkt_from_high": "mkt_from_high"}
        parts.append(reg[[c for c in names if c in reg]].rename(columns=names))
    if b.valuation is not None and b.metric in (b.valuation if b.valuation is not None else {}):
        v = b.valuation[b.metric]
        parts.append(pd.DataFrame({"val_pctile": indicators.expanding_pct_rank(v.where(v > 0), 252)}).reindex(idx))
        for col in ("rev_growth_yoy", "rev_growth_accel", "op_margin_change"):
            if col in b.valuation:
                parts.append(b.valuation[[col]].reindex(idx))
    ref = b.industry if b.industry is not None else b.sector if b.sector is not None else b.market
    if ref is not None:
        rs = relative.rs_line(b.prices["adj_close"], ref["adj_close"])
        rs["rs_pctile"] = indicators.expanding_pct_rank(rs["rs_chg_63"], 252)
        parts.append(rs[["rs_chg_63", "rs_pctile"]].reindex(idx))
    if not parts:
        return None
    ctx = pd.concat(parts, axis=1)
    # buckets from point-in-time percentiles, so the cutoffs never use later data
    for col, src in (("val_pctile_bucket", "val_pctile"), ("rs_chg_63_bucket", "rs_pctile")):
        if src in ctx:
            ctx[col] = pd.cut(ctx[src], [-0.01, 1 / 3, 2 / 3, 1.01], labels=["low", "mid", "high"]).astype(object)
    return ctx


def run(b: Bundle, threshold: float = 0.10, near_high: float = 0.03) -> dict:
    px = b.prices
    close = px["close"].dropna()
    adj = px["adj_close"].dropna() if "adj_close" in px else close
    mkt = b.market["adj_close"] if b.market is not None else None
    R: dict = {"ticker": b.ticker, "info": b.info, "notes": list(b.notes), "threshold": threshold}

    # 1 drawdowns and recoveries (price, not total return)
    R["episodes"] = drawdowns.underwater_episodes(close, 0.05)
    R["declines"] = drawdowns.swing_declines(close, threshold, near_high)
    R["annual"] = drawdowns.calendar_year_drawdowns(close).merge(
        drawdowns.annual_selloff_counts(close, (0.05, 0.10, 0.20), near_high).reset_index(), on="year", how="left")
    R["episode_summary"] = drawdowns.summarize_episodes(R["episodes"])
    R["decline_summary"] = drawdowns.summarize_episodes(R["declines"])
    R["pivots"] = swings.zigzag(close, threshold)
    R["legs"] = swings.swing_legs(close, threshold)

    # 2 seasonality (total return; excess vs market when available)
    R["season_table"] = seasonality.calendar_table(adj)
    R["season_stats"] = seasonality.seasonal_stats(adj)
    R["season_wf_calls"], R["season_wf"] = seasonality.seasonal_walk_forward(adj)
    if mkt is not None and b.ticker not in ("SPY",):
        R["season_stats_excess"] = seasonality.seasonal_stats(adj, col="excess", benchmark=mkt)
        _, R["season_wf_excess"] = seasonality.seasonal_walk_forward(adj, col="excess", benchmark=mkt)
    R["season_path"] = seasonality.seasonal_path(adj)
    R["season_phases"] = seasonality.earnings_season_stats(adj, mkt)

    ctx = _context(b)
    R["context"] = ctx

    # 3 earnings
    pe = b.past_earnings
    if pe is not None and len(pe) >= 4:
        tab, path = earnings.event_study(px, pe, benchmark=mkt, context=ctx)
        R["earn_table"], R["earn_path"] = tab, path
        R["earn_summary"] = earnings.summary(tab)
        R["earn_priced_in"] = earnings.priced_in_table(tab)
        if "pre_val_pctile_bucket" in tab:
            R["earn_by_valuation"] = earnings.conditional(tab, "pre_val_pctile_bucket")
        if "result" in tab and tab["result"].notna().sum() >= 6:
            R["earn_by_result"] = earnings.conditional(tab, "result")
        R["earn_by_pattern"] = tab["pattern"].value_counts().rename_axis("pattern").reset_index(name="n")
    R["next_earnings"] = b.next_earnings

    # 4 valuation vs own history
    if b.valuation is not None and b.metric in b.valuation:
        m = b.valuation[b.metric]
        bd = valuation.bands(m)
        R["val_bands"] = bd
        R["val_pivots"] = valuation.at_pivots(m, R["pivots"], bd["pctile"])
        cur = m.dropna().iloc[-1] if m.notna().any() else None
        R["val_pivot_summary"] = valuation.pivot_valuation_summary(R["val_pivots"], cur)
        R["val_explain"] = valuation.explain_multiple(b.valuation, b.metric)

    # 6, 7, 8 swing studies with point-in-time context
    R["rallies"] = events.rally_checkpoints(px, threshold, context=ctx)
    R["selloffs"] = events.selloff_checkpoints(px, threshold, context=ctx)
    R["bounces"] = events.bounce_events(px, context=ctx)
    R["pullbacks"] = events.pullback_events(px, context=ctx)
    ev_specs = {
        "rallies": ("continued", "fp_ret_horizon", "fp_mae", "fp_bars_to_outcome", "checkpoint"),
        "selloffs": ("more_downside_first", "extra_downside", "fp_mae", "bars_to_low", "checkpoint"),
        "bounces": ("sustained", "bounce_at_event", "mae_before_outcome", "bars_to_outcome", None),
        "pullbacks": ("normal_pullback", "max_depth_before_outcome", None, "bars_to_outcome", None),
    }
    R["evidence"] = {}
    for name, (hit, ret, mae, days, by) in ev_specs.items():
        ev = R[name]
        if ev is None or ev.empty or hit not in ev:
            continue
        out = {"overall": evidence.outcome_summary(ev, hit, ret, mae, days)}
        tables = {}
        if by:
            tables[by] = evidence.conditional_table(ev, by, hit, ret, mae, days)
        for col in ("mkt_trend", "mkt_vol", "mkt_rates", "val_pctile_bucket", "rs_chg_63_bucket"):
            if col in ev and ev[col].notna().sum() >= 6:
                tables[col] = evidence.conditional_table(ev, col, hit, ret, mae, days)
        wf = {}
        for feat in ("vol20", "volume_ratio", "rsi14", "from_252d_high", "val_pctile", "rs_chg_63", "speed"):
            if feat in ev and ev[feat].notna().sum() >= 12:
                w = evidence.walk_forward(ev, feat, hit)
                if not w.empty:
                    wf[feat] = w
        out["tables"], out["walk_forward"] = tables, wf
        R["evidence"][name] = out

    # leg size distributions for the remaining-move question
    R["rally_sizes"] = swings.completed_leg_sizes(R["legs"], "up")
    R["decline_sizes"] = swings.completed_leg_sizes(R["legs"], "down")

    # 9 relative to industry, sector, market
    if mkt is not None:
        sec = b.sector["adj_close"] if b.sector is not None else None
        ind = b.industry["adj_close"] if b.industry is not None else None
        att = {}
        for w in (21, 63, 126, 252):
            a = relative.attribution(adj, mkt, sec, ind, w)
            if len(a.dropna()):
                att[w] = a.dropna().iloc[-1]
        R["attribution_now"] = pd.DataFrame(att).T
        R["attribution_63"] = relative.attribution(adj, mkt, sec, ind, 63)
        R["selloff_behavior"] = relative.behavior_in_selloffs(adj, mkt, 0.08)

    # 10 regimes now
    if b.regimes is not None:
        R["regime_now"] = b.regimes.dropna(how="all").iloc[-1].to_dict()

    # 12 analogs and snapshot
    feats = indicators.technical_features(px)
    if ctx is not None:
        for col in ("val_pctile", "rs_chg_63", "mkt_from_high"):
            if col in ctx:
                feats[col] = ctx[col]
    try:
        R["analogs"], R["analog_summary"] = analogs.analog_search(feats, adj)
    except Exception as e:
        R["notes"].append(f"analogs skipped: {e}")
    R["snapshot"] = state.snapshot(px, threshold, valuation=b.valuation, val_metric=b.metric,
                                   next_earnings=b.next_earnings)
    return R

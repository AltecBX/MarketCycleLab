"""Self-contained HTML report for one ticker (charts + evidence tables)."""
from __future__ import annotations

import html
from pathlib import Path

import pandas as pd

from . import charts

CSS = """
:root{--bg:#f9f9f7;--card:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--line:#e1e0d9}
@media (prefers-color-scheme: dark){:root{--bg:#0d0d0d;--card:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--line:#2c2c2a}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px}
h1{font-size:28px;margin:0 0 4px} h2{font-size:19px;margin:32px 0 8px} .sub{color:var(--ink2)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin:12px 0;overflow-x:auto}
table{border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:13px}
th,td{padding:4px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left} th{color:var(--ink2);font-weight:600}
.warn{background:#fff4d6;color:#5a4300;padding:8px 12px;border-radius:8px}
ul{margin:6px 0}
"""


def _table(df: pd.DataFrame | None, cols: list[str] | None = None) -> str:
    if df is None or len(df) == 0:
        return "<p class='sub'>No data.</p>"
    d = df[[c for c in cols if c in df]] if cols else df
    out = d.copy()
    for c in out.columns:
        if pd.api.types.is_float_dtype(out[c]):
            name = str(c).lower()
            if any(k in name for k in ("rate", "ret", "depth", "pct", "mae", "ci_", "premium", "change", "move", "decline",
                                       "return", "fwd", "pre_", "post_", "day0", "drawdown", "excess", "market",
                                       "sector", "industry", "company", "total")) and "bars" not in name:
                out[c] = out[c].map(lambda v: "" if pd.isna(v) else f"{v:.1%}")
            else:
                out[c] = out[c].map(lambda v: "" if pd.isna(v) else f"{v:,.2f}")
    return "<div class='card'>" + out.to_html(index=False, escape=True, border=0) + "</div>"


EV = ["bucket", "n", "hits", "fails", "hit_rate", "ci_low", "ci_high", "base_rate", "lift", "grade", "ret_median",
      "ret_p10", "ret_p90", "mae_median", "days_median"]


def build(b, R: dict, path: Path) -> Path:
    figs, first = [], True

    def fig(f):
        nonlocal first
        s = f.to_html(full_html=False, include_plotlyjs=True if first else False, config={"displaylogo": False})
        first = False
        return f"<div class='card'>{s}</div>"

    s = R["snapshot"]
    demo = any("SYNTHETIC" in n for n in R["notes"])
    parts = [f"<h1>{html.escape(b.ticker)}</h1>",
             f"<div class='sub'>{html.escape(' · '.join(str(x) for x in [R['info'].get('sector'), R['info'].get('industry'), 'as of ' + str(pd.Timestamp(s['date']).date())] if x))}</div>"]
    if demo:
        parts.append("<p class='warn'>Synthetic demo data. Every number is fake.</p>")
    parts.append(f"<h2>{html.escape(s['phase_text'])}</h2><ul>" + "".join(f"<li>{html.escape(a)}</li>" for a in s["alerts"]) + "</ul>")
    parts.append(fig(charts.price_overview(R, b.prices, b.earnings, False, b.regimes)))
    parts.append("<h2>1. Drawdowns and recoveries</h2>")
    parts.append(fig(charts.annual_declines(R["annual"])))
    parts.append(_table(R["episodes"], ["peak_date", "trough_date", "depth", "decline_bars", "recovery_bars", "total_bars", "ongoing"]))
    parts.append(_table(R["declines"], ["start_date", "end_date", "depth", "bars", "from_high", "episode_no", "leg_in_episode", "recovery_bars"]))
    parts.append("<h2>2. Seasonality</h2>")
    parts.append(fig(charts.season_heatmap(R["season_table"])))
    parts.append(fig(charts.season_hit_rates(R["season_stats"])))
    w = R["season_wf"]
    if w.get("n_calls"):
        parts.append(f"<p>Walk-forward: {w['n_calls']} calls, accuracy {w['accuracy']:.0%} vs {w['naive_accuracy_same_periods']:.0%} naive.</p>")
    if "earn_table" in R:
        parts.append("<h2>3. Earnings</h2>")
        parts.append(fig(charts.earnings_path(R["earn_path"])))
        parts.append(fig(charts.earnings_scatter(R["earn_table"])))
        parts.append(_table(R.get("earn_priced_in")))
        if "earn_by_valuation" in R:
            parts.append(_table(R["earn_by_valuation"], EV))
    if "val_bands" in R:
        parts.append("<h2>4. Valuation vs own history</h2>")
        parts.append(fig(charts.valuation_bands(R["val_bands"], R["val_pivots"], b.metric, R["val_pivot_summary"])))
    parts.append("<h2>6 to 8. Rallies, selloffs, bounces, pullbacks</h2>")
    parts.append(fig(charts.leg_distribution(R["rally_sizes"], s["leg_move"] if s["swing_direction"] == "up" else None, "up")))
    parts.append(fig(charts.leg_distribution(R["decline_sizes"], s["leg_move"] if s["swing_direction"] == "down" else None, "down")))
    for name, e in R["evidence"].items():
        parts.append(f"<h3>{name}</h3>")
        for k, t in e["tables"].items():
            parts.append(f"<p class='sub'>by {html.escape(k)}</p>" + _table(t, EV))
    if "attribution_now" in R:
        parts.append("<h2>9. Relative to industry, sector, market</h2>")
        parts.append(fig(charts.attribution_bars(R["attribution_now"])))
        parts.append(_table(R["selloff_behavior"]))
    if "analogs" in R:
        parts.append("<h2>12. Similar past situations</h2>")
        parts.append(fig(charts.analog_fan(R["analogs"], b.prices["adj_close"])))
        parts.append(_table(R["analog_summary"]))
    doc = (f"<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
           f"<title>{html.escape(b.ticker)} cycle report</title><style>{CSS}</style></head><body><main>"
           + "".join(parts) + "</main></body></html>")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(doc, encoding="utf-8")
    return path

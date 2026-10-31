"""Plotly figures shared by the dashboard and the HTML report.

Palette: validated reference instance (dataviz skill). Categorical slots are
used in fixed order and follow the entity (stock=1, market=2, sector=3,
industry=4). Seasonality uses the blue/red diverging pair with a gray
midpoint. No chart uses two y-scales: price and drawdown are stacked panels.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots

LIGHT = {"surface": "#fcfcfb", "page": "#f9f9f7", "ink": "#0b0b0b", "ink2": "#52514e", "muted": "#898781",
         "grid": "#e1e0d9", "axis": "#c3c2b7",
         "s": ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
         "neutral": "#f0efec", "good": "#0ca30c", "critical": "#d03b3b"}
DARK = {"surface": "#1a1a19", "page": "#0d0d0d", "ink": "#f0efec", "ink2": "#c3c2b7", "muted": "#898781",
        "grid": "#2c2c2a", "axis": "#383835",
        "s": ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
        "neutral": "#383835", "good": "#0ca30c", "critical": "#d03b3b"}
BLUE_RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]
RED_RAMP = ["#fbd5d4", "#f4a9a8", "#ec7c7b", "#e34948", "#c13434", "#962726", "#6b1b1b"]


def theme(dark: bool = False) -> dict:
    return DARK if dark else LIGHT


def _base(fig: go.Figure, T: dict, title: str | None = None, height: int = 420) -> go.Figure:
    fig.update_layout(
        template="none", height=height, paper_bgcolor=T["surface"], plot_bgcolor=T["surface"],
        font=dict(family='system-ui, -apple-system, "Segoe UI", sans-serif', size=13, color=T["ink"]),
        title=dict(text=title, x=0, xanchor="left", font=dict(size=15, color=T["ink"])) if title else None,
        margin=dict(l=56, r=24, t=48 if title else 16, b=96), hovermode="x unified",
        legend=dict(orientation="h", yanchor="top", y=-0.16, x=0, font=dict(color=T["ink2"])),
        hoverlabel=dict(bgcolor=T["surface"], font=dict(color=T["ink"]), bordercolor=T["axis"]),
    )
    fig.update_xaxes(showgrid=False, linecolor=T["axis"], tickfont=dict(color=T["muted"]), zeroline=False)
    fig.update_yaxes(gridcolor=T["grid"], gridwidth=1, linecolor=T["axis"], tickfont=dict(color=T["muted"]),
                     zeroline=False)
    return fig


def _add_vrects(fig: go.Figure, spans, **kw) -> go.Figure:
    """Same shapes as calling fig.add_vrect(x0, x1, **kw) for each span, in one layout update.

    add_vrect re-validates every shape already on the figure, so a loop of calls
    is quadratic in the number of spans (seconds for ~100 bear phases). The first
    span goes through add_vrect so plotly resolves rows and axis references; the
    rest copy those shapes with their own x0/x1. Shapes only: no annotation_* kwargs.
    """
    spans = list(spans)
    if not spans:
        return fig
    n0 = len(fig.layout.shapes)
    fig.add_vrect(x0=spans[0][0], x1=spans[0][1], **kw)
    proto = [s.to_plotly_json() for s in fig.layout.shapes[n0:]]
    extra = tuple({**p, "x0": a, "x1": b} for a, b in spans[1:] for p in proto)
    if extra:
        fig.layout.shapes = fig.layout.shapes + extra
    return fig


def price_overview(R: dict, prices: pd.DataFrame, earnings: pd.DataFrame | None = None, dark: bool = False,
                   regimes: pd.DataFrame | None = None, log: bool = True) -> go.Figure:
    """Price with swing pivots and earnings marks; drawdown from all-time high below."""
    T = theme(dark)
    c = prices["close"].dropna()
    fig = make_subplots(rows=2, cols=1, shared_xaxes=True, row_heights=[0.7, 0.3], vertical_spacing=0.04)
    fig.add_trace(go.Scatter(x=c.index, y=c, name=R["ticker"], line=dict(color=T["s"][0], width=2),
                             hovertemplate="%{y:,.2f}<extra></extra>"), 1, 1)
    piv = R.get("pivots")
    if piv is not None and len(piv):
        for kind, sym, col in (("peak", "triangle-down", T["s"][7]), ("trough", "triangle-up", T["s"][5])):
            p = piv[(piv["kind"] == kind) & piv["confirmed"]]
            fig.add_trace(go.Scatter(x=p["date"], y=p["price"], mode="markers", name=f"swing {kind}",
                                     marker=dict(symbol=sym, size=10, color=col, line=dict(color=T["surface"], width=2)),
                                     hovertemplate=f"{kind} %{{x|%Y-%m-%d}} %{{y:,.2f}}<extra></extra>"), 1, 1)
    if earnings is not None and len(earnings):
        d = pd.to_datetime(earnings["date"])
        d = d[(d >= c.index[0]) & (d <= c.index[-1])]
        y = c.reindex(d, method="ffill")
        fig.add_trace(go.Scatter(x=d, y=y, mode="markers", name="earnings",
                                 marker=dict(symbol="diamond", size=8, color=T["s"][3], line=dict(color=T["surface"], width=2)),
                                 hovertemplate="earnings %{x|%Y-%m-%d}<extra></extra>"), 1, 1)
    if regimes is not None and "trend" in regimes:
        bear = (regimes["trend"] == "bear").reindex(c.index).fillna(False).astype(bool)
        starts = c.index[bear & ~bear.shift(1, fill_value=False)]
        ends = c.index[bear & ~bear.shift(-1, fill_value=False)]
        _add_vrects(fig, zip(starts, ends), fillcolor=T["neutral"], opacity=0.6, line_width=0, layer="below")
    dd = c / c.cummax() - 1.0
    fig.add_trace(go.Scatter(x=dd.index, y=dd, name="drawdown from high", fill="tozeroy",
                             line=dict(color=T["s"][7], width=1), fillcolor="rgba(227,73,72,0.25)",
                             hovertemplate="%{y:.1%}<extra></extra>"), 2, 1)
    _base(fig, T, f"{R['ticker']}: price, swings (±{R['threshold']:.0%}), earnings, market bear phases shaded", 560)
    fig.update_yaxes(type="log" if log else "linear", row=1, col=1)
    fig.update_yaxes(tickformat=".0%", row=2, col=1)
    return fig


def episodes_scatter(ep: pd.DataFrame, dark: bool = False, title: str = "Downturns: depth vs time to recover") -> go.Figure:
    T = theme(dark)
    fig = go.Figure()
    if ep is None or ep.empty:
        return _base(fig, T, title)
    done = ep[~ep["ongoing"]]
    fig.add_trace(go.Scatter(x=done["depth"], y=done["total_bars"], mode="markers", name="recovered",
                             marker=dict(size=10, color=T["s"][0], line=dict(color=T["surface"], width=2)),
                             customdata=np.stack([done["peak_date"].astype(str), done["decline_bars"], done["recovery_bars"]], 1),
                             hovertemplate="peak %{customdata[0]}<br>depth %{x:.1%}<br>decline %{customdata[1]} bars"
                                           "<br>recovery %{customdata[2]} bars<extra></extra>"))
    on = ep[ep["ongoing"]]
    if len(on):
        fig.add_trace(go.Scatter(x=on["depth"], y=on["decline_bars"], mode="markers", name="ongoing (bars so far)",
                                 marker=dict(size=12, color=T["s"][1], symbol="circle-open", line=dict(width=2)),
                                 hovertemplate="ongoing since %{text}<br>depth %{x:.1%}<extra></extra>",
                                 text=on["peak_date"].astype(str)))
    _base(fig, T, title, 380)
    fig.update_xaxes(tickformat=".0%", title="depth")
    fig.update_yaxes(title="bars from peak to full recovery")
    fig.update_layout(hovermode="closest")
    return fig


def annual_declines(annual: pd.DataFrame, dark: bool = False) -> go.Figure:
    """Calendar-year return vs largest intra-year decline (two bars per year, one axis)."""
    T = theme(dark)
    a = annual.dropna(subset=["max_intra_year_decline"])
    fig = go.Figure()
    fig.add_trace(go.Bar(x=a["year"], y=a["return"], name="calendar-year return", marker_color=T["s"][0],
                         hovertemplate="%{x}: %{y:.1%}<extra></extra>"))
    fig.add_trace(go.Bar(x=a["year"], y=a["max_intra_year_decline"], name="largest intra-year decline",
                         marker_color=T["s"][7], hovertemplate="%{x}: %{y:.1%}<extra></extra>"))
    _base(fig, T, "Each year: return vs largest decline inside the year", 380)
    fig.update_layout(barmode="group", bargap=0.25, bargroupgap=0.08)
    fig.update_yaxes(tickformat=".0%")
    return fig


def season_heatmap(table: pd.DataFrame, dark: bool = False, title: str = "Monthly returns by year") -> go.Figure:
    T = theme(dark)
    z = table.to_numpy(dtype=float)
    lim = np.nanpercentile(np.abs(z), 95) if np.isfinite(z).any() else 0.1
    scale = [[0, RED_RAMP[4]], [0.25, RED_RAMP[2]], [0.5, T["neutral"]], [0.75, BLUE_RAMP[2]], [1, BLUE_RAMP[5]]]
    fig = go.Figure(go.Heatmap(z=z, x=list(table.columns), y=[str(i) for i in table.index], colorscale=scale,
                               zmin=-lim, zmax=lim, xgap=2, ygap=2, colorbar=dict(tickformat=".0%", thickness=10),
                               hovertemplate="%{y} %{x}: %{z:.1%}<extra></extra>"))
    _base(fig, T, title, max(320, 22 * len(table) + 80))
    fig.update_yaxes(autorange="reversed", showgrid=False)
    fig.update_layout(hovermode="closest")
    return fig


def season_hit_rates(stats: pd.DataFrame, dark: bool = False, title: str = "Share of years each month was positive") -> go.Figure:
    T = theme(dark)
    fig = go.Figure(go.Bar(
        x=stats["period"], y=stats["hit_rate"], marker_color=T["s"][0],
        error_y=dict(type="data", symmetric=False, array=stats["ci_high"] - stats["hit_rate"],
                     arrayminus=stats["hit_rate"] - stats["ci_low"], color=T["muted"], thickness=1.5),
        customdata=np.stack([stats["n"], stats["median"]], 1),
        hovertemplate="%{x}: %{y:.0%} of %{customdata[0]} years<br>median %{customdata[1]:.1%}<extra></extra>"))
    fig.add_hline(y=0.5, line=dict(color=T["axis"], width=1, dash="dot"))
    _base(fig, T, title + " (95% interval)", 340)
    fig.update_yaxes(tickformat=".0%", range=[0, 1])
    fig.update_layout(hovermode="closest")
    return fig


def season_path(path: pd.DataFrame, dark: bool = False) -> go.Figure:
    T = theme(dark)
    p = path[path["n_years"] >= path["n_years"].max() * 0.5]
    cur = [c for c in path.columns if c.isdigit()]
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=p.index, y=p["p75"], line=dict(width=0), showlegend=False, hoverinfo="skip"))
    fig.add_trace(go.Scatter(x=p.index, y=p["p25"], fill="tonexty", fillcolor="rgba(42,120,214,0.15)",
                             line=dict(width=0), name="middle 50% of years", hoverinfo="skip"))
    fig.add_trace(go.Scatter(x=p.index, y=p["median"], name="median year", line=dict(color=T["s"][0], width=2),
                             hovertemplate="day %{x}: %{y:.1%}<extra></extra>"))
    if cur:
        fig.add_trace(go.Scatter(x=path.index, y=path[cur[0]], name=cur[0], line=dict(color=T["s"][1], width=2),
                                 hovertemplate="day %{x}: %{y:.1%}<extra></extra>"))
    _base(fig, T, "Typical path through the year (trading day of year)", 360)
    fig.update_yaxes(tickformat=".0%")
    return fig


def earnings_path(path: pd.DataFrame, dark: bool = False) -> go.Figure:
    T = theme(dark)
    fig = go.Figure()
    if path is None or path.empty:
        return _base(fig, T, "Earnings path")
    q = path.quantile([0.25, 0.5, 0.75], axis=1).T
    fig.add_trace(go.Scatter(x=q.index, y=q[0.75], line=dict(width=0), showlegend=False, hoverinfo="skip"))
    fig.add_trace(go.Scatter(x=q.index, y=q[0.25], fill="tonexty", fillcolor="rgba(42,120,214,0.15)",
                             line=dict(width=0), name="middle 50% of reports", hoverinfo="skip"))
    fig.add_trace(go.Scatter(x=q.index, y=q[0.5], name="median report", line=dict(color=T["s"][0], width=2),
                             hovertemplate="bar %{x}: %{y:.1%}<extra></extra>"))
    last = path.columns[-1]
    fig.add_trace(go.Scatter(x=path.index, y=path[last], name=f"latest ({pd.Timestamp(last).date()})",
                             line=dict(color=T["s"][1], width=2), hovertemplate="bar %{x}: %{y:.1%}<extra></extra>"))
    fig.add_vline(x=0, line=dict(color=T["axis"], width=1, dash="dot"))
    _base(fig, T, "Price path around earnings (0 = reaction day, relative to the last close before)", 380)
    fig.update_yaxes(tickformat=".0%")
    fig.update_xaxes(title="trading days from reaction day")
    return fig


def earnings_scatter(tab: pd.DataFrame, dark: bool = False) -> go.Figure:
    """Run-up into the report vs reaction, by result."""
    T = theme(dark)
    fig = go.Figure()
    groups = [("beat", T["s"][0]), ("inline", T["s"][2]), ("miss", T["s"][1])]
    has_result = "result" in tab and tab["result"].notna().any()
    for name, col in (groups if has_result else [("all", T["s"][0])]):
        g = tab[tab["result"] == name] if has_result else tab
        if g.empty:
            continue
        fig.add_trace(go.Scatter(x=g["pre_20"], y=g["day0"], mode="markers", name=name,
                                 marker=dict(size=10, color=col, line=dict(color=T["surface"], width=2)),
                                 text=g["report_date"].astype(str),
                                 hovertemplate="%{text}<br>20d into report %{x:.1%}<br>reaction %{y:.1%}<extra></extra>"))
    fig.add_hline(y=0, line=dict(color=T["axis"], width=1))
    fig.add_vline(x=0, line=dict(color=T["axis"], width=1))
    _base(fig, T, "Run-up into report vs reaction day", 380)
    fig.update_xaxes(tickformat=".0%", title="20 trading days into the report")
    fig.update_yaxes(tickformat=".0%", title="reaction day")
    fig.update_layout(hovermode="closest")
    return fig


def valuation_bands(bands: pd.DataFrame, pivots: pd.DataFrame | None, metric: str, summary: dict | None = None,
                    dark: bool = False) -> go.Figure:
    T = theme(dark)
    b = bands.dropna(subset=["value"])
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=b.index, y=b["q90"], line=dict(width=0), showlegend=False, hoverinfo="skip"))
    fig.add_trace(go.Scatter(x=b.index, y=b["q10"], fill="tonexty", fillcolor="rgba(42,120,214,0.10)",
                             line=dict(width=0), name="10th to 90th pct (to date)", hoverinfo="skip"))
    fig.add_trace(go.Scatter(x=b.index, y=b["q50"], name="median to date", line=dict(color=T["muted"], width=1, dash="dot"),
                             hovertemplate="median %{y:.1f}<extra></extra>"))
    fig.add_trace(go.Scatter(x=b.index, y=b["value"], name=metric.upper(), line=dict(color=T["s"][0], width=2),
                             customdata=b["pctile"], hovertemplate="%{y:.1f} (pctile %{customdata:.0%})<extra></extra>"))
    if pivots is not None and len(pivots):
        for kind, sym, col in (("peak", "triangle-down", T["s"][7]), ("trough", "triangle-up", T["s"][5])):
            p = pivots[pivots["kind"] == kind]
            fig.add_trace(go.Scatter(x=p["date"], y=p["multiple"], mode="markers", name=f"at price {kind}s",
                                     marker=dict(symbol=sym, size=10, color=col, line=dict(color=T["surface"], width=2)),
                                     hovertemplate=f"price {kind} %{{x|%Y-%m-%d}}: %{{y:.1f}}<extra></extra>"))
    if summary:
        for c in summary.get("ceilings", [])[:2]:
            fig.add_hline(y=c["level"], line=dict(color=T["s"][7], width=1, dash="dash"), annotation_position="top left",
                          annotation_text=f"peaks clustered here: {c['hits']}", annotation_font_color=T["ink2"])
        for f in summary.get("floors", [])[:2]:
            fig.add_hline(y=f["level"], line=dict(color=T["s"][5], width=1, dash="dash"), annotation_position="bottom right",
                          annotation_text=f"troughs clustered here: {f['hits']}", annotation_font_color=T["ink2"])
    _base(fig, T, f"{metric.upper()} vs its own history (bands use only data available on each date)", 420)
    return fig


def leg_distribution(sizes: pd.Series, current: float | None, direction: str, dark: bool = False) -> go.Figure:
    T = theme(dark)
    s = pd.Series(sizes).dropna()
    fig = go.Figure(go.Histogram(x=s, nbinsx=min(20, max(5, len(s))), marker_color=T["s"][0 if direction == "up" else 7],
                                 marker_line=dict(color=T["surface"], width=2),
                                 hovertemplate="%{x:.0%}: %{y} swings<extra></extra>", name="completed"))
    if current is not None and np.isfinite(current):
        fig.add_vline(x=abs(current), line=dict(color=T["ink"], width=2),
                      annotation_text=f"now {abs(current):.0%}", annotation_font_color=T["ink"])
    _base(fig, T, f"Completed {'rallies' if direction == 'up' else 'declines'}: total size", 320)
    fig.update_xaxes(tickformat=".0%")
    fig.update_layout(hovermode="closest", bargap=0.05, showlegend=False)
    return fig


def attribution_bars(att: pd.DataFrame, dark: bool = False) -> go.Figure:
    T = theme(dark)
    parts = [c for c in ("market", "sector_vs_market", "industry_vs_sector", "company_specific") if c in att]
    names = {"market": "market", "sector_vs_market": "sector vs market", "industry_vs_sector": "industry vs sector",
             "company_specific": "company specific"}
    slot = {"market": 1, "sector_vs_market": 2, "industry_vs_sector": 3, "company_specific": 0}
    fig = go.Figure()
    for p in parts:
        fig.add_trace(go.Bar(x=[f"{w} bars" for w in att.index], y=att[p], name=names[p], marker_color=T["s"][slot[p]],
                             hovertemplate=f"{names[p]}: %{{y:.1%}}<extra></extra>"))
    fig.add_trace(go.Scatter(x=[f"{w} bars" for w in att.index], y=att["total"], mode="markers", name="total",
                             marker=dict(size=12, color=T["ink"], symbol="line-ew-open", line=dict(width=3)),
                             hovertemplate="total %{y:.1%}<extra></extra>"))
    _base(fig, T, "Where the move came from (log returns, parts add to total)", 360)
    fig.update_layout(barmode="relative")
    fig.update_yaxes(tickformat=".0%")
    return fig


def analog_fan(an: pd.DataFrame, close: pd.Series, horizon: int = 126, dark: bool = False) -> go.Figure:
    T = theme(dark)
    fig = go.Figure()
    c = close.dropna()
    for i, d in enumerate(pd.to_datetime(an["date"]) if an is not None and len(an) else []):
        k = c.index.get_loc(d)
        seg = c.iloc[k: k + horizon + 1] / c.iloc[k] - 1.0
        fig.add_trace(go.Scatter(x=np.arange(len(seg)), y=seg, mode="lines", line=dict(color=T["s"][0], width=1),
                                 opacity=0.35, name="analog" if i == 0 else None, showlegend=i == 0,
                                 hovertemplate=f"{d.date()} day %{{x}}: %{{y:.1%}}<extra></extra>"))
    if an is not None and len(an):
        M = np.full((len(an), horizon + 1), np.nan)
        for i, d in enumerate(pd.to_datetime(an["date"])):
            k = c.index.get_loc(d)
            seg = (c.iloc[k: k + horizon + 1] / c.iloc[k] - 1.0).to_numpy()
            M[i, : len(seg)] = seg
        fig.add_trace(go.Scatter(x=np.arange(horizon + 1), y=np.nanmedian(M, 0), name="median analog",
                                 line=dict(color=T["s"][1], width=3), hovertemplate="day %{x}: %{y:.1%}<extra></extra>"))
    fig.add_hline(y=0, line=dict(color=T["axis"], width=1))
    _base(fig, T, "What happened next in the most similar past situations", 380)
    fig.update_yaxes(tickformat=".0%")
    fig.update_xaxes(title="trading days after the analog date")
    return fig

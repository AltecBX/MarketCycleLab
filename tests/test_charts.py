import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots

from mcl.report import charts

KW = dict(fillcolor="#f0efec", opacity=0.6, line_width=0, layer="below")


def _spans(n):
    starts = pd.bdate_range("2010-01-04", periods=n, freq="30B")
    return [(a, a + pd.Timedelta(days=10)) for a in starts]


def _figure(rows, fill_second):
    if rows == 1:
        fig = go.Figure()
        fig.add_trace(go.Scatter(x=[pd.Timestamp("2010-01-04")], y=[1.0]))
        return fig
    fig = make_subplots(rows=2, cols=1, shared_xaxes=True)
    fig.add_trace(go.Scatter(x=[pd.Timestamp("2010-01-04")], y=[1.0]), 1, 1)
    if fill_second:
        fig.add_trace(go.Scatter(x=[pd.Timestamp("2010-01-04")], y=[2.0]), 2, 1)
    fig.add_hline(y=1.0)  # an existing shape that must stay first
    return fig


def test_add_vrects_matches_add_vrect_loop():
    for rows, fill_second in ((1, False), (2, False), (2, True)):
        for n in (0, 1, 7):
            a, b = _figure(rows, fill_second), _figure(rows, fill_second)
            for x0, x1 in _spans(n):
                a.add_vrect(x0=x0, x1=x1, **KW)
            charts._add_vrects(b, _spans(n), **KW)
            assert a.to_json() == b.to_json(), (rows, fill_second, n)

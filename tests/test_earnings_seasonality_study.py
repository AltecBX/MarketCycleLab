import numpy as np
import pandas as pd

from mcl import study
from mcl.analytics import earnings, seasonality
from mcl.data import demo
from mcl.report import html


def test_reaction_index_timing():
    idx = pd.bdate_range("2024-01-01", periods=20)  # 2024-01-05 is Friday
    assert idx[earnings.reaction_index(idx, "2024-01-03", "bmo")] == pd.Timestamp("2024-01-03")
    assert idx[earnings.reaction_index(idx, "2024-01-03", "amc")] == pd.Timestamp("2024-01-04")
    assert idx[earnings.reaction_index(idx, "2024-01-05", "amc")] == pd.Timestamp("2024-01-08")
    assert idx[earnings.reaction_index(idx, "2024-01-06", "unknown")] == pd.Timestamp("2024-01-08")


def test_classify_timing():
    assert earnings.classify_timing("2024-05-01 07:00") == "bmo"
    assert earnings.classify_timing("2024-05-01 16:05") == "amc"
    assert earnings.classify_timing("2024-05-01 12:00") == "dmh"
    assert earnings.classify_timing(pd.Timestamp("2024-05-01 20:30", tz="UTC")) == "amc"
    assert earnings.classify_timing("2024-05-01") == "unknown"


def test_event_study_windows():
    idx = pd.bdate_range("2024-01-01", periods=120)
    c = pd.Series(100.0, index=idx)
    c.iloc[60:] = 90.0          # reaction day = bar 60: -10%
    c.iloc[70:] = 101.0         # recovers above the pre-report close 10 bars later
    o = c.shift(1).fillna(100.0)
    o.iloc[60] = 92.0
    px = pd.DataFrame({"open": o, "close": c})
    ev = pd.DataFrame({"date": [idx[59]], "timing": ["amc"], "eps_actual": [1.0], "eps_estimate": [1.1]})
    tab, path = earnings.event_study(px, ev)
    r = tab.iloc[0]
    assert r["t0"] == idx[60]
    assert np.isclose(r["day0"], -0.10) and np.isclose(r["gap"], -0.08)
    assert r["recovered_bars"] == 10 and bool(r["recovered_within_20"])
    assert r["result"] == "miss"
    assert np.isclose(path.loc[0].iloc[0], -0.10)


def test_seasonality_known_pattern_and_walk_forward():
    idx = pd.bdate_range("2005-01-03", "2024-12-31")
    r = pd.Series(0.0, index=idx)
    jan_first = idx.to_series().groupby([idx.year, idx.month]).transform("min") == idx.to_series()
    r[jan_first & (idx.month == 1)] = 0.05
    r[jan_first & (idx.month == 9)] = -0.03
    c = 100 * (1 + r).cumprod()
    st = seasonality.seasonal_stats(c).set_index("period")
    assert st.loc["Jan", "hit_rate"] == 1.0 and st.loc["Sep", "hit_rate"] == 0.0
    calls, s = seasonality.seasonal_walk_forward(c, min_years=5, conviction=0.65)
    assert s["n_up_calls"] > 0 and s["n_down_calls"] > 0
    # first return is Feb 2005, so a January call needs Jan 2006..2010 first
    assert calls.loc[calls["period"] == 1, "year"].min() == 2011
    assert calls["year"].min() == 2010
    assert s["accuracy"] == 1.0


def test_earnings_season_labels():
    lab = seasonality.earnings_season_label(pd.DatetimeIndex(["2024-03-20", "2024-04-05", "2024-04-20", "2024-06-01"]))
    assert lab.tolist() == ["pre_season", "pre_season", "peak_season", "off_season"]


def test_full_study_on_demo_bundle(tmp_path):
    b = demo.bundle(seed=3, years=9)
    R = study.run(b, 0.10)
    for key in ("episodes", "declines", "annual", "season_stats", "earn_table", "val_bands", "rallies", "selloffs",
                "bounces", "pullbacks", "attribution_now", "snapshot", "analogs"):
        assert key in R, key
    assert R["snapshot"]["phase"]
    p = html.build(b, R, tmp_path / "r.html")
    assert p.stat().st_size > 100_000

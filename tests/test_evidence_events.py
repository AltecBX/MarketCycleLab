import numpy as np
import pandas as pd

from mcl.analytics import events, evidence
from conftest import piecewise


def test_wilson_known_value():
    lo, hi = evidence.wilson_ci(5, 10)
    assert np.isclose(lo, 0.2366, atol=1e-4) and np.isclose(hi, 0.7634, atol=1e-4)
    assert evidence.wilson_ci(0, 0) != evidence.wilson_ci(0, 1)


def test_decluster_and_n_eff():
    d = pd.DataFrame({"date": pd.date_range("2020-01-01", periods=24, freq="MS"), "hit": [True] * 24})
    assert len(evidence.decluster(d, "date", 365)) == 2
    s = evidence.outcome_summary(d, "hit", horizon_days=365)
    assert s["n"] == 24 and s["n_eff"] == 2


def test_grade_rules():
    assert evidence.evidence_grade({"n": 8}) == "Insufficient"
    assert evidence.evidence_grade({"n": 40, "ci_low": 0.7, "ci_high": 0.9, "base_rate": 0.5}, oos=True) == "A"
    assert evidence.evidence_grade({"n": 25, "ci_low": 0.6, "ci_high": 0.9, "base_rate": 0.5}) == "B"
    assert evidence.evidence_grade({"n": 25, "ci_low": 0.4, "ci_high": 0.7, "base_rate": 0.5}) == "C"
    # overlapping samples: n is large but n_eff is not
    assert evidence.evidence_grade({"n": 500, "n_eff": 6, "ci_low": 0.7, "ci_high": 0.9, "base_rate": 0.5}) == "Insufficient"


def test_walk_forward_uses_train_cutoffs_only():
    dates = pd.date_range("2000-01-01", periods=100, freq="MS")
    feat = np.r_[np.arange(60), np.arange(1000, 1040)]  # test values all above any train value
    df = pd.DataFrame({"date": dates, "f": feat, "hit": np.r_[np.zeros(60), np.ones(40)].astype(bool)})
    wf = evidence.walk_forward(df, "f", "hit", split="2005-01-01")
    oos = wf[wf["period"] == "out_of_sample"].set_index("bucket")
    assert oos.loc["f:high", "n"] == 40
    assert oos.loc["f:low", "n"] == 0


def test_conditional_table_base_rate_and_failures():
    df = pd.DataFrame({"date": pd.date_range("2020-01-01", periods=6), "b": list("aaabbb"),
                       "hit": [True, True, False, False, False, True], "r": [0.1, 0.2, -0.1, -0.2, -0.1, 0.3]})
    t = evidence.conditional_table(df, "b", "hit", "r").set_index("bucket")
    assert t.loc["a", "hits"] == 2 and t.loc["a", "fails"] == 1
    assert np.isclose(t.loc["ALL", "base_rate"], 0.5)
    assert np.isclose(t.loc["a", "lift"], (2 / 3) / 0.5)


def test_first_passage_order_and_mae():
    c = pd.Series([100, 98, 95, 101, 111, 90], index=pd.bdate_range("2021-01-01", periods=6), dtype=float)
    r = events.first_passage(c, 0, up=0.10, down=0.08, horizon=5)
    assert r["outcome"] == "up" and r["bars_to_outcome"] == 4
    assert np.isclose(r["mae"], -0.05)
    r2 = events.first_passage(c, 0, up=0.20, down=0.04, horizon=5)
    assert r2["outcome"] == "down" and r2["bars_to_outcome"] == 2


def test_rally_checkpoint_one_event_per_leg():
    c = piecewise([100, 80, 100, 95, 125, 100, 140, 90], steps=20)
    df = pd.DataFrame({"close": c, "volume": 1e6})
    ev = events.rally_checkpoints(df, threshold=0.10, checkpoints=(0.15,), horizon=60)
    assert ev.groupby("rally_start").size().max() == 1
    assert (ev["gain_at_event"] >= 0.15).all()


def test_bounce_outcomes():
    # crash 40%, bounce 12%, retrace past half -> sustained; then crash and bounce, then new low -> failed
    c = piecewise([100, 60, 67.2, 85, 100, 105, 63, 71, 55, 50], steps=15)
    df = pd.DataFrame({"close": c, "volume": 1e6})
    ev = events.bounce_events(df, decline=0.20, bounce=0.10, horizon=200)
    assert ev["outcome"].tolist()[:1] == ["sustained"]
    assert "failed" in ev["outcome"].tolist()

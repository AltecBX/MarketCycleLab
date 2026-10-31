import numpy as np
import pandas as pd

from mcl.analytics import drawdowns, swings


def test_zigzag_pivots_and_confirmation(known_path):
    piv = swings.zigzag(known_path, 0.10)
    assert piv["price"].tolist() == [100, 120, 96, 110, 88, 130, 117, 140]
    assert piv["kind"].tolist() == ["trough", "peak"] * 4
    assert piv["confirmed"].tolist() == [True] * 7 + [False]
    # every confirmation comes after its pivot, never before
    c = piv[piv["confirmed"]]
    assert (c["confirm_date"] > c["date"]).all()
    # the 120 peak is confirmed on the first close at or below 108
    p = c[c["price"] == 120].iloc[0]
    assert known_path.loc[p["confirm_date"]] <= 108 + 1e-9
    prev = known_path.loc[: p["confirm_date"]].iloc[:-1]
    assert (prev.loc[p["date"]:] > 108).all()


def test_underwater_episodes(known_path):
    ep = drawdowns.underwater_episodes(known_path, 0.05)
    assert len(ep) == 2
    a, b = ep.iloc[0], ep.iloc[1]
    assert a["peak_price"] == 120 and a["trough_price"] == 88
    assert np.isclose(a["depth"], 88 / 120 - 1)
    assert not a["ongoing"] and known_path.loc[a["recovery_date"]] >= 120
    assert b["peak_price"] == 130 and b["trough_price"] == 117


def test_swing_declines_tag_repeat_legs(known_path):
    d = drawdowns.swing_declines(known_path, 0.10)
    assert d["start_price"].tolist() == [120, 110, 130]
    assert d["from_high"].tolist() == [True, False, True]
    assert d["episode_no"].tolist() == [0, 0, 1]
    assert d["leg_in_episode"].tolist() == [1, 2, 1]


def test_swing_state_is_causal_and_consistent(known_path):
    st = swings.swing_state(known_path, 0.10)
    piv = swings.zigzag(known_path, 0.10)
    for r in piv[piv["confirmed"]].itertuples():
        # on the confirmation bar the state switches to the new leg anchored at the pivot
        assert st.loc[r.confirm_date, "pivot_price"] == r.price
        assert st.loc[r.confirm_date, "direction"] == (1 if r.kind == "trough" else -1)


def test_remaining_move_odds():
    sizes = pd.Series([0.12, 0.2, 0.3, 0.45, 0.6])
    o = swings.remaining_move_odds(sizes, 0.25, extras=(0.10, 0.30))
    assert o["n_reached"] == 3
    assert np.isclose(o["p_extra_10"], 2 / 3)
    assert np.isclose(o["p_extra_30"], 1 / 3)


def test_calendar_year_drawdowns():
    idx = pd.bdate_range("2020-12-30", "2021-12-31")
    c = pd.Series(100.0, index=idx)
    c.loc["2021-03-01":"2021-03-31"] = 85.0
    c.loc["2021-04-01":] = 110.0
    y = drawdowns.calendar_year_drawdowns(c)
    row = y[y["year"] == 2021].iloc[0]
    assert np.isclose(row["max_intra_year_decline"], -0.15)
    assert np.isclose(row["return"], 0.10)


def test_annual_counts_threshold_semantics(known_path):
    a = drawdowns.annual_selloff_counts(known_path, (0.10, 0.25))
    assert a["n_10pct"].sum() == 3
    assert a["n_25pct"].sum() == 1  # only 120 -> 88 as one leg once 10%+ bounces are not counted


def _episode_no_reference(d, ep, n):
    """The original row-by-row lookup: first episode whose span contains the leg."""
    out = []
    for s_i, e_i in zip(d["start_i"], d["end_i"]):
        k = np.nan
        for j, row in enumerate(ep.itertuples(index=False)):
            end = row.recovery_i if row.recovery_i >= 0 else n
            if row.peak_i <= s_i and e_i <= end:
                k = j
                break
        out.append(k)
    return out


def test_swing_declines_episode_lookup_matches_reference(random_ohlcv):
    c = random_ohlcv["close"]
    for min_depth in (0.0, 0.05, 0.15, 0.99):  # deeper filters leave legs outside every listed episode
        ep = drawdowns.underwater_episodes(c, min_depth)
        for th in (0.03, 0.05, 0.10):
            d = drawdowns.swing_declines(c, th, episodes=ep)
            ref = pd.Series(_episode_no_reference(d, ep, len(c)), dtype=d["episode_no"].dtype)
            pd.testing.assert_series_equal(d["episode_no"], ref, check_names=False)

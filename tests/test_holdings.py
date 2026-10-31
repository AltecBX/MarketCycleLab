"""Holdings monitor: input parsing, giveback and recovery math, option payoffs and tax flags, offline end to end."""
import math

import numpy as np
import pandas as pd
import pytest

from mcl import holdings, options
from mcl.analytics import streaks

POSITION_CSV = """\
,AAA,BBB,CCC,DDD,Total,Contract Fees,Week #
Current Price,$69.05,$344.63,"$1,150.89",$4.90,,,
Price Paid,$126.70,$277.00,"$1,750.00",,,,
Quantity,300,400,100,0,"$996,662.05",,
Cost,"$38,010.00","$110,800.00","$175,000.00",$0.00,,,
Option Profit,"$10,731.00","$4,228.00","-$140.00",$500.00,,,
1/2/26,$0.00,$0.00,$0.00,$0.00,,Week 1,
"""


def test_read_position_layout(tmp_path):
    p = tmp_path / "position.csv"
    p.write_text(POSITION_CSV)
    h = holdings.read_holdings(p).set_index("ticker")
    assert list(h.index) == ["AAA", "BBB", "CCC"]                      # DDD has 0 shares; columns after Total ignored
    assert h.loc["AAA", "shares"] == 300 and h.loc["AAA", "cost"] == 126.70
    assert h.loc["CCC", "cost"] == 1750.0 and h.loc["CCC", "option_income"] == -140.0
    assert h.loc["BBB", "option_income"] == 4228.0


def test_read_simple_csv(tmp_path):
    p = tmp_path / "holdings.csv"
    p.write_text("ticker,shares,cost,acquired,willing_to_sell\naapl,400,277,2023-05-01,0.5\nsndk,100,1750,,\n")
    h = holdings.read_holdings(p).set_index("ticker")
    assert h.loc["AAPL", "shares"] == 400 and h.loc["AAPL", "willing_to_sell"] == 0.5
    assert pd.Timestamp(h.loc["AAPL", "acquired"]) == pd.Timestamp("2023-05-01") and pd.isna(h.loc["SNDK", "acquired"])


@pytest.mark.parametrize("raw,want", [("$1,234.50", 1234.5), ("-$1,320.00", -1320.0), ("12.5%", 12.5), ("", None),
                                      ("#VALUE!", None), ("(250)", -250.0), ("300", 300.0)])
def test_parse_number(raw, want):
    v = holdings.parse_number(raw)
    assert (np.isnan(v) if want is None else v == want)


def test_giveback_math():
    # HYPOTHETICAL EXAMPLE from SYSTEM_PLAN.md: basis 100, high 150, now 135
    close = pd.Series([100, 120, 150, 140, 135.0], index=pd.bdate_range("2026-01-05", periods=5))
    g = holdings.giveback(close, cost=100, budget=0.25, window=63)
    assert g["applies"] and math.isclose(g["given_back_share"], 0.30)
    assert math.isclose(g["floor_price"], 137.5) and g["budget_used_up"]
    assert math.isclose(g["stock_from_peak_pct"], -0.10)
    assert not holdings.giveback(close, cost=160)["applies"]           # never above cost in the window


def test_recovery_counts_completed_episodes():
    # two completed drawdowns (−40%, −20%), then a current one at −30%
    path = [100, 80, 60, 80, 100, 110, 100, 88, 100, 120, 100, 90, 84]
    close = pd.Series(path, index=pd.bdate_range("2020-01-01", periods=len(path)), dtype=float)
    r = holdings.recovery(close, cost=120, effective_cost=110)
    assert math.isclose(r["from_high_pct"], 84 / 120 - 1)
    ep = r["episodes"]
    assert ep["n_reached"] == 1                                          # only the −40% episode reached −30%
    assert ep["median_sessions_to_new_high"] == 2                        # first ≤ −30% at index 2, new high at 4
    assert math.isclose(r["rally_to_cost_pct"], 120 / 84 - 1)


def test_lowest_qualified_benchmark_branches():
    strikes = [170, 180, 185, 190, 195, 200, 205]
    # (i): highest strike below the prior close
    assert options.lowest_qualified_benchmark(strikes, 200.0, 60, 190) == 195
    q = options.qualified_covered_call(strikes, 200.0, 60, 190)
    assert q["deep_itm"] and not q["qualified"]
    q = options.qualified_covered_call(strikes, 200.0, 60, 195)
    assert q["qualified"] and "holding period" in q["notes"][0]
    # (ii): more than 90 days and strike over $50: second highest strike below
    assert options.lowest_qualified_benchmark(strikes, 200.0, 120, 190) == 190
    # (iii): price $25 or less, not below 85% of the price
    assert options.lowest_qualified_benchmark([10, 15], 20.0, 60, 15) == pytest.approx(17.0)
    # (iv): price $150 or less, not below the price minus $10
    assert options.lowest_qualified_benchmark([100, 105], 120.0, 60, 105) == 110
    # 30 days or less is never qualified
    assert not options.qualified_covered_call(strikes, 200.0, 30, 205)["qualified"]


def chain_fixture(S=100.0):
    k = np.arange(70, 135, 5.0)
    calls = pd.DataFrame({"strike": k, "bid": np.maximum(S - k, 0) + 1.0, "ask": np.maximum(S - k, 0) + 1.4,
                          "lastPrice": np.maximum(S - k, 0) + 1.2, "impliedVolatility": 0.35})
    puts = pd.DataFrame({"strike": k, "bid": np.maximum(k - S, 0) + 0.8, "ask": np.maximum(k - S, 0) + 1.2,
                         "lastPrice": np.maximum(k - S, 0) + 1.0, "impliedVolatility": 0.38})
    return calls, puts


def test_covered_call_payoff_and_effective_sale_price():
    calls, puts = chain_fixture()
    st = options.strategies(100.0, 100.0, 200, calls, puts, days=45)
    cc = st[(st["strategy"] == "covered call") & (st["label"] == "call 10% OTM") & (st["coverage"] == 1.0)].iloc[0]
    assert cc["strike"] == 110 and cc["contracts"] == 2 and math.isclose(cc["premium_per_share"], 1.2)
    assert math.isclose(cc["sale_price_if_assigned"], 111.2) and math.isclose(cc["time_value"], 1.2)
    itm = st[(st["label"] == "call 10% ITM") & (st["coverage"] == 1.0)].iloc[0]
    assert itm["strike"] == 90 and math.isclose(itm["intrinsic"], 10) and math.isclose(itm["time_value"], 1.2)
    assert not itm["qualified_covered_call"]                                      # deep in the money
    pay = options.payoff_at_expiry(100.0, 200, st).set_index("move")
    col = "call 10% OTM @ 100%"
    assert math.isclose(pay.loc[0.3, col], 200 * 30 - 200 * (130 - 110 - 1.2))     # capped: (110 + 1.2 − 100) x 200
    assert math.isclose(pay.loc[0.3, col], 200 * (110 + 1.2 - 100))
    assert math.isclose(pay.loc[-0.3, col], 200 * -30 + 200 * 1.2)
    put = pay.loc[-0.3, "put 10% OTM @ 100%"]
    assert math.isclose(put, 200 * -30 + 200 * (90 - 70) - 200 * 1.0)                 # floor at 90 minus premium


def test_delta_pick_is_closest_to_target():
    calls, puts = chain_fixture()
    st = options.strategies(100.0, 100.0, 200, calls, puts, days=45)
    row = st[(st["label"] == "call 0.20 delta") & (st["coverage"] == 1.0)].iloc[0]
    T = 45 / 365
    otm = [k for k in calls["strike"] if k > 100]
    want = min(otm, key=lambda k: abs(options.bs_delta(100.0, k, T, 0.35) - 0.20))
    assert row["strike"] == want and abs(row["delta"] - 0.20) < 0.06


def test_black_scholes_put_call_parity():
    S, K, T, v = 100.0, 105.0, 0.25, 0.4
    c, p = options.bs_price(S, K, T, v, "call"), options.bs_price(S, K, T, v, "put")
    assert math.isclose(c - p, S - K * math.exp(-options.RATE * T), rel_tol=1e-9)


def test_pick_expirations_around_earnings():
    exps = ["2026-11-06", "2026-11-13", "2026-11-20", "2026-12-18", "2027-01-15"]
    got = options.pick_expirations(exps, pd.Timestamp("2026-10-30"), pd.Timestamp("2026-11-17"))
    assert got == ["2026-11-13", "2026-12-18"]                      # after the report: more than 30 days out
    assert options.pick_expirations(exps, pd.Timestamp("2026-10-30"), None) == ["2026-12-18", "2027-01-15"]


def test_streak_baseline_and_counts():
    rng = np.random.default_rng(7)
    close = pd.Series(100 * np.exp(np.cumsum(rng.normal(0.0003, 0.015, 2500))), index=pd.bdate_range("2014-01-02", periods=2500))
    s = streaks.streak_stats(close, 20)
    assert s["streak"] >= 1 and s["side"] in ("above", "below")
    h = s["h5"]
    assert 0 <= h["base_pct_drop_gt_typical"] <= 100 and h["base_n"] > 500


def test_run_offline(monkeypatch, tmp_path):
    from mcl.data import loader
    idx = pd.bdate_range("2023-01-02", periods=800)
    rng = np.random.default_rng(1)

    def fake_prices(t):
        c = 100 * np.exp(np.cumsum(rng.normal(0.0005, 0.02, len(idx))))
        return pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "volume": 1e6}, index=idx)

    monkeypatch.setattr(loader, "get_prices", fake_prices)
    monkeypatch.setattr(holdings, "load_market_data", lambda tks: {
        t: {"prices": fake_prices(t), "notes": [],
            "earnings": pd.DataFrame({"date": pd.date_range("2023-02-01", periods=12, freq="91D"), "timing": "amc",
                                      "kind": "report"})} for t in tks})
    p = tmp_path / "position.csv"
    p.write_text(POSITION_CSV)
    text = holdings.run(position_csv=p)
    assert "# Holdings monitor" in text and "## Portfolio" in text
    for t in ("AAA", "BBB", "CCC"):
        assert f"### {t}" in text
    assert "Giveback" in text or "Recovery" in text
    assert "Past reactions" in text


def test_stress_replay_leaves_out_late_listings():
    idx = pd.bdate_range("2023-01-02", periods=600)
    a = pd.Series(np.linspace(100, 160, 600), index=idx)
    b = pd.Series(np.r_[np.full(400, np.nan), np.linspace(50, 40, 200)], index=idx)
    closes = pd.DataFrame({"AAA": a, "NEW": b})
    cards = [{"ticker": t, "shares": 100, "price": float(closes[t].iloc[-1]), "value": 100 * float(closes[t].iloc[-1]),
              "cost": 1.0, "unrealized": 0.0, "option_income": 0.0, "earnings": {}} for t in ("AAA", "NEW")]
    s = holdings.portfolio(cards, closes, None, None, lookback=504)["stress"]
    assert s["excluded"] == ["NEW"] and s["names"] == 1 and s["start"] == idx[-504]
    assert math.isclose(s["excluded_share"], 4000 / (16000 + 4000))
    s = holdings.portfolio(cards, closes[["NEW"]], None, None, lookback=504)["stress"]
    assert s["excluded"] == [] and s["start"] == idx[400]          # every name is new: replay what exists


@pytest.mark.parametrize("now,want", [("2026-10-31 12:00", "2026-11-02"),    # Saturday: next Monday
                                      ("2026-10-30 10:00", "2026-10-30"),    # Friday morning: same day
                                      ("2026-10-30 16:30", "2026-11-02"),    # Friday after the close: Monday
                                      ("2026-11-02 09:00", "2026-11-02")])
def test_grant_date(now, want):
    assert options.grant_date(pd.Timestamp(now, tz="America/New_York")) == pd.Timestamp(want)


def test_option_panel_counts_days_from_grant(monkeypatch):
    calls, puts = chain_fixture()
    monkeypatch.setattr(options, "expirations", lambda t: ["2026-12-04", "2026-12-18"])
    monkeypatch.setattr(options, "chain", lambda t, e: (calls, puts))
    idx = pd.bdate_range("2026-01-02", "2026-10-30")
    close = pd.Series(100.0, index=idx)
    card = {"price": 100.0, "shares": 200, "as_of": idx[-1], "earnings": {"next_date": None}}
    text = holdings.option_panel("XYZ", card, close, grant=pd.Timestamp("2026-11-02"))
    assert "2026-12-04 (32 days)" in text                     # from Monday 11/2, not Friday 10/30 (35)
    assert "| hold | call 0.20 delta |" in text and "@ 100%" not in text
    assert "2026-10-30 close $100.00" in text


def test_card_for_a_gain_that_turned_into_a_loss():
    idx = pd.bdate_range("2024-01-02", periods=600)
    path = np.r_[np.linspace(100, 90, 500), np.linspace(90, 130, 60), np.linspace(130, 80, 40)]
    prices = pd.DataFrame({"close": path, "open": path, "high": path, "low": path, "volume": 1.0}, index=idx)
    past = list(pd.date_range("2024-02-01", periods=9, freq="63D"))
    earn = pd.DataFrame({"date": past + [idx[-1] + pd.Timedelta(days=3)],
                         "timing": ["amc"] * 9 + ["dmh"], "kind": "report"})
    h = pd.Series({"ticker": "XYZ", "shares": 100, "cost": 100.0, "option_income": 0.0})
    c = holdings.position_card(h, prices, earn)
    text = holdings.render_card(c)
    assert "the whole peak gain" in text and "BUDGET USED UP" in text and "below it" in text
    assert "* Recovery:" in text                                   # below cost: the recovery view shows too
    assert "budget already used up" in text
    assert "(time not confirmed)" in text                          # a future 'dmh' is Yahoo's placeholder


def test_nonstandard_contracts_are_left_out():
    # live case: NFLX after its 10 for 1 split listed a 2450 strike next to 55 to 80 strikes, stock at $62.08
    calls = pd.DataFrame({"contractSymbol": ["NFLX270115C00066000", "NFLX270115C00080000", "NFLX1270115C02450000"],
                          "strike": [66.0, 80.0, 2450.0], "bid": [2.6, 1.3, 6.5], "ask": [2.8, 1.5, 7.0],
                          "lastPrice": [2.7, 1.4, 6.8], "impliedVolatility": [0.45, 0.45, 4.4]})
    assert options.standard_contracts(calls, "NFLX")["strike"].tolist() == [66.0, 80.0]
    weird = pd.DataFrame({"contractSymbol": ["X1C1"], "strike": [10.0]})
    assert len(options.standard_contracts(weird, "XYZ")) == 1                 # nothing matches: keep all
    # even if such a row gets through, the 0.20 delta pick ignores it
    row = options.delta_pick(calls, 62.08, 77 / 365, 0.20)
    assert row["strike"] == 80.0


def test_incomplete_strike_list_makes_itm_flag_uncertain():
    # live SMH 2026-12-04 strikes from Yahoo near the money; stock 522.49
    smh = [500.0, 525.0, 530.0, 532.5, 535.0, 540.0, 545.0, 550.0, 560.0, 567.5, 570.0, 572.5, 575.0]
    q = options.qualified_covered_call(smh, 522.49, 35, 510.0)
    assert q["qualified"] is None and "Confirm the listed strikes" in " ".join(q["notes"])
    assert options.qualified_covered_call(smh, 522.49, 35, 550.0)["qualified"] is True      # out of the money: unaffected
    assert options.qualified_covered_call(smh, 522.49, 35, 430.0)["qualified"] is False     # deep in any case
    # live SMH 2027-01-15: $5 spacing through the range, nothing uncertain
    full = [float(k) for k in range(480, 605, 5)]
    assert options.strike_gap(full, 522.49)[0] is False
    assert options.qualified_covered_call(full, 522.49, 77, 520.0)["qualified"] is True
    # AAPL 11/20 (2.50 spacing, price 344.63) and MU 12/18 (10 spacing, price 884.74): complete
    assert options.strike_gap([320 + 2.5 * i for i in range(17)], 344.63)[0] is False
    assert options.strike_gap([840.0, 850, 860, 870, 880, 890, 900], 884.74)[0] is False


def test_recovery_line_when_option_income_covers_the_loss():
    idx = pd.bdate_range("2024-01-02", periods=300)
    path = np.r_[np.linspace(800, 1200, 200), np.linspace(1200, 884.74, 100)]
    prices = pd.DataFrame({"close": path, "open": path, "high": path, "low": path, "volume": 1.0}, index=idx)
    h = pd.Series({"ticker": "MU", "shares": 100, "cost": 980.0, "option_income": 30279.0})
    text = holdings.render_card(holdings.position_card(h, prices, None))
    assert "rally needed to cost +10.8%" in text
    assert "price already 30.6% above the cost after option income ($677.21)" in text

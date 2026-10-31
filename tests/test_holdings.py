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
    col = "call 10% OTM x1"
    assert math.isclose(pay.loc[0.3, col], 200 * 30 - 200 * (130 - 110 - 1.2))     # capped: (110 + 1.2 − 100) x 200
    assert math.isclose(pay.loc[0.3, col], 200 * (110 + 1.2 - 100))
    assert math.isclose(pay.loc[-0.3, col], 200 * -30 + 200 * 1.2)
    put = pay.loc[-0.3, "put 10% OTM x1"]
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
    assert got == ["2026-11-13", "2026-11-20"]
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

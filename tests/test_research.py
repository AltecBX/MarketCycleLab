"""Research website data: known answers on synthetic data, fully offline."""
import json
import math

import numpy as np
import pandas as pd
import pytest

from mcl import research
from mcl.data import sec


@pytest.fixture(autouse=True)
def no_sec_fetch(monkeypatch):
    """No test may reach SEC: the company list fetch fails unless a test supplies its own."""
    def boom():
        raise RuntimeError("offline")
    monkeypatch.setattr(research, "fetch_sec_tickers", boom)


def closes(start, end, fn):
    """Business day closes; fn(Timestamp, position) gives each close."""
    idx = pd.bdate_range(start, end)
    return pd.Series([float(fn(d, i)) for i, d in enumerate(idx)], index=idx)


def frame(close):
    return pd.DataFrame({"close": close})


def strict(path):
    def bad(x):
        raise ValueError(f"non-finite number {x} in {path}")
    return json.loads(path.read_text(), parse_constant=bad)


# ---------------------------------------------------------------- earnings path (6 weeks before, 4 after)
def run_up_then_drop(d, i):
    """100 through day -42 (2026-03-05), up to 120 on 2026-04-15, 110 from the report day 2026-04-16 on."""
    a, b = pd.Timestamp("2026-03-05"), pd.Timestamp("2026-04-15")
    if d <= a:
        return 100.0
    if d <= b:
        return 100.0 + 20.0 * (d - a).days / (b - a).days
    return 110.0


def test_earn_path_known_answer_keeps_one_baseline():
    c = closes("2026-01-02", "2026-06-30", run_up_then_drop)
    p = research.earn_path(c, "2026-04-16")
    assert p["baseline_date"] == "2026-03-05" and p["baseline_close"] == 100.0
    pts = dict(zip(p["days"], p["pct"], strict=True))
    assert p["days"][0] == -42 and pts[-42] == 0.0
    assert math.isclose(pts[-1], 0.20)                       # 120 just before the report
    assert 0 in pts and math.isclose(pts[0], 0.10)           # day 0 is a session and is present
    assert all(math.isclose(pts[k], 0.10) for k in pts if k >= 0)   # 110 after: +10% on the SAME baseline, not -8.3%
    assert p["days"][-1] == 28 and p["last_date"] == "2026-05-14"
    assert p["weeks"][0] == -6.0 and p["weeks"][p["days"].index(-1)] == round(-1 / 7, 3)
    assert p["dates"][p["days"].index(0)] == "2026-04-16"
    assert len(p["days"]) == len(p["pct"]) == len(p["dates"]) == len(p["weeks"])
    # the earnings row agrees: run-up +20%, reaction measured from the 120 close
    r = research.report_prices(c, "2026-04-16", "bmo")
    assert math.isclose(r["pre_6w"], 0.20) and r["run_bucket"] == "large rally"
    assert math.isclose(r["react_1d"], round(110 / 120 - 1, 4)) and r["t0_date"] == "2026-04-16"


def test_earn_path_baseline_carried_from_friday_when_day_minus_42_is_sunday():
    c = closes("2026-01-02", "2026-06-30", lambda d, i: 100 + i)
    p = research.earn_path(c, "2026-04-19")                  # a Sunday report: day -42 is Sunday 2026-03-08
    fri = c.loc["2026-03-06"]
    assert p["baseline_date"] == "2026-03-06" and p["baseline_close"] == fri
    assert p["days"][0] == -41 and p["dates"][0] == "2026-03-09"   # no invented point on the weekend
    assert math.isclose(p["pct"][0], round(c.loc["2026-03-09"] / fri - 1, 4))
    assert 0 not in p["days"] and 1 in p["days"]
    r = research.report_prices(c, "2026-04-19", "bmo")
    assert r["t0_date"] == "2026-04-20"                      # first session that can react


def test_current_cycle_row_ends_at_last_session_and_has_no_future_points():
    c = closes("2026-01-02", "2026-10-30", lambda d, i: 100 + 0.1 * i)
    p = research.earn_path(c, "2026-11-02", current=True)
    assert p["last_date"] == "2026-10-30" and max(p["days"]) == -3 and p["dates"][-1] == "2026-10-30"
    assert all(pd.Timestamp(x) <= c.index[-1] for x in p["dates"])
    # last session before report - 42 days: no current row yet
    assert research.earn_path(c, "2026-12-15", current=True) is None
    r = research.report_prices(c, "2026-12-15", "amc", current=True)
    assert r["pre_6w"] is None and r["pre_2w"] is None and r["react_1d"] is None


def test_current_cycle_in_full_build(tmp_path):
    c = closes("2025-06-02", "2026-10-30", lambda d, i: 100 + 0.1 * i)
    yahoo = pd.DataFrame({"date": pd.to_datetime(["2026-07-30", "2026-11-04"]), "timing": ["amc", "dmh"],
                          "eps_estimate": [1.0, 1.2], "eps_actual": [1.1, np.nan]})
    data = {"AAPL": {"prices": frame(c), "events": yahoo, "eps": yahoo, "fiscal": None, "pe": None,
                     "name": "Apple Inc.", "kind": "stock"}}
    conf = [{"symbol": "AAPL", "report_date": "2026-11-02", "timing": "after the close", "source": "https://x"}]
    research.build_from_frames(data, tmp_path, "2026-10-31", confirmations=conf)
    earn = strict(tmp_path / "research_earnings.json")
    cur = [r for r in earn if r["current"]]
    assert len(cur) == 1 and cur[0]["report_date"] == "2026-11-02" and cur[0]["timing"] == "after the close"
    assert cur[0]["eps_actual"] is None and cur[0]["eps_estimate"] == 1.2       # Yahoo's estimate for that report
    assert cur[0]["react_1d"] is None and cur[0]["t0_date"] is None
    assert math.isclose(cur[0]["pre_1w"], round(c.iloc[-1] / c.loc["2026-10-26"] - 1, 4))   # to the last close
    paths = strict(tmp_path / "research_earn_paths.json")
    cp = [p for p in paths if p["current"]][0]
    assert cp["date_status"] == "confirmed" and cp["last_date"] == "2026-10-30"
    cov = strict(tmp_path / "research_coverage.json")[0]
    assert cov["next_report"] == "2026-11-02" and cov["next_report_status"] == "confirmed"
    assert cov["next_report_timing"] == "after the close"
    # without the confirmation: Yahoo's date, and its placeholder market hours time is not trusted
    research.build_from_frames(data, tmp_path, "2026-10-31", confirmations=[])
    cov = strict(tmp_path / "research_coverage.json")[0]
    assert cov["next_report"] == "2026-11-04" and cov["next_report_status"] == "estimated by Yahoo"
    assert cov["next_report_timing"] == "unknown"


# ---------------------------------------------------------------- reaction timing
def spike(d, i):
    return {"2026-04-15": 120.0, "2026-04-16": 108.0}.get(str(d.date()), 100.0 if d < pd.Timestamp("2026-04-15") else 90.0)


@pytest.mark.parametrize("timing,t0,react_1d,react_1w,pre_1w", [
    ("bmo", "2026-04-16", 108 / 120 - 1, 90 / 120 - 1, 0.20),      # same day; base = the session before
    ("dmh", "2026-04-16", 108 / 120 - 1, 90 / 120 - 1, 0.20),
    ("amc", "2026-04-17", 90 / 108 - 1, 90 / 108 - 1, 0.08),       # next session; base = the report day's close
    ("unknown", None, None, 90 / 120 - 1, 0.20),                    # never guessed: no 1 day reaction
])
def test_reaction_day_follows_timing(timing, t0, react_1d, react_1w, pre_1w):
    c = closes("2026-01-02", "2026-06-30", spike)
    r = research.report_prices(c, "2026-04-16", timing)
    assert r["t0_date"] == t0
    assert (r["react_1d"] is None) if react_1d is None else math.isclose(r["react_1d"], round(react_1d, 4))
    assert math.isclose(r["react_1w"], round(react_1w, 4)) and math.isclose(r["pre_1w"], round(pre_1w, 4))


def test_unknown_timing_week_and_month_count_from_the_session_before():
    c = closes("2026-01-02", "2026-06-30", lambda d, i: 100 + i)
    base = c.index.get_loc(pd.Timestamp("2026-04-15"))
    r = research.report_prices(c, "2026-04-16", "unknown")
    assert r["react_1d"] is None and r["t0_date"] is None
    assert math.isclose(r["react_1w"], round(c.iloc[base + 5] / c.iloc[base] - 1, 4))
    assert math.isclose(r["react_1m"], round(c.iloc[base + 21] / c.iloc[base] - 1, 4))


def test_run_days_and_reactions_missing_until_they_exist():
    c = closes("2026-01-02", "2026-04-20", spike)                     # ends two sessions after the report
    r = research.report_prices(c, "2026-04-16", "bmo")
    assert r["run_high_days"] == 0 and r["run_low_days"] == 1         # high on the base day, last 100 the day before
    assert r["react_1d"] is not None and r["react_1w"] is None and r["react_1m"] is None


# ---------------------------------------------------------------- EPS, fiscal labels, P/E
def test_eps_match_surprise_beat_and_beat_fell(tmp_path):
    c = closes("2025-01-02", "2026-06-30", spike)
    ev = pd.DataFrame({"date": pd.to_datetime(["2025-10-20", "2026-04-16"]), "timing": ["bmo", "bmo"]})
    y = pd.DataFrame({"date": pd.to_datetime(["2025-10-24", "2026-04-14"]), "eps_estimate": [2.0, -0.5],
                      "eps_actual": [2.2, -0.4]})
    data = {"XYZ": {"prices": frame(c), "events": ev, "eps": y, "fiscal": None, "pe": None, "name": "X", "kind": "stock"}}
    research.build_from_frames(data, tmp_path, "2026-06-30", confirmations=[])
    rows = {r["report_date"]: r for r in strict(tmp_path / "research_earnings.json")}
    far, near = rows["2025-10-20"], rows["2026-04-16"]
    assert far["eps_actual"] is None and far["beat"] is None and far["eps_source"] is None   # 4 days away: no match
    assert near["eps_actual"] == -0.4 and math.isclose(near["surprise_pct"], 0.2)          # (-0.4 - -0.5) / 0.5
    assert near["beat"] is True and near["react_1d"] < 0 and near["beat_fell"] is True
    assert near["fiscal_label"] == "CY2026 Q1 (calendar)" and near["fiscal_q"] == 1
    summ = {r["run_bucket"]: r for r in strict(tmp_path / "research_earn_summary.json")}
    assert summ["all"]["n"] == 2 and summ["all"]["beats"] == 1 and summ["all"]["beat_fell"] == 1
    assert summ["all"]["n_with_eps"] == 1 and summ["large rally"]["n"] == 1


def test_fiscal_labels_sec_window_projection_and_calendar():
    fiscal = pd.DataFrame({"period_end": pd.to_datetime(["2025-09-27", "2025-12-27", "2026-03-28", "2026-06-27"]),
                           "fiscal_year": [2025, 2026, 2026, 2026], "fiscal_q": [4, 1, 2, 3]})
    got = research.fiscal_labels(["2026-01-29", "2026-07-30", "2026-11-02", "2025-06-01"], fiscal)
    assert got[0] == ("FY2026 Q1", 2026, 1) and got[1] == ("FY2026 Q3", 2026, 3)
    assert got[2] == ("FY2026 Q4", 2026, 4)       # 10-K not filed yet: the next quarter of the fiscal calendar
    assert got[3] == (None, None, None)           # nothing within 120 days before: left null, not guessed
    assert research.fiscal_labels(["2026-04-20", "2026-01-28"], None) == [
        ("CY2026 Q1 (calendar)", 2026, 1), ("CY2025 Q4 (calendar)", 2025, 4)]
    # a quarter missing from SEC between two known ones is filled only when the labels line up
    gap = fiscal.drop(index=2)
    assert research.fiscal_labels(["2026-04-30"], gap)[0] == ("FY2026 Q2", 2026, 2)


def fact(start, end, val, filed, form, fy, fp, accn):
    return {"start": start, "end": end, "val": val, "filed": filed, "form": form, "fy": fy, "fp": fp, "accn": accn}


def aapl_fy2020_eps():
    # AAPL FY2020 diluted EPS as filed; the 4 for 1 split (2020-08-31) came between the 9 month 10-Q and the 10-K
    return {"facts": {"us-gaap": {"EarningsPerShareDiluted": {"units": {"USD/shares": [
        fact("2019-09-29", "2019-12-28", 4.99, "2020-01-29", "10-Q", 2020, "Q1", "q1"),
        fact("2018-09-30", "2018-12-29", 4.18, "2020-01-29", "10-Q", 2020, "Q1", "q1"),
        fact("2019-12-29", "2020-03-28", 2.55, "2020-05-01", "10-Q", 2020, "Q2", "q2"),
        fact("2020-03-29", "2020-06-27", 2.58, "2020-07-31", "10-Q", 2020, "Q3", "q3"),
        fact("2019-09-29", "2020-06-27", 10.12, "2020-07-31", "10-Q", 2020, "Q3", "q3"),
        fact("2019-09-29", "2020-09-26", 3.28, "2020-10-30", "10-K", 2020, "FY", "k"),
        fact("2018-09-30", "2019-09-28", 2.97, "2020-10-30", "10-K", 2020, "FY", "k"),
    ]}}}}}


def test_eps_ttm_split_adjusts_each_fact_by_its_filing_date():
    splits = pd.Series([4.0], index=pd.to_datetime(["2020-08-31"]))
    t = research.eps_ttm(aapl_fy2020_eps(), splits)
    assert len(t) == 1 and t["period_end"].iloc[0] == pd.Timestamp("2020-09-26")
    assert math.isclose(t["ttm_eps"].iloc[0], 3.28)                # equals the FY figure on today's basis
    assert t["filed"].iloc[0] == pd.Timestamp("2020-10-30")
    q = sec.discrete_quarters(sec._facts(aapl_fy2020_eps(), "EarningsPerShareDiluted", ("USD/shares",)))
    assert q.set_index("period_end").loc["2020-09-26", "val"] < 0    # without the adjustment Q4 would be negative


def test_fiscal_periods_from_company_facts():
    f = research.fiscal_periods(aapl_fy2020_eps())
    got = {str(r.period_end.date()): (r.fiscal_year, r.fiscal_q) for r in f.itertuples()}
    assert got == {"2019-12-28": (2020, 1), "2020-03-28": (2020, 2), "2020-06-27": (2020, 3), "2020-09-26": (2020, 4)}


def test_pe_uses_only_filings_before_the_report():
    pe = pd.DataFrame({"period_end": pd.to_datetime(["2026-03-31", "2026-06-30", "2026-09-30"]),
                       "filed": pd.to_datetime(["2026-05-01", "2026-08-01", "2026-11-01"]),
                       "ttm_eps": [4.0, 5.0, -1.0]})
    assert research.pe_at(pe, "2026-08-01", 100.0) == 25.0         # filed that day: not yet known
    assert research.pe_at(pe, "2026-08-02", 100.0) == 20.0
    assert research.pe_at(pe, "2026-11-05", 100.0) is None         # TTM EPS <= 0
    assert research.pe_at(pe, "2026-04-01", 100.0) is None         # nothing filed yet
    assert research.pe_at(pe, "2026-11-05", 100.0, today="2026-10-31") == 20.0   # never a filing after as of


# ---------------------------------------------------------------- moving average streaks
def blocks(spec, base=10_000.0, start="2020-01-01"):
    """Strictly rising or falling blocks; a 100 point jump opens each block, so against the 5 session average
    every session is on its block's side (checked by the test)."""
    vals, v = [], base
    for k, (direction, length) in enumerate(spec):
        for j in range(length):
            v += direction * (100.0 if j == 0 and k else 1.0)
            vals.append(v)
    return pd.Series(vals, index=pd.bdate_range(start, periods=len(vals)))


SPEC = [(1, 30), (-1, 3), (1, 5), (-1, 4), (1, 7), (-1, 2), (1, 40)]


def test_block_series_sides_are_as_designed():
    c = blocks(SPEC)
    side = np.where(c > c.rolling(5).mean(), 1, -1)[4:]
    want = np.concatenate([np.full(n, s) for s, n in SPEC])[4:]
    assert (side == want).all()


def test_ma_streak_stats_exclude_first_and_current_runs():
    stats, _ = research.ma_rows("XYZ", blocks(SPEC), mas=(5,))
    s = stats[0]
    assert s["side"] == "above" and s["streak"] == 40
    assert s["completed_same_side"] == 2                           # 5 and 7: not the first (26) nor the current (40)
    assert s["max_len"] == 7 and s["median_len"] == 6.0 and s["p75_len"] == 6.5
    assert s["share_reaching_today"] == 0.0 and s["first_run_excluded"] is True
    assert s["max_len_end"] == str(blocks(SPEC).index[30 + 3 + 5 + 4 + 7 - 1].date())


def test_ma_conditional_rows_count_each_streak_once():
    _, cond = research.ma_rows("XYZ", blocks(SPEC), mas=(5,))
    up = {r["length"]: r for r in cond if r["side"] == "above"}
    assert sorted(up) == list(range(1, 8))                        # up to the longest completed streak, n > 0 only
    assert [up[L]["n"] for L in range(1, 8)] == [2, 2, 2, 2, 2, 1, 1]
    assert up[1]["ended_within_5"] == 0.5 and up[3]["ended_within_5"] == 1.0
    assert up[1]["median_ret_5"] is None                           # fewer than 5 streaks
    down = {r["length"]: r["n"] for r in cond if r["side"] == "below"}
    assert down == {1: 3, 2: 3, 3: 2, 4: 1}


def test_ma_conditional_forward_returns_from_the_session_reaching_length():
    spec = [(1, 12)] + [(-1, 3), (1, 6)] * 6 + [(-1, 3), (1, 20)]
    c = blocks(spec)
    _, cond = research.ma_rows("XYZ", c, mas=(5,))
    row = [r for r in cond if r["side"] == "above" and r["length"] == 2][0]
    starts = np.cumsum([0] + [n for _, n in spec])[:-1]
    ups = [s for (d, n), s in zip(spec, starts, strict=True) if d > 0][1:-1]      # completed, not first, not current
    v = c.to_numpy()
    want = np.median([v[s + 1 + 5] / v[s + 1] - 1 for s in ups])
    assert row["n"] == 6 and math.isclose(row["median_ret_5"], round(want, 4))
    side = np.where(c > c.rolling(5).mean(), 1, -1)
    base = [v[i + 10] / v[i] - 1 for i in range(4, len(v) - 10) if side[i] == 1]
    assert math.isclose(row["base_median_ret_10"], round(float(np.median(base)), 4))


# ---------------------------------------------------------------- drawdowns
def test_drawdown_one_episode_per_peak_ongoing_and_censored():
    v = [100, 95, 88, 92, 85, 95, 80, 99, 101, 105, 90, 94, 92]
    c = pd.Series(v, index=pd.bdate_range("2024-01-01", periods=len(v)), dtype=float)
    e10 = research.drawdown_episodes(c, 0.10)
    assert len(e10) == 2                                             # several lower lows, one episode per peak
    a, b = e10
    assert a["peak_close"] == 100 and a["censored"] is True and a["trough_date"] == str(c.index[6].date())
    assert a["depth"] == -0.2 and a["status"] == "completed" and a["recovered_date"] == str(c.index[8].date())
    assert a["sessions_to_trough"] == 6 and a["sessions_to_recover"] == 8
    assert b["peak_close"] == 105 and b["status"] == "ongoing" and b["recovered_date"] is None
    assert b["sessions_to_recover"] is None and b["censored"] is False
    assert len(research.drawdown_episodes(c, 0.20)) == 1 and research.drawdown_episodes(c, 0.30) == []


def test_recovered_within_250_denominator():
    knots = {0: 100, 10: 110, 20: 95, 30: 111, 100: 120, 110: 100, 400: 121, 450: 130, 460: 110, 500: 115}
    x = np.arange(501)
    c = pd.Series(np.interp(x, list(knots), list(knots.values())), index=pd.bdate_range("2020-01-01", periods=501))
    eps, summ = research.drawdown_rows("XYZ", c, thresholds=(0.10,))
    assert [e["status"] for e in eps] == ["completed", "completed", "ongoing"]
    assert [e["sessions_to_recover"] for e in eps[:2]] == [20, 287]
    s = summ[0]
    assert s["episodes"] == 3 and s["completed"] == 2 and s["ongoing"] == 1 and s["censored"] == 0
    assert s["recovered_within_250_of"] == 2                        # the peak 50 sessions ago could not have
    assert s["recovered_within_250"] == 1 and s["median_sessions_to_recover"] == 153.5


def test_dd_years_complete_flags():
    c = closes("2023-03-01", "2026-10-14", lambda d, i: 100 + np.sin(i / 20) * 10 + i * 0.01)
    rows = {r["year"]: r for r in research.dd_year_rows("XYZ", c, "2026-10-14")}
    assert rows[2023]["complete"] is False and rows[2026]["complete"] is False
    assert rows[2024]["complete"] is True and rows[2025]["complete"] is True
    dd = c / c.cummax() - 1
    assert math.isclose(rows[2024]["worst_from_high"], round(dd[dd.index.year == 2024].min(), 4))
    full = closes("2024-01-02", "2025-12-31", lambda d, i: 100.0)
    rows = {r["year"]: r for r in research.dd_year_rows("XYZ", full, "2026-01-02")}
    assert rows[2024]["complete"] is True and rows[2025]["complete"] is True


# ---------------------------------------------------------------- seasonality and strategy
def monthly_levels(d, i):
    if d >= pd.Timestamp("2026-10-01"):
        return 50.0                                               # a crash inside the unfinished month
    m = (d.year - 2024) * 12 + d.month
    return 100 * 1.01 ** m


def test_seasonality_excludes_the_incomplete_current_month():
    c = closes("2024-12-02", "2026-10-14", monthly_levels)
    rows = {(r["period_type"], r["period"]): r for r in research.seasonality_rows("XYZ", c, "2026-10-14")}
    octo = rows[("month", 10)]
    assert octo["n"] == 1 and math.isclose(octo["median_ret"], 0.01) and math.isclose(octo["worst"], 0.01)
    assert octo["current_complete"] is False and math.isclose(octo["current_ret"], round(50 / c.loc["2026-09-30"] - 1, 4))
    assert rows[("month", 12)]["n"] == 1                           # Dec 2024 has no previous month
    assert rows[("month", 9)]["current_ret"] is None and rows[("month", 9)]["n"] == 2
    q4 = rows[("quarter", 4)]
    assert q4["current_complete"] is False and q4["n"] == 1        # Q4 2025 only; Q4 2024 has no previous quarter
    # the last session is the month's last session: the month counts
    c2 = closes("2024-12-02", "2026-10-30", monthly_levels)
    octo2 = {(r["period_type"], r["period"]): r for r in research.seasonality_rows("XYZ", c2, "2026-10-31")}[("month", 10)]
    assert octo2["n"] == 2 and octo2["current_complete"] is True


def test_strategy_signal_on_the_last_day_causes_no_trade():
    v = list(np.linspace(100, 200, 260)) + [50.0]                 # far below the 200 day average on the last day
    c = pd.Series(v, index=pd.bdate_range("2020-01-01", periods=len(v)))
    rows = {r["rule"]: r for r in research.strategy_rows("XYZ", c)}
    w = 199
    assert rows["buy and hold"]["start"] == str(c.index[w].date())
    for rule in ("buy and hold", "above 200 day average"):
        r = rows[rule]
        assert r["trades"] == 1                                    # bought at the close after the first signal only
        assert math.isclose(r["total_return"], round(v[-1] / v[w + 1] * (1 - 0.001) - 1, 4))
    assert rows["above 200 day average"]["cost_per_trade"] == 0.001


def test_strategy_sells_at_the_close_after_the_signal():
    v = list(np.linspace(100, 200, 260)) + [150.0, 120.0] + [120.0] * 20
    c = pd.Series(v, index=pd.bdate_range("2020-01-01", periods=len(v)))
    r = {x["rule"]: x for x in research.strategy_rows("XYZ", c)}["above 200 day average"]
    t = 260                                                        # first close below the average
    assert r["trades"] == 2
    assert math.isclose(r["total_return"], round(v[t + 1] / v[200] * (1 - 0.001) ** 2 - 1, 4))   # t+1 move is taken
    held = (t + 1) - 200                                           # return periods held: closes 200 .. t+1
    assert math.isclose(r["pct_time_invested"], round(held / (len(v) - 1 - 199), 4))


# ---------------------------------------------------------------- universe, events, prices, CLI
FAKE_SEC = {"0": {"cik_str": 789019, "ticker": "MSFT", "title": "MICROSOFT CORP"},
            "1": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
            "2": {"cik_str": 1067983, "ticker": "BRK-B", "title": "BERKSHIRE HATHAWAY INC"},
            "3": {"cik_str": 789019, "ticker": "MSFT", "title": "MICROSOFT CORP"},
            "4": {"cik_str": 19617, "ticker": "JPM", "title": "JPMORGAN CHASE & CO"},
            "5": {"cik_str": 732717, "ticker": "T", "title": "AT&T INC."},
            "6": {"cik_str": 1450923, "ticker": "SLV", "title": "ISHARES SILVER TRUST"}}


def small_data():
    c = closes("2024-01-02", "2026-10-30", lambda d, i: 100 + 10 * np.sin(i / 30) + 0.05 * i)
    return {"MSFT": {"prices": frame(c), "events": None, "eps": None, "fiscal": None, "pe": None,
                     "name": "Microsoft Corporation", "kind": "stock"},
            "SLV": {"prices": frame(c), "name": "iShares Silver Trust", "kind": "etf"},
            "SPY": {"prices": frame(c), "name": "SPDR S&P 500 ETF Trust", "kind": "etf"}}


def test_universe_from_fake_sec_json(monkeypatch, tmp_path):
    monkeypatch.setattr(research, "fetch_sec_tickers", lambda: FAKE_SEC)
    research.build_from_frames(small_data(), tmp_path, "2026-10-31", confirmations=[])
    rows = strict(tmp_path / "research_universe.json")
    assert [r["symbol"] for r in rows] == ["MSFT", "AAPL", "BRK-B", "JPM", "T", "SLV", "SPY"]
    assert [r["rank"] for r in rows] == [0, 1, 2, 4, 5, 6, None]   # position in SEC's file; duplicate dropped
    u = {r["symbol"]: r for r in rows}
    assert u["MSFT"]["name"] == "Microsoft Corporation" and u["MSFT"]["covered"] is True   # Yahoo long name
    assert u["AAPL"]["name"] == "Apple Inc." and u["AAPL"]["covered"] is False
    assert u["BRK-B"]["name"] == "Berkshire Hathaway Inc" and u["JPM"]["name"] == "Jpmorgan Chase & Co"
    assert u["T"]["name"] == "AT&T Inc." and u["SLV"]["kind"] == "etf" and u["SPY"]["kind"] == "etf"
    meta = strict(tmp_path / "research_meta.json")[0]
    assert meta["sec_list_fetched"] is True and meta["universe_size"] == 7 and meta["covered"] == 3


def test_universe_without_sec_list_has_covered_symbols_only(tmp_path):
    research.build_from_frames(small_data(), tmp_path, "2026-10-31", confirmations=[])
    rows = strict(tmp_path / "research_universe.json")
    assert {r["symbol"] for r in rows} == {"MSFT", "SLV", "SPY"} and all(r["covered"] for r in rows)
    meta = strict(tmp_path / "research_meta.json")[0]
    assert meta["sec_list_fetched"] is False and any("SEC company list unavailable" in n for n in meta["notes"])


@pytest.mark.parametrize("raw,want", [("MICROSOFT CORP", "Microsoft Corp"), ("3M CO", "3M Co"),
                                      ("U.S. BANCORP \\DE\\", "U.S. Bancorp \\DE\\"), ("HP INC", "HP Inc"),
                                      ("BANK OF AMERICA CORP /DE/", "Bank of America Corp /DE/"),
                                      ("COCA-COLA CO", "Coca-Cola Co"), ("S&P GLOBAL INC.", "S&P Global Inc."),
                                      ("NOVO NORDISK A/S", "Novo Nordisk A/S"), ("Alphabet Inc.", "Alphabet Inc.")])
def test_readable_name(raw, want):
    assert research.readable_name(raw) == want


def test_large_drop_flagged_only_away_from_reports():
    v = [100.0] * 30 + [70.0] * 20 + [50.0] * 20 + [39.0] * 10
    c = pd.Series(v, index=pd.bdate_range("2026-01-05", periods=len(v)))
    rows = research.event_rows("XYZ", c, [str(c.index[29].date())])   # report the day before the first drop
    assert [r["date"] for r in rows] == [str(c.index[50].date())]      # -28.6% flagged; -30% after a report and -22% not
    assert rows[0]["kind"] == "large one day drop" and math.isclose(rows[0]["move"], round(50 / 70 - 1, 4))
    wdc = research.event_rows("WDC", c, [])
    assert any(r["kind"] == "corporate action" and r["date"] == "2025-02-24" for r in wdc)


def test_weekly_prices_and_from_high_uses_daily_highs():
    c = closes("2026-01-05", "2026-01-21", lambda d, i: {2: 120.0}.get(i, 100.0 + i))   # Wed 01-07 spike, Wed end
    rows = research.weekly_prices("XYZ", c)
    assert [r["date"] for r in rows] == ["2026-01-09", "2026-01-16", "2026-01-21"]       # final partial week kept
    assert math.isclose(rows[0]["from_high"], round(104 / 120 - 1, 4))                  # mid-week daily high counts
    assert rows[0]["close"] == 104.0


def test_full_build_files_and_schemas(monkeypatch, tmp_path):
    monkeypatch.setattr(research, "fetch_sec_tickers", lambda: FAKE_SEC)
    c = closes("2015-01-02", "2026-10-30", lambda d, i: 100 * math.exp(0.0003 * i + 0.1 * math.sin(i / 40)))
    rep = pd.date_range("2015-02-03", "2026-08-01", freq="91D")
    ev = pd.DataFrame({"date": list(rep) + [pd.Timestamp("2026-11-03")], "timing": ["amc"] * len(rep) + ["bmo"],
                       "kind": "report"})
    y = ev.assign(eps_estimate=1.0, eps_actual=[1.05] * len(rep) + [np.nan])
    data = {"MSFT": {"prices": frame(c), "events": ev, "eps": y, "fiscal": None, "pe": None,
                     "name": "Microsoft Corporation", "kind": "stock", "notes": ["a loader note"]},
            "SPY": {"prices": frame(c), "events": None, "eps": None, "fiscal": None, "pe": None,
                    "name": "SPDR S&P 500 ETF Trust", "kind": "etf"},
            "BAD": {"prices": pd.DataFrame({"close": []}), "name": "Bad", "kind": "stock"}}
    res = research.build_from_frames(data, tmp_path, "2026-10-31", confirmations=[])
    assert set(res) == set(research.FILES.values())
    schema = {
        "research_universe.json": "symbol name kind rank covered",
        "research_coverage.json": "symbol name kind price_start price_end sessions years_of_prices reports_dated "
                                  "reports_with_prices reports_with_eps timing_known next_report next_report_timing "
                                  "next_report_status fiscal_calendar notes",
        "research_prices.json": "symbol date close from_high",
        "research_earnings.json": "symbol report_date timing timing_source fiscal_label fiscal_year fiscal_q eps_actual "
                                  "eps_estimate surprise_pct eps_source beat t0_date pre_6w pre_2w pre_1w react_1d "
                                  "react_1w react_1m run_bucket run_low_days run_high_days beat_fell pe_ttm_gaap current",
        "research_earn_paths.json": "symbol report_date fiscal_label fiscal_year fiscal_q timing current date_status "
                                    "baseline_date baseline_close days weeks pct dates last_date",
        "research_earn_summary.json": "symbol run_bucket n n_with_reaction median_react_1d pct_up_1d median_react_1w "
                                      "median_react_1m n_with_eps beats beat_fell",
        "research_ma.json": "symbol ma side streak gap pct_time_above completed_same_side median_len p75_len p90_len "
                            "max_len max_len_end share_reaching_today first_run_excluded",
        "research_ma_cond.json": "symbol ma side length n ended_within_5 ended_within_10 median_ret_5 median_ret_10 "
                                 "median_ret_20 p10_ret_10 base_median_ret_10",
        "research_drawdowns.json": "symbol threshold peak_date peak_close trough_date depth recovered_date status "
                                   "sessions_to_trough sessions_to_recover censored",
        "research_dd_summary.json": "symbol threshold episodes completed ongoing censored median_sessions_to_recover "
                                    "recovered_within_250 recovered_within_250_of data_start data_end",
        "research_dd_years.json": "symbol year worst_from_high complete",
        "research_seasonality.json": "symbol period_type period n median_ret mean_ret pct_up best worst current_ret "
                                     "current_complete",
        "research_strategy.json": "symbol rule start end total_return cagr max_drawdown trades pct_time_invested "
                                  "cost_per_trade",
        "research_meta.json": "generated_at as_of covered universe_size price_provider timing_provider eps_provider "
                              "fundamentals_provider universe_provider sec_list_fetched notes",
    }
    for name, fields in schema.items():
        rows = strict(tmp_path / name)
        assert res[name][0] == len(rows) and res[name][1] == (tmp_path / name).stat().st_size < 8_000_000
        assert rows, name
        for r in rows:
            assert list(r) == fields.split(), name
    assert strict(tmp_path / "research_events.json") == []
    meta = strict(tmp_path / "research_meta.json")[0]
    assert meta["covered"] == 2 and any(n.startswith("BAD skipped") for n in meta["notes"])
    cov = {r["symbol"]: r for r in strict(tmp_path / "research_coverage.json")}
    assert cov["MSFT"]["reports_dated"] == len(rep) and cov["MSFT"]["next_report"] == "2026-11-03"
    assert cov["MSFT"]["fiscal_calendar"].startswith("calendar quarters") and "a loader note" in cov["MSFT"]["notes"]
    assert cov["SPY"]["fiscal_calendar"] is None and cov["SPY"]["reports_dated"] == 0
    prices = strict(tmp_path / "research_prices.json")
    assert prices[-1]["date"] == "2026-10-30" and all(r["date"] <= "2026-10-30" for r in prices)


def test_timing_source_from_merged_sec_and_yahoo():
    sec_dates = pd.DataFrame({"date": pd.to_datetime(["2026-01-29", "2026-04-30", "2026-07-30"]),
                              "accepted": ["2026-01-29 16:05:00", "2026-04-30 10:15:00", "2026-07-30 00:00:00"],
                              "timing": ["amc", "dmh", "unknown"]})
    yahoo = pd.DataFrame({"date": pd.to_datetime(["2026-01-29", "2026-04-30", "2026-07-30"]),
                          "timing": ["amc", "bmo", "amc"], "eps_estimate": 1.0, "eps_actual": 1.1})
    past, _ = research.report_list(sec.merge_earnings(sec_dates, yahoo), yahoo, [], "XYZ", pd.Timestamp("2026-10-30"))
    got = [(a, b if isinstance(b, str) else None) for a, b in zip(past["timing"], past["timing_source"], strict=True)]
    assert got == [("amc", "SEC filing time"), ("bmo", "Yahoo"), ("unknown", None)]


def test_research_set_and_cli(monkeypatch, tmp_path, capsys):
    pos = tmp_path / "holdings.csv"
    pos.write_text("Symbol,Price Paid,Quantity\nnvda,100,10\naapl,50,0\nmu,90,5\n")
    wl = tmp_path / "watch.json"
    wl.write_text(json.dumps(["msft", "NVDA", "SPY"]))
    got = research.research_set(["sndk", "MU"], pos, wl)
    assert got == ["SNDK", "MU", "NVDA", "MSFT"] + research.BENCHMARKS + research.SECTOR_FUNDS
    seen = {}

    def fake_build(tks, out, as_of=None, confirmations=None):
        seen["tks"], seen["out"] = tks, out
        return {"research_prices.json": (12, 3456)}

    monkeypatch.setattr(research, "build", fake_build)
    from mcl.__main__ import main
    assert main(["research", "SNDK", "--watchlist", str(wl), "--json", str(tmp_path / "web")]) == 0
    assert seen["tks"][:3] == ["SNDK", "MSFT", "NVDA"] and seen["out"] == tmp_path / "web"
    assert "research_prices.json: 12 rows, 3,456 bytes" in capsys.readouterr().out


def test_known_corporate_action_notes_in_coverage(tmp_path):
    c = closes("2025-02-13", "2026-10-30", lambda d, i: 100 + i * 0.1)
    data = {"SNDK": {"prices": frame(c), "events": None, "eps": None, "name": "Sandisk Corporation", "kind": "stock"}}
    research.build_from_frames(data, tmp_path, "2026-10-31", confirmations=[])
    notes = strict(tmp_path / "research_coverage.json")[0]["notes"]
    assert notes[0] == "Listed 2025-02-13: about 1.7 years of prices"
    assert research.KNOWN_NOTES["SNDK"] in notes


def test_report_before_the_first_price_has_no_reaction_session():
    c = closes("2026-01-05", "2026-06-30", lambda d, i: 100 + i)
    r = research.report_prices(c, "2025-10-20", "bmo")
    assert r["t0_date"] is None and r["react_1d"] is None and r["pre_6w"] is None


def test_yahoo_only_reports_and_bad_confirmation_rows(tmp_path):
    c = closes("2025-06-02", "2026-10-30", lambda d, i: 100 + 0.1 * i)
    y = pd.DataFrame({"date": pd.to_datetime(["2026-07-30"]), "timing": ["amc"], "eps_estimate": [1.0], "eps_actual": [1.1]})
    data = {"XYZ": {"prices": frame(c), "events": None, "eps": y, "name": "X", "kind": "stock"}}
    conf = [{"symbol": "XYZ", "report_date": "not a date"}, {"symbol": "XYZ", "report_date": "2026-11-05", "timing": "bmo"}]
    research.build_from_frames(data, tmp_path, "2026-10-31", confirmations=conf)
    rows = strict(tmp_path / "research_earnings.json")
    assert [r["report_date"] for r in rows] == ["2026-07-30", "2026-11-05"]
    assert rows[0]["eps_actual"] == 1.1 and rows[0]["timing_source"] == "Yahoo"
    assert rows[1]["timing"] == "before the open" and rows[1]["timing_source"] == "confirmed"


def test_build_loads_each_ticker_and_skips_failures(monkeypatch, tmp_path):
    from mcl import config
    from mcl.data import loader, yahoo
    c = closes("2019-06-03", "2021-03-31", lambda d, i: 50 + 0.1 * i)

    def get_prices(t):
        if t == "BAD":
            raise RuntimeError("No Yahoo price data for BAD")
        return frame(c)

    y = pd.DataFrame({"date": pd.to_datetime(["2020-10-29", "2021-01-27"]), "timing": ["amc", "amc"],
                      "eps_estimate": [0.70, 1.41], "eps_actual": [0.73, 1.68]})
    sec_dates = pd.DataFrame({"date": pd.to_datetime(["2020-10-29", "2021-01-27"]), "timing": ["amc", "amc"],
                              "accepted": ["2020-10-29 16:30:00", "2021-01-27 16:30:00"]})
    monkeypatch.setattr(config, "SEC_USER_AGENT", "Test test@example.com")
    monkeypatch.setattr(loader, "get_prices", get_prices)
    monkeypatch.setattr(yahoo, "profile", lambda t: {"longName": f"{t} Corporation", "quoteType": "EQUITY"})
    monkeypatch.setattr(yahoo, "earnings_dates", lambda t: y)
    monkeypatch.setattr(yahoo, "splits", lambda t, px=None: pd.Series([4.0], index=pd.to_datetime(["2020-08-31"])))
    monkeypatch.setattr(sec, "earnings_releases", lambda t: sec_dates)
    monkeypatch.setattr(sec, "company_data", lambda t: (320193, aapl_fy2020_eps()))
    res = research.build(["XYZ", "BAD", "SPY"], tmp_path, "2021-03-31", confirmations=[])
    assert res["research_coverage.json"][0] == 2
    meta = strict(tmp_path / "research_meta.json")[0]
    assert "BAD skipped: No Yahoo price data for BAD" in meta["notes"] and meta["covered"] == 2
    rows = {r["report_date"]: r for r in strict(tmp_path / "research_earnings.json")}
    jan = rows["2021-01-27"]
    assert jan["timing_source"] == "SEC filing time" and jan["fiscal_label"] == "FY2021 Q1"
    assert math.isclose(jan["pe_ttm_gaap"], round(c.loc["2021-01-27"] / 3.28, 2))   # FY2020 EPS, filed 2020-10-30
    assert rows["2020-10-29"]["pe_ttm_gaap"] is None                                 # its 10-K came the next day
    assert rows["2020-10-29"]["fiscal_label"] == "FY2020 Q4"
    cov = {r["symbol"]: r for r in strict(tmp_path / "research_coverage.json")}
    assert cov["XYZ"]["fiscal_calendar"] == "SEC fiscal periods" and cov["SPY"]["kind"] == "etf"

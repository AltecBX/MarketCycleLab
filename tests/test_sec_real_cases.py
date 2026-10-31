"""Known answers from real SEC companyfacts (values in $M, as filed), found by `mcl verify`."""
import json

import pandas as pd

from mcl.analytics import valuation
from mcl.data import sec

M = 1_000_000


def F(start, end, val, filed, form, accn):
    return {"start": start, "end": end, "val": val * M, "filed": filed, "form": form, "accn": accn}


def frame(rows, tag="X"):
    return sec._facts({"facts": {"us-gaap": {tag: {"units": {"USD": rows}}}}}, tag)


def test_msft_same_quarter_tagged_with_two_start_dates():
    # MSFT Q1 FY2017 net income: 4,690 in the Oct 2016 10-Q; restated 5,667 with start 07-01 in Oct 2017,
    # and again with start 07-02 in the Aug 2018 10-K. The first filed value must win.
    rows = [F("2016-07-01", "2016-09-30", 4690, "2016-10-20", "10-Q", "0001193125-16-742796"),
            F("2016-07-01", "2016-09-30", 5667, "2017-10-26", "10-Q", "0001564590-17-020171"),
            F("2016-07-02", "2016-09-30", 5667, "2018-08-03", "10-K", "0001564590-18-019062")]
    first = sec.discrete_quarters(frame(rows)).iloc[0]
    assert first["val"] == 4690 * M and first["filed"] == pd.Timestamp("2016-10-20")
    last = sec.discrete_quarters(frame(rows), keep="last").iloc[0]
    assert last["val"] == 5667 * M and last["filed"] == pd.Timestamp("2018-08-03")


def aapl_fy2009():
    return [
        F("2008-09-28", "2008-12-27", 11880, "2010-01-25", "10-Q", "0001193125-10-012085"),
        F("2008-12-28", "2009-03-28", 9084, "2010-04-21", "10-Q", "0001193125-10-088957"),
        F("2008-09-28", "2009-03-28", 20964, "2010-04-21", "10-Q", "0001193125-10-088957"),
        F("2008-09-28", "2009-06-27", 26667, "2009-07-22", "10-Q", "0001193125-09-153165"),
        F("2009-03-29", "2009-06-27", 8337, "2009-07-22", "10-Q", "0001193125-09-153165"),
        F("2008-09-28", "2009-06-27", 30698, "2010-07-21", "10-Q", "0001193125-10-162840"),
        F("2009-03-29", "2009-06-27", 9734, "2010-07-21", "10-Q", "0001193125-10-162840"),
        F("2008-09-28", "2009-09-26", 36537, "2009-10-27", "10-K", "0001193125-09-214859"),
        F("2008-09-28", "2009-09-26", 42905, "2010-01-25", "10-K/A", "0001193125-10-012091"),
        F("2009-06-28", "2009-09-26", 12207, "2010-10-27", "10-K", "0001193125-10-238044"),
        F("2008-09-28", "2009-09-26", 42905, "2010-10-27", "10-K", "0001193125-10-238044"),
    ]


def test_aapl_q4_fy2009_first_known_value():
    # A reported Q4 first appears in the Oct 2010 10-K; FY minus 9M was public in Oct 2009.
    q = sec.discrete_quarters(frame(aapl_fy2009())).set_index("period_end")
    q4 = q.loc[pd.Timestamp("2009-09-26")]
    assert q4["val"] == (36537 - 26667) * M and q4["filed"] == pd.Timestamp("2009-10-27") and bool(q4["derived"])
    assert q.loc[pd.Timestamp("2009-06-27"), "val"] == 8337 * M
    # latest view: the restated basis, which reconciles to the restated year
    last = sec.discrete_quarters(frame(aapl_fy2009()), keep="last").set_index("period_end")
    assert last["val"].sum() == 42905 * M
    assert last.loc[pd.Timestamp("2009-09-26"), "val"] == 12207 * M


def amzn_fy2012(q):
    return [
        F("2012-01-01", "2012-03-31", q[0], "2012-04-27", "10-Q", "0001193125-12-187203"),
        F("2012-04-01", "2012-06-30", q[1], "2012-07-27", "10-Q", "0001193125-12-317409"),
        F("2012-01-01", "2012-06-30", q[0] + q[1], "2012-07-27", "10-Q", "0001193125-12-317409"),
        F("2012-07-01", "2012-09-30", q[2], "2012-10-26", "10-Q", "0001193125-12-436012"),
        F("2012-01-01", "2012-09-30", q[3], "2012-10-26", "10-Q", "0001193125-12-436012"),
        F("2012-01-01", "2012-12-31", q[4], "2013-01-30", "10-K", "0001193125-13-028520"),
    ]


def test_amzn_fy2012_mis_tagged_quarterly_table_is_ignored():
    rows = amzn_fy2012([13185, 12834, 13806, 39825, 61093])
    rows += [F("2012-01-01", "2012-03-31", 9857, "2013-01-30", "10-K", "0001193125-13-028520"),
             F("2012-04-01", "2012-06-30", 9913, "2013-01-30", "10-K", "0001193125-13-028520"),
             F("2012-07-01", "2012-09-30", 10876, "2013-01-30", "10-K", "0001193125-13-028520"),
             F("2012-10-01", "2012-12-31", 17431, "2013-01-30", "10-K", "0001193125-13-028520"),
             # the FY2013 10-K tags 2012 correctly, and it adds up
             F("2012-01-01", "2012-03-31", 13185, "2014-01-31", "10-K", "0001018724-14-000006"),
             F("2012-04-01", "2012-06-30", 12834, "2014-01-31", "10-K", "0001018724-14-000006"),
             F("2012-07-01", "2012-09-30", 13806, "2014-01-31", "10-K", "0001018724-14-000006"),
             F("2012-10-01", "2012-12-31", 21268, "2014-01-31", "10-K", "0001018724-14-000006"),
             F("2012-01-01", "2012-12-31", 61093, "2014-01-31", "10-K", "0001018724-14-000006")]
    q = sec.discrete_quarters(frame(rows)).set_index("period_end")
    assert q.loc[pd.Timestamp("2012-12-31"), "val"] == 21268 * M                  # not 17,431
    assert q.loc[pd.Timestamp("2012-12-31"), "filed"] == pd.Timestamp("2013-01-30")
    assert q["val"].sum() == 61093 * M


def test_amzn_fy2012_net_income():
    rows = [F("2012-01-01", "2012-03-31", 130, "2012-04-27", "10-Q", "a1"),
            F("2012-04-01", "2012-06-30", 7, "2012-07-27", "10-Q", "a2"),
            F("2012-01-01", "2012-06-30", 137, "2012-07-27", "10-Q", "a2"),
            F("2012-07-01", "2012-09-30", -274, "2012-10-26", "10-Q", "a3"),
            F("2012-01-01", "2012-09-30", -137, "2012-10-26", "10-Q", "a3"),
            F("2012-01-01", "2012-12-31", -39, "2013-01-30", "10-K", "k12"),
            F("2012-01-01", "2012-03-31", 201, "2013-01-30", "10-K", "k12"),
            F("2012-04-01", "2012-06-30", 191, "2013-01-30", "10-K", "k12"),
            F("2012-07-01", "2012-09-30", 63, "2013-01-30", "10-K", "k12"),
            F("2012-10-01", "2012-12-31", 177, "2013-01-30", "10-K", "k12")]
    q = sec.discrete_quarters(frame(rows)).set_index("period_end")
    assert q.loc[pd.Timestamp("2012-12-31"), "val"] == 98 * M                     # -39 - (-137); reported 97
    assert q["val"].sum() == -39 * M


def test_consistent_quarterly_table_is_kept():
    # MSFT FY2016: the 10-K's Q4 net income (3,122) matches FY minus 9M (16,798 - 13,676)
    rows = [F("2015-07-01", "2015-09-30", 4902, "2016-07-28", "10-K", "k16"),
            F("2015-10-01", "2015-12-31", 5018, "2016-07-28", "10-K", "k16"),
            F("2016-01-01", "2016-03-31", 3756, "2016-07-28", "10-K", "k16"),
            F("2016-04-01", "2016-06-30", 3122, "2016-07-28", "10-K", "k16"),
            F("2015-07-01", "2016-06-30", 16798, "2016-07-28", "10-K", "k16")]
    q = sec.discrete_quarters(frame(rows))
    assert q["val"].tolist() == [4902 * M, 5018 * M, 3756 * M, 3122 * M] and not q["derived"].any()


def test_ttm_rows_that_become_usable_out_of_order():
    idx = pd.bdate_range("2020-10-01", "2021-03-31")
    px = pd.Series(100.0, index=idx)
    t = pd.DataFrame({"period_end": pd.to_datetime(["2020-03-31", "2020-06-30", "2020-09-30", "2020-12-31"]),
                      "available": pd.to_datetime(["2020-05-01", "2021-01-04", "2020-11-02", "2021-02-01"]),
                      "ttm_net_income": [10.0, 20.0, 30.0, 40.0], "shares_adj": 1.0})
    d = valuation.daily_multiples(px, t)
    assert d.loc["2020-12-01", "pe"] == 100 / 30
    assert d.loc["2021-01-15", "pe"] == 100 / 30          # the late Q2 row never replaces the newer Q3 row
    assert d.loc["2021-02-15", "pe"] == 100 / 40
    tie = t.assign(available=pd.to_datetime(["2020-05-01", "2020-11-02", "2020-11-02", "2021-02-01"]))
    assert valuation.daily_multiples(px, tie).loc["2020-12-01", "pe"] == 100 / 30   # newest of tied rows


def test_successor_cik_merges_predecessor_history(monkeypatch, tmp_path):
    new = {"facts": {"us-gaap": {"Revenues": {"units": {"USD": [
        F("2026-04-01", "2026-06-30", 116017, "2026-08-03", "10-Q", "0000034088-26-000093"),
        F("2025-04-01", "2025-06-30", 81506, "2026-08-03", "10-Q", "0000034088-26-000093")]}}}}}
    old = {"facts": {"us-gaap": {"Revenues": {"units": {"USD": [
        F("2025-01-01", "2025-03-31", 83130, "2025-05-05", "10-Q", "o1"),
        F("2025-04-01", "2025-06-30", 81506, "2025-08-04", "10-Q", "o2")]}}}}}
    monkeypatch.setattr(sec, "ticker_to_cik", lambda t: 2115436)
    monkeypatch.setattr(sec, "companyfacts", lambda cik: new if cik == 2115436 else old)
    cik, data = sec.company_data("XOM")
    q = sec.quarterly_fundamentals(data).set_index("period_end")
    assert cik == 2115436 and len(q) == 3
    assert q.loc["2025-06-30", "filed"] == pd.Timestamp("2025-08-04")              # first filed by the predecessor
    # user-declared predecessors work for any ticker
    import mcl.config as config
    monkeypatch.setattr(config, "USER_DIR", tmp_path)
    (tmp_path / "cik_predecessors.json").write_text(json.dumps({"ABC": [111]}))
    assert sec.predecessors("ABC", 999) == [111] and sec.predecessors("XOM", 2115436) == [34088]


def test_tag_switch_keeps_first_reported_value():
    # MSFT Q1 FY2017 revenue: 20,453 under SalesRevenueNet (Oct 2016); the Aug 2018 10-K re-tagged the quarter
    # under RevenueFromContractWithCustomerExcludingAssessedTax at the ASC 606 restated 21,928.
    data = {"facts": {"us-gaap": {
        "SalesRevenueNet": {"units": {"USD": [F("2016-07-01", "2016-09-30", 20453, "2016-10-20", "10-Q", "q1")]}},
        "RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": [
            F("2016-07-02", "2016-09-30", 21928, "2018-08-03", "10-K", "k18")]}}}}}
    first = sec._first_available(data, sec.TAGS["revenue"], sec.discrete_quarters).iloc[0]
    assert first["val"] == 20453 * M and first["filed"] == pd.Timestamp("2016-10-20") and first["tag"] == "SalesRevenueNet"
    q = sec.quarterly_fundamentals(data)
    assert q["filed"].iloc[0] == pd.Timestamp("2016-10-20")
    from functools import partial
    last = sec._first_available(data, sec.TAGS["revenue"], partial(sec.discrete_quarters, keep="last"), keep="last")
    assert last["val"].iloc[0] == 21928 * M


def test_tag_rank_breaks_ties_within_a_filing():
    # AMZN Q1 2012 10-Q tags total net sales and product sales; the total ranks higher
    data = {"facts": {"us-gaap": {
        "SalesRevenueNet": {"units": {"USD": [F("2012-01-01", "2012-03-31", 13185, "2012-04-27", "10-Q", "a")]}},
        "SalesRevenueGoodsNet": {"units": {"USD": [F("2012-01-01", "2012-03-31", 11249, "2012-04-27", "10-Q", "a")]}}}}}
    assert sec._first_available(data, sec.TAGS["revenue"], sec.discrete_quarters)["val"].iloc[0] == 13185 * M


def test_market_hours_8k_takes_yahoo_timing():
    # XOM releases about 07:00 ET and files the 8-K about 09:40; MSFT 2011-01-27 8-K at 15:57, release after the close
    s = pd.DataFrame({"date": pd.to_datetime(["2013-10-31", "2011-01-27", "2024-07-12"]),
                      "accepted": ["2013-10-31 09:48:30", "2011-01-27 15:57:59", "2024-07-12 06:46:30"],
                      "timing": ["dmh", "dmh", "bmo"]})
    y = pd.DataFrame({"date": pd.to_datetime(["2013-10-31", "2011-01-27", "2024-07-12"]), "timestamp": "t",
                      "timing": ["bmo", "amc", "amc"], "eps_estimate": 1.0, "eps_actual": 1.0})
    m = sec.merge_earnings(s, y).set_index("date")
    assert m.loc["2013-10-31", "timing"] == "bmo" and m.loc["2013-10-31", "timing_sec"] == "dmh"
    assert m.loc["2011-01-27", "timing"] == "amc"
    assert m.loc["2024-07-12", "timing"] == "bmo"          # a definite SEC call is never overridden

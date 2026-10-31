"""Restated-as-of basis: a restatement counts from the day it was filed, never before."""
import numpy as np
import pandas as pd
import pytest

from mcl.analytics import valuation
from mcl.data import sec, sec_asof

M = 1_000_000


def F(start, end, val, filed, form="10-Q", accn=None):
    return {"start": start, "end": end, "val": val * M, "filed": filed, "form": form, "accn": accn or f"a-{filed}"}


def payload(tag_rows, shares=None):
    us = {tag: {"units": {"USD": rows}} for tag, rows in tag_rows.items()}
    out = {"facts": {"us-gaap": us}}
    if shares:
        out["facts"]["dei"] = {"EntityCommonStockSharesOutstanding": {"units": {"shares": shares}}}
    return out


def jpm_2011_2012():
    # Net income $M. 2012 values and the 10-Q/A are JPMorgan's as filed (London Whale restatement of Q1 2012);
    # 2011 values are its reported quarters (fixture inputs).
    return [
        F("2011-01-01", "2011-03-31", 5555, "2011-05-06"),
        F("2011-04-01", "2011-06-30", 5431, "2011-08-05"), F("2011-01-01", "2011-06-30", 10986, "2011-08-05"),
        F("2011-07-01", "2011-09-30", 4262, "2011-11-04"), F("2011-01-01", "2011-09-30", 15248, "2011-11-04"),
        F("2011-01-01", "2011-12-31", 18976, "2012-02-29", "10-K"),
        F("2012-01-01", "2012-03-31", 5383, "2012-05-10"), F("2011-01-01", "2011-03-31", 5555, "2012-05-10"),
        F("2012-01-01", "2012-03-31", 4924, "2012-08-09", "10-Q/A", "qa"),
        F("2012-04-01", "2012-06-30", 4960, "2012-08-09", "10-Q", "q2"),
        F("2012-01-01", "2012-06-30", 9884, "2012-08-09", "10-Q", "q2"),
        F("2011-01-01", "2011-06-30", 10986, "2012-08-09", "10-Q", "q2"),
    ]


def test_jpm_restatement_applies_from_its_filing_date():
    rows = sec_asof.fundamentals_asof(payload({"NetIncomeLoss": jpm_2011_2012()})).set_index("knowledge_date")
    assert rows.loc["2012-02-29", "ttm_net_income"] == 18976 * M                       # the 10-K year
    assert rows.loc["2012-05-10", "ttm_net_income"] == (18976 - 5555 + 5383) * M      # Q1 as first reported
    assert rows.loc["2012-08-09", "ttm_net_income"] == (18976 - 10986 + 9884) * M     # restated half year
    # first-reported basis at the same period keeps 5,383: the gap is exactly the 459M restatement
    q = sec.quarterly_fundamentals(payload({"NetIncomeLoss": jpm_2011_2012()}))
    t = valuation.ttm(q).set_index("period_end")
    first = t.loc["2012-06-30", "ttm_net_income"]
    assert first == (4262 + (18976 - 15248) + 5383 + 4960) * M
    assert first - rows.loc["2012-08-09", "ttm_net_income"] == 459 * M


def test_aapl_10ka_restates_the_year_and_next_10q_matches():
    rows = [
        F("2008-09-28", "2009-06-27", 26667, "2009-07-22"), F("2009-03-29", "2009-06-27", 8337, "2009-07-22"),
        F("2008-09-28", "2009-09-26", 36537, "2009-10-27", "10-K", "k09"),
        F("2008-09-28", "2009-09-26", 42905, "2010-01-25", "10-K/A", "k09a"),
        F("2009-09-27", "2009-12-26", 15683, "2010-01-25", "10-Q", "q1"),       # Q1 FY2010, new basis
        F("2008-09-28", "2008-12-27", 11880, "2010-01-25", "10-Q", "q1"),       # Q1 FY2009 comparative, restated
    ]
    r = sec_asof.fundamentals_asof(payload({"SalesRevenueNet": rows})).set_index("knowledge_date")
    assert r.loc["2009-10-27", "ttm_revenue"] == 36537 * M
    assert r.loc["2010-01-25", "ttm_revenue"] == (42905 - 11880 + 15683) * M      # all on the restated basis
    assert np.isnan(r.loc["2010-01-25", "ttm_revenue_prev"])                     # no FY2008 in this fixture
    # the first-reported basis has no TTM row available until the restated quarters were first filed
    t = valuation.ttm(sec.quarterly_fundamentals(payload({"SalesRevenueNet": rows})))
    assert t["ttm_revenue"].notna().sum() == 0


def test_midyear_recast_keeps_last_years_remainder_on_its_own_basis():
    # Y1: H1 50, FY 100. In Y2's Q2 10-Q the H1 Y1 comparative is recast to 40 (a discontinued unit);
    # FY Y1 is not restated yet. Using 100 - 40 would count the unit's H2 but not its H1.
    rows = [F("2021-01-01", "2021-06-30", 50, "2021-08-01"),
            F("2021-01-01", "2021-12-31", 100, "2022-02-15", "10-K"),
            F("2022-01-01", "2022-06-30", 45, "2022-08-01"), F("2021-01-01", "2021-06-30", 40, "2022-08-01")]
    r = sec_asof.fundamentals_asof(payload({"Revenues": rows})).set_index("knowledge_date")
    assert r.loc["2022-08-01", "ttm_revenue"] == (100 - 50 + 45) * M


def test_fallback_to_quarters_without_year_to_date_facts():
    qe = pd.date_range("2021-03-31", periods=6, freq="QE")
    rows = [F(str((e - pd.offsets.QuarterBegin(startingMonth=1)).date()), str(e.date()), 10 + i,
              str((e + pd.Timedelta(days=30)).date())) for i, e in enumerate(qe)]
    r = sec_asof.fundamentals_asof(payload({"Revenues": rows}))
    last = r.iloc[-1]
    assert last["period_end"] == qe[-1] and last["ttm_revenue"] == (12 + 13 + 14 + 15) * M


@pytest.mark.parametrize("cutoff", ["2011-12-31", "2012-06-01", "2012-08-08"])
def test_no_lookahead(cutoff):
    full = sec_asof.fundamentals_asof(payload({"NetIncomeLoss": jpm_2011_2012()}))
    cut = [r for r in jpm_2011_2012() if r["filed"] <= cutoff]
    part = sec_asof.fundamentals_asof(payload({"NetIncomeLoss": cut}))
    a = full[full["knowledge_date"] <= cutoff].reset_index(drop=True)
    pd.testing.assert_frame_equal(a[part.columns], part, check_dtype=False)


def test_daily_pe_switches_the_day_after_the_restatement():
    shares = [{"end": "2012-04-30", "val": 3800 * M, "filed": "2012-05-10", "form": "10-Q", "accn": "s1"},
              {"end": "2012-07-31", "val": 3800 * M, "filed": "2012-08-09", "form": "10-Q", "accn": "s2"}]
    rows = sec_asof.fundamentals_asof(payload({"NetIncomeLoss": jpm_2011_2012()}, shares))
    t = valuation.ttm_asof(rows)
    px = pd.Series(40.0, index=pd.bdate_range("2012-06-01", "2012-09-28"))
    d = valuation.daily_multiples(px, t)
    mcap = 40.0 * 3800 * M
    assert np.isclose(d.loc["2012-08-09", "pe"], mcap / ((18976 - 5555 + 5383) * M))   # filing day: old view
    assert np.isclose(d.loc["2012-08-10", "pe"], mcap / ((18976 - 10986 + 9884) * M))  # next day: restated


def test_ttm_asof_growth_uses_same_day_prior_year():
    rows = pd.DataFrame({"knowledge_date": pd.to_datetime(["2022-08-01"]), "period_end": pd.to_datetime(["2022-06-30"]),
                         "ttm_revenue": [110.0], "ttm_revenue_prev": [100.0], "ttm_op_income": [22.0],
                         "ttm_op_income_prev": [15.0], "ttm_net_income": [12.0], "ttm_net_income_prev": [10.0]})
    t = valuation.ttm_asof(rows).iloc[0]
    assert np.isclose(t["rev_growth_yoy"], 0.10) and np.isclose(t["ni_growth_yoy"], 0.20)
    assert np.isclose(t["op_margin_change"], 0.20 - 0.15)
    assert t["available"] == pd.Timestamp("2022-08-02")


def test_loader_rejects_unknown_basis():
    from mcl.data import loader
    with pytest.raises(ValueError):
        loader.load("AAPL", basis="latest")


def test_verify_basis_compare_lists_the_restatement():
    from mcl import verify
    data = payload({"NetIncomeLoss": jpm_2011_2012()})
    rows = pd.DataFrame(verify.basis_compare(sec.quarterly_fundamentals(data), sec_asof.fundamentals_asof(data)))
    d = rows[(rows["metric"] == "net_income") & (rows["status"] == "info")]
    assert list(d["period_end"]) == [pd.Timestamp("2012-06-30")]
    assert d["sec_value"].iloc[0] - d["compare_value"].iloc[0] == 459 * M and "2012-08-09" in d["note"].iloc[0]
    summary = rows[rows["metric"] == "summary"].iloc[0]
    assert summary["status"] == "ok" and "1 differ" in summary["note"]


def test_basis_compare_aligns_periods_a_day_apart():
    from mcl import verify
    ends = pd.to_datetime(["2009-11-01", "2010-01-31", "2010-05-02", "2010-07-31"])
    q = pd.DataFrame({"period_end": ends, "filed": ends + pd.Timedelta(days=30), "revenue": [1.0, 1.0, 1.0, 1.0]})
    rows = pd.DataFrame({"knowledge_date": pd.to_datetime(["2010-08-30"]), "period_end": pd.to_datetime(["2010-08-01"]),
                         "ttm_revenue": [4.0], "ttm_revenue_prev": [np.nan]})
    r = pd.DataFrame(verify.basis_compare(q, rows))
    summary = r.iloc[-1]
    assert summary["status"] == "ok" and summary["note"].startswith("1 periods compared, 0 differ")
    assert "misses 0" in summary["note"]


def test_nvda_partial_year_fact_in_10k_is_ignored():
    # NVDA revenue $M, real facts: the FY2018 10-K carries a six-month fact holding the Q2 three-month value
    rows = [F("2017-05-01", "2017-07-30", 2230, "2017-08-23", "10-Q", "q217"),
            F("2017-01-30", "2017-07-30", 4167, "2017-08-23", "10-Q", "q217"),
            F("2017-01-30", "2017-07-30", 2230, "2018-02-28", "10-K", "k18"),
            F("2017-01-30", "2018-01-28", 9714, "2018-02-28", "10-K", "k18"),
            F("2018-04-30", "2018-07-29", 3123, "2018-08-16", "10-Q", "q219"),
            F("2018-01-29", "2018-07-29", 6330, "2018-08-16", "10-Q", "q219"),
            F("2017-01-30", "2017-07-30", 4167, "2018-08-16", "10-Q", "q219")]
    r = sec_asof.fundamentals_asof(payload({"Revenues": rows})).set_index("knowledge_date")
    assert r.loc["2018-08-16", "ttm_revenue"] == (9714 - 4167 + 6330) * M


def test_meta_10k_quarterly_recast_is_used():
    # META net income $M, real facts: the FY2016 10-K recast Q1 2016 from 1,510 to 1,738 (consistent with its year)
    rows = [F("2016-01-01", "2016-03-31", 1510, "2016-04-28", "10-Q", "q116"),
            F("2016-01-01", "2016-03-31", 1738, "2017-02-03", "10-K", "k16"),
            F("2016-01-01", "2016-12-31", 10217, "2017-02-03", "10-K", "k16"),
            F("2017-01-01", "2017-03-31", 3064, "2017-05-04", "10-Q", "q117"),
            F("2016-01-01", "2016-03-31", 1738, "2017-05-04", "10-Q", "q117")]
    r = sec_asof.fundamentals_asof(payload({"NetIncomeLoss": rows})).set_index("knowledge_date")
    assert r.loc["2017-05-04", "ttm_net_income"] == (10217 - 1738 + 3064) * M


def test_partial_year_filter_keeps_transition_reports():
    df = sec._facts(payload({"Revenues": [F("2020-01-01", "2020-06-30", 5, "2020-08-01", "10-KT", "t"),
                                          F("2020-01-01", "2020-06-30", 5, "2020-08-01", "10-K", "k")]}), "Revenues")
    assert sec._drop_partial_years_from_annual_reports(df)["form"].tolist() == ["10-KT"]

import numpy as np
import pandas as pd

from mcl.analytics import valuation
from mcl.data import sec


def _fact(start, end, val, filed, form="10-Q", fp="Q1"):
    return {"start": start, "end": end, "val": val, "filed": filed, "form": form, "fp": fp, "accn": f"a{filed}{end}"}


def companyfacts_fixture():
    # FY2021 reported under the old revenue tag, FY2022 under the new one (ASC 606 style switch).
    old = [
        _fact("2021-01-01", "2021-03-31", 100, "2021-05-01"),
        _fact("2021-01-01", "2021-06-30", 210, "2021-08-01", fp="Q2"),
        _fact("2021-04-01", "2021-06-30", 110, "2021-08-01", fp="Q2"),
        _fact("2021-01-01", "2021-09-30", 330, "2021-11-01", fp="Q3"),
        _fact("2021-01-01", "2021-12-31", 460, "2022-02-15", form="10-K", fp="FY"),
        # a later restatement of Q1 2021 must be ignored (first filed wins)
        _fact("2021-01-01", "2021-03-31", 999, "2022-05-01"),
    ]
    new = [
        _fact("2022-01-01", "2022-03-31", 140, "2022-05-01"),
        _fact("2022-04-01", "2022-06-30", 150, "2022-08-01", fp="Q2"),
        _fact("2022-01-01", "2022-06-30", 290, "2022-08-01", fp="Q2"),
    ]
    # operating cash flow reported year-to-date only
    ocf = [
        _fact("2021-01-01", "2021-03-31", 20, "2021-05-01"),
        _fact("2021-01-01", "2021-06-30", 45, "2021-08-01", fp="Q2"),
        _fact("2021-01-01", "2021-09-30", 75, "2021-11-01", fp="Q3"),
        _fact("2021-01-01", "2021-12-31", 100, "2022-02-15", form="10-K", fp="FY"),
    ]
    shares = [{"end": "2021-04-25", "val": 1000, "filed": "2021-05-01", "form": "10-Q", "accn": "s1"},
              {"end": "2021-07-25", "val": 990, "filed": "2021-08-01", "form": "10-Q", "accn": "s2"}]
    return {"facts": {
        "us-gaap": {"SalesRevenueNet": {"units": {"USD": old}},
                    "RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": new}},
                    "NetCashProvidedByUsedInOperatingActivities": {"units": {"USD": ocf}},
                    "NetIncomeLoss": {"units": {"USD": [_fact("2021-01-01", "2021-03-31", 10, "2021-05-01")]}}},
        "dei": {"EntityCommonStockSharesOutstanding": {"units": {"shares": shares}}}}}


def test_discrete_quarters_from_cumulative_values():
    df = sec._facts(companyfacts_fixture(), "SalesRevenueNet")
    q = sec.discrete_quarters(df).set_index("period_end")
    assert q.loc["2021-03-31", "val"] == 100           # first filed, restatement ignored
    assert q.loc["2021-06-30", "val"] == 110           # direct quarter preferred
    assert q.loc["2021-09-30", "val"] == 120           # 9M - H1
    assert q.loc["2021-12-31", "val"] == 130           # FY - 9M
    assert q.loc["2021-12-31", "filed"] == pd.Timestamp("2022-02-15")
    assert bool(q.loc["2021-12-31", "derived"])


def test_ytd_cash_flow_differenced():
    q = sec.discrete_quarters(sec._facts(companyfacts_fixture(), "NetCashProvidedByUsedInOperatingActivities"))
    assert q["val"].tolist() == [20, 25, 30, 25]


def test_quarterly_fundamentals_merges_tags_and_shares():
    q = sec.quarterly_fundamentals(companyfacts_fixture()).set_index("period_end")
    assert q.loc["2021-12-31", "revenue"] == 130
    assert q.loc["2022-03-31", "revenue"] == 140
    assert q.loc["2022-06-30", "revenue"] == 150
    assert q.loc["2021-03-31", "shares"] == 1000       # cover-page count filed with that quarter
    assert q.loc["2021-06-30", "shares"] == 990


def test_ttm_contiguity_and_split_adjustment():
    qe = pd.date_range("2019-03-31", periods=8, freq="QE")
    q = pd.DataFrame({"period_end": qe, "filed": qe + pd.Timedelta(days=30), "revenue": 10.0,
                      "net_income": 1.0, "shares": 100.0})
    q = q.drop(index=3)  # missing quarter breaks contiguity
    splits = pd.Series([4.0], index=[pd.Timestamp("2020-03-15")])
    t = valuation.ttm(q, splits)
    t = t.set_index("period_end")
    assert np.isnan(t.loc["2020-03-31", "ttm_revenue"])  # window spans the gap
    assert t.loc["2020-12-31", "ttm_revenue"] == 40.0
    assert t.loc["2019-06-30", "shares_adj"] == 400.0    # pre-split count in today's basis
    assert t.loc["2020-06-30", "shares_adj"] == 100.0


def test_multiples_and_ceilings():
    idx = pd.bdate_range("2020-01-01", periods=400)
    px = pd.Series(20.0, index=idx)
    qe = pd.date_range("2018-12-31", periods=10, freq="QE")
    q = pd.DataFrame({"period_end": qe, "filed": qe + pd.Timedelta(days=30), "revenue": 50.0, "net_income": 5.0,
                      "ocf": 8.0, "capex": -2.0, "shares": 10.0, "total_debt": 30.0, "cash": 10.0})
    d = valuation.daily_multiples(px, valuation.ttm(q)).dropna(subset=["pe"])
    r = d.iloc[-1]
    assert np.isclose(r["pe"], 200 / 20) and np.isclose(r["ps"], 200 / 200)
    assert np.isclose(r["ev_sales"], (200 + 30 - 10) / 200) and np.isclose(r["pfcf"], 200 / 24)
    lv = valuation.ceiling_levels(pd.Series([30, 31, 29.5, 45, 46, 18]), band=0.05, min_hits=2)
    assert lv["hits"].tolist() == [3, 2]


def test_merge_earnings_mixed_datetime_units():
    s = pd.DataFrame({"date": pd.to_datetime(["2024-01-30", "2024-04-30"]).as_unit("us"), "accepted": ["a", "b"],
                      "timing": ["amc", "bmo"]})
    y = pd.DataFrame({"date": pd.to_datetime(["2024-01-30", "2024-05-01", "2024-07-30"]).as_unit("ns"),
                      "timestamp": "x", "timing": "unknown", "eps_estimate": [1.0, 2.0, 3.0], "eps_actual": [1.1, 2.1, np.nan]})
    m = sec.merge_earnings(s, y)
    rep = m[m["kind"] == "report"]
    assert len(rep) == 3
    # a 2.02 filing a day off Yahoo's report date is a different event: Yahoo's date stands
    assert m.loc[m["date"] == "2024-04-30", "kind"].iloc[0] == "other_2.02"
    assert rep.loc[rep["date"] == "2024-05-01", "eps_estimate"].iloc[0] == 2.0
    assert rep.loc[rep["date"] == "2024-01-30", "timing"].iloc[0] == "amc"   # SEC timing kept on an exact match
    assert rep["eps_actual"].isna().sum() == 1                                # upcoming report kept


def test_daily_multiples_mixed_units():
    idx = pd.bdate_range("2021-01-01", periods=300).as_unit("us")
    px = pd.Series(10.0, index=idx)
    qe = pd.date_range("2019-12-31", periods=8, freq="QE").as_unit("s")
    q = pd.DataFrame({"period_end": qe, "filed": qe + pd.Timedelta(days=30), "revenue": 5.0, "net_income": 1.0, "shares": 4.0})
    d = valuation.daily_multiples(px, valuation.ttm(q))
    assert np.isclose(d["pe"].dropna().iloc[-1], 10.0)

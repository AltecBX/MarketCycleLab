"""Known-answer tests for `mcl verify`, the share-count fixes and the 8-K dating, with no network."""
import ssl
import urllib.error

import numpy as np
import pandas as pd
import pytest

from mcl import verify
from mcl.data import http, sec, store


@pytest.fixture(autouse=True)
def exact(monkeypatch):
    # fixture values are small integers, so drop the $2M rounding allowance
    monkeypatch.setattr(verify, "ABS_TOL", 0.0)


def test_tolerance_defaults():
    assert verify.TOL == 0.005
    verify.ABS_TOL = 2e6
    assert verify._close(10_000e6, 10_040e6) and not verify._close(10_000e6, 10_060e6)   # 0.5% relative
    assert verify._close(100e6, 101.5e6)                                                  # $2M absolute floor


def F(start, end, val, filed, form="10-Q", accn=None):
    return {"start": start, "end": end, "val": val, "filed": filed, "form": form, "accn": accn or f"0000-{filed}"}


def facts():
    """Two fiscal years of revenue. FY2022 is clean. In FY2023 Q1 is recast lower in the Q2 10-Q
    (discontinued operation) so the first-filed Q1+Q2+Q3 no longer add to the 9-month total."""
    rev = [
        # FY2022: three-month and year-to-date values, as a 10-Q reports them
        F("2022-01-01", "2022-03-31", 100, "2022-05-01"),
        F("2022-04-01", "2022-06-30", 110, "2022-08-01"), F("2022-01-01", "2022-06-30", 210, "2022-08-01"),
        F("2022-07-01", "2022-09-30", 120, "2022-11-01"), F("2022-01-01", "2022-09-30", 330, "2022-11-01"),
        F("2022-01-01", "2022-12-31", 460, "2023-02-15", "10-K", "K22"),
        # FY2023
        F("2023-01-01", "2023-03-31", 140, "2023-05-01"),
        F("2023-01-01", "2023-03-31", 130, "2023-08-01"),           # recast, filed later: studies keep 140
        F("2023-04-01", "2023-06-30", 150, "2023-08-01"), F("2023-01-01", "2023-06-30", 280, "2023-08-01"),
        F("2023-07-01", "2023-09-30", 160, "2023-11-01"), F("2023-01-01", "2023-09-30", 440, "2023-11-01"),
        F("2023-01-01", "2023-12-31", 610, "2024-02-15", "10-K", "K23"),
    ]
    ni = [F(r["start"], r["end"], r["val"] / 10, r["filed"], r["form"], r["accn"]) for r in rev[:6]]
    dei = [{"end": "2022-04-20", "val": 1000, "filed": "2022-05-01", "form": "10-Q", "accn": "s1"},
           {"end": "2022-07-20", "val": 1000, "filed": "2022-08-01", "form": "10-Q", "accn": "s2"},
           {"end": "2022-10-20", "val": 400, "filed": "2022-11-01", "form": "10-Q", "accn": "s3"},   # one class only
           {"end": "2023-02-01", "val": 1000, "filed": "2023-02-15", "form": "10-K", "accn": "s4"}]
    wds = [F("2022-01-01", "2022-03-31", 1000, "2022-05-01"), F("2022-04-01", "2022-06-30", 1000, "2022-08-01"),
           F("2022-07-01", "2022-09-30", 1000, "2022-11-01")]
    return {"facts": {"us-gaap": {"Revenues": {"units": {"USD": rev}}, "NetIncomeLoss": {"units": {"USD": ni}},
                                  "WeightedAverageNumberOfDilutedSharesOutstanding": {"units": {"shares": wds}}},
                      "dei": {"EntityCommonStockSharesOutstanding": {"units": {"shares": dei}}}}}


def _by(rows, check, metric=None):
    df = pd.DataFrame(rows)
    df = df[df["check"] == check]
    return df if metric is None else df[df["metric"] == metric]


def test_fiscal_years_flags_mid_year_recast():
    fy = _by(verify.fiscal_years(facts(), cik=1), "fiscal_years", "revenue").set_index("period_end")
    assert fy.loc[pd.Timestamp("2022-12-31"), "status"] == "ok"
    # 140 + 150 + 160 + (610 - 440) = 620 vs 610 in the 10-K
    r = fy.loc[pd.Timestamp("2023-12-31")]
    assert r["status"] == "fail" and r["sec_value"] == 620 and r["compare_value"] == 610
    assert r["source"].endswith("/1/K23/")


def test_fiscal_years_marks_construction():
    data = facts()
    us = data["facts"]["us-gaap"]
    # year-to-date only (cash flow style): the check holds by construction
    us["NetCashProvidedByUsedInOperatingActivities"] = {"units": {"USD": [
        F("2022-01-01", "2022-03-31", 20, "2022-05-01"), F("2022-01-01", "2022-06-30", 45, "2022-08-01"),
        F("2022-01-01", "2022-09-30", 75, "2022-11-01"), F("2022-01-01", "2022-12-31", 100, "2023-02-15", "10-K")]}}
    r = _by(verify.fiscal_years(data), "fiscal_years", "ocf").iloc[0]
    assert r["status"] == "ok" and "by construction" in r["note"]


def test_restated_reports_first_and_latest():
    r = _by(verify.restated(facts()), "restated", "revenue").set_index("period_end")
    assert r.loc[pd.Timestamp("2023-03-31"), "sec_value"] == 140
    assert r.loc[pd.Timestamp("2023-03-31"), "sec_latest"] == 130
    assert len(r) >= 1 and set(r["status"]) == {"info"}


def test_vs_yahoo_statuses():
    y = pd.DataFrame({"metric": ["revenue", "revenue", "revenue", "net_income"],
                      "period_end": pd.to_datetime(["2022-09-30", "2023-03-31", "2023-06-30", "2022-06-30"]),
                      "value": [120.0, 130.0, 999.0, 11.0]})
    v = _by(verify.vs_yahoo(facts(), y, cik=1), "yahoo").set_index(["metric", "period_end"])
    assert v.loc[("revenue", pd.Timestamp("2022-09-30")), "status"] == "ok"
    assert v.loc[("revenue", pd.Timestamp("2023-03-31")), "status"] == "info"      # matches the restated value
    assert v.loc[("revenue", pd.Timestamp("2023-06-30")), "status"] == "fail"
    assert v.loc[("net_income", pd.Timestamp("2022-06-30")), "status"] == "ok"


def test_integrity_and_shares():
    data = facts()
    q = sec.quarterly_fundamentals(data)
    integ = pd.DataFrame(verify.integrity(q))
    assert not (integ["status"] == "fail").any()
    sh = pd.DataFrame(verify.shares(data, q, None))
    flagged = set(sh.loc[sh["status"] == "warn", "period_end"])
    assert pd.Timestamp("2022-09-30") in flagged            # 400 cover shares vs 1000 diluted: partial class count
    assert not (sh["status"] == "fail").any()               # no look-ahead


def test_integrity_negative_and_gap():
    q = pd.DataFrame({"period_end": pd.to_datetime(["2022-03-31", "2022-06-30", "2022-12-31", "2023-03-31"]),
                      "filed": pd.to_datetime(["2022-05-01", "2022-08-01", "2023-02-15", "2023-05-01"]),
                      "revenue": [100.0, -5.0, 100.0, 100.0]})
    integ = pd.DataFrame(verify.integrity(q))
    assert (integ["note"].str.contains("1 quarter")).any()
    assert ((integ["metric"] == "revenue") & (integ["status"] == "fail")).any()


def test_share_count_is_point_in_time():
    q = sec.quarterly_fundamentals(facts()).set_index("period_end")
    assert q.loc["2022-03-31", "shares"] == 1000
    assert q.loc["2022-09-30", "shares"] == 400               # its own filing's cover page
    assert (q["shares_filed"] <= q["filed"]).all()           # never from a later filing


def test_weighted_share_fallback_not_differenced():
    data = facts()
    del data["facts"]["dei"]
    data["facts"]["us-gaap"]["WeightedAverageNumberOfDilutedSharesOutstanding"]["units"]["shares"] += [
        F("2022-01-01", "2022-09-30", 1000, "2022-11-01"), F("2022-01-01", "2022-12-31", 1000, "2023-02-15", "10-K")]
    q = sec.quarterly_fundamentals(data).set_index("period_end")
    # FY average minus 9-month average would be 0; the 10-K quarter must carry a real count
    assert q.loc["2022-12-31", "shares"] == 1000
    assert (q["shares"].dropna() > 0).all()


def test_earnings_dates_check():
    s = pd.DataFrame({"date": pd.to_datetime(["2024-01-30", "2024-04-30", "2024-06-15"]),
                      "accepted": ["2024-01-30 16:05:00", "2024-04-30 07:00:00", "2024-06-15 08:00:00"],
                      "timing": ["amc", "bmo", "bmo"]})
    y = pd.DataFrame({"date": pd.to_datetime(["2024-01-30", "2024-04-30", "2024-07-30"]),
                      "timestamp": ["a", "b", "c"], "timing": ["amc", "amc", "bmo"]})
    e = pd.DataFrame(verify.earnings_dates(s, y, today="2024-08-15"))
    assert e.loc[e["metric"] == "acceptance_clock", "status"].iloc[0] == "ok"
    assert (e["metric"] == "extra_8k").sum() == 1            # 2024-06-15 has no report
    assert (e["metric"] == "timing_diff").sum() == 1
    assert (e["metric"] == "missing_8k").sum() == 1
    t = e[e["metric"] == "timing"].iloc[0]
    assert t["sec_value"] == 0.5 and t["status"] == "warn"


def test_8k_dated_by_acceptance(monkeypatch, tmp_path):
    monkeypatch.setattr(store, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(sec, "ticker_to_cik", lambda t: 1)
    sub = {"filings": {"recent": {
        "form": ["8-K", "8-K", "10-Q"], "items": ["2.02,9.01", "2.02", ""],
        "filingDate": ["2024-05-02", "2024-07-25", "2024-05-03"],
        "acceptanceDateTime": ["2024-05-01T18:10:00.000Z", "2024-07-25T07:01:00.000Z", "2024-05-03T10:00:00.000Z"]},
        "files": []}}
    monkeypatch.setattr(sec, "_get", lambda url: sub)
    e = sec.earnings_releases("X").set_index("date")
    # accepted after 17:30 ET: filingDate is the next day, the release was the evening before
    assert e.loc["2024-05-01", "timing"] == "amc"
    assert pd.Timestamp(e.loc["2024-05-01", "filing_date"]) == pd.Timestamp("2024-05-02")
    assert e.loc["2024-07-25", "timing"] == "bmo"
    assert len(e) == 2


def test_http_certifi_fallback_and_404(monkeypatch):
    monkeypatch.setattr(http, "_ctx", None)
    monkeypatch.setattr(http, "_using_certifi", False)
    monkeypatch.setattr(http.time, "sleep", lambda s: None)
    calls = []

    class Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b"ok"

    def fake_urlopen(req, timeout=None, context=None):
        calls.append(context)
        if context is None:
            raise urllib.error.URLError(ssl.SSLCertVerificationError("CERTIFICATE_VERIFY_FAILED"))
        return Resp()

    monkeypatch.setattr(http.urllib.request, "urlopen", fake_urlopen)
    assert http.get_bytes("https://example.com/x") == b"ok"
    assert calls[0] is None and calls[1] is not None and http.tls_mode() == "certifi bundle"

    def not_found(req, timeout=None, context=None):
        calls.append("404")
        raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)

    monkeypatch.setattr(http.urllib.request, "urlopen", not_found)
    n = len(calls)
    with pytest.raises(http.NotFound):
        http.get_bytes("https://data.sec.gov/x")
    assert len(calls) == n + 1                               # not retried


def test_cli_verify_end_to_end(monkeypatch, tmp_path, capsys):
    from mcl import __main__ as cli
    from mcl.data import yahoo
    monkeypatch.setattr(cli, "REPORTS_DIR", tmp_path)
    monkeypatch.setattr(sec, "ticker_to_cik", lambda t: 42)
    monkeypatch.setattr(sec, "companyfacts", lambda cik: facts())
    monkeypatch.setattr(sec, "earnings_releases", lambda t: pd.DataFrame(columns=["date", "accepted", "timing"]))
    monkeypatch.setattr(yahoo, "prices", lambda t: pd.DataFrame({"close": [1.0], "splits": [0.0]},
                                                                index=pd.to_datetime(["2024-01-02"])))
    monkeypatch.setattr(yahoo, "quarterly_statements", lambda t: pd.DataFrame(
        {"metric": ["revenue"], "period_end": pd.to_datetime(["2023-09-30"]), "value": [160.0]}))
    monkeypatch.setattr(yahoo, "earnings_dates", lambda t: pd.DataFrame(columns=["date", "timestamp", "timing"]))
    code = cli.main(["verify", "TEST"])
    out = capsys.readouterr().out
    assert code == 1                                         # the FY2023 recast is a FAIL
    assert "fiscal_years" in out and "spot check" in out
    rows = pd.read_csv(tmp_path / "verify_TEST.csv")
    assert {"fiscal_years", "yahoo", "restated", "integrity", "shares", "earnings"} <= set(rows["check"])
    assert (tmp_path / "verify_summary.csv").exists()


def test_integrity_outlier_ignores_seasonality():
    qe = pd.date_range("2019-03-31", periods=16, freq="QE")
    season = np.tile([100.0, 300.0, 100.0, 100.0], 4)          # every Q2 is 3x: seasonal, not an error
    q = pd.DataFrame({"period_end": qe, "filed": qe + pd.Timedelta(days=40), "revenue": season})
    assert not (pd.DataFrame(verify.integrity(q))["metric"] == "revenue").any()
    q.loc[13, "revenue"] = 20.0                                 # a bad Q4-style difference
    flagged = pd.DataFrame(verify.integrity(q))
    flagged = flagged[flagged["metric"] == "revenue"]
    assert list(flagged["period_end"]) == [qe[13]]

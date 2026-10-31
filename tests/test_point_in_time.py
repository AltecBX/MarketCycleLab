"""No-lookahead property: values for dates up to T must not change when later data is added."""
import numpy as np
import pandas as pd
import pytest

from mcl.analytics import indicators, regimes, swings, valuation


def _same(a: pd.DataFrame | pd.Series, b: pd.DataFrame | pd.Series):
    a, b = a.loc[b.index], b
    if isinstance(a, pd.Series):
        a, b = a.to_frame(), b.to_frame()
    for col in b.columns:
        x, y = a[col], b[col]
        if pd.api.types.is_numeric_dtype(y):
            assert np.allclose(x.to_numpy(dtype=float), y.to_numpy(dtype=float), equal_nan=True, rtol=1e-9, atol=1e-12), col
        else:
            assert x.astype(str).equals(y.astype(str)), col


@pytest.mark.parametrize("cut", [400, 900, 1300])
def test_technical_features(random_ohlcv, cut):
    full = indicators.technical_features(random_ohlcv)
    part = indicators.technical_features(random_ohlcv.iloc[:cut])
    _same(full, part)


@pytest.mark.parametrize("cut", [300, 800, 1200])
def test_swing_state(random_ohlcv, cut):
    c = random_ohlcv["close"]
    _same(swings.swing_state(c, 0.08), swings.swing_state(c.iloc[:cut], 0.08))


def test_expanding_bands_and_percentile(random_ohlcv):
    s = random_ohlcv["close"]
    _same(valuation.bands(s, min_periods=100), valuation.bands(s.iloc[:700], min_periods=100))


def test_regime_frame(random_ohlcv):
    c = random_ohlcv["close"]
    vix = pd.Series(np.linspace(12, 30, len(c)), index=c.index)
    y = pd.Series(np.linspace(1.5, 4.5, len(c)), index=c.index)
    _same(regimes.regime_frame(c, vix, y), regimes.regime_frame(c.iloc[:900], vix.iloc[:900], y.iloc[:900]))


def test_fundamentals_not_used_before_filing():
    idx = pd.bdate_range("2019-01-01", "2021-12-31")
    px = pd.Series(50.0, index=idx)
    qe = pd.date_range("2018-03-31", periods=15, freq="QE")
    q = pd.DataFrame({"period_end": qe, "filed": qe + pd.Timedelta(days=40), "revenue": 100.0,
                      "net_income": np.arange(1, 16, dtype=float), "shares": 10.0})
    t = valuation.ttm(q)
    d = valuation.daily_multiples(px, t)
    for r in t.dropna(subset=["ttm_net_income"]).itertuples():
        day_before = r.available - pd.Timedelta(days=1)
        if day_before in d.index:
            assert d.loc[day_before, "pe"] != pytest.approx(500.0 / r.ttm_net_income) or \
                d.loc[day_before, "period_end"] != r.period_end
        on = d.index[d.index >= r.available]
        if len(on) and on[0] < (r.available + pd.Timedelta(days=80)):
            assert d.loc[on[0], "period_end"] == r.period_end
    # nothing is known before the first full TTM filing
    first = t["available"][t["ttm_net_income"].notna()].min()
    assert d.loc[d.index < first, "pe"].isna().all()

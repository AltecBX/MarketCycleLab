"""Exercise the live loader with Yahoo-shaped fake responses (no network)."""
import numpy as np
import pandas as pd
import pytest

from mcl import study
from mcl.data import loader, macro, store, yahoo


class FakeTicker:
    def __init__(self, sym):
        self.sym = sym
        rng = np.random.default_rng(abs(hash(sym)) % 2**32)
        n = 1800
        idx = pd.bdate_range("2018-01-02", periods=n, tz="America/New_York")
        c = 100 * np.exp(np.cumsum(rng.normal(0.0004, 0.012, n)))
        self._h = pd.DataFrame({"Open": c * 0.999, "High": c * 1.01, "Low": c * 0.99, "Close": c, "Adj Close": c * 0.98,
                                "Volume": rng.integers(1e6, 5e6, n), "Dividends": 0.0, "Stock Splits": 0.0}, index=idx)
        self._h.iloc[900, self._h.columns.get_loc("Stock Splits")] = 4.0

    def history(self, start=None, auto_adjust=True, actions=True):
        assert auto_adjust is False
        return self._h

    @property
    def splits(self):
        s = self._h["Stock Splits"]
        return s[s > 0]

    @property
    def info(self):
        return {"longName": self.sym, "sector": "Technology", "industry": "Semiconductors", "quoteType": "EQUITY"}

    def get_earnings_dates(self, limit=12):
        idx = pd.DatetimeIndex(pd.date_range("2018-02-01 16:05", periods=30, freq="91D"), tz="America/New_York")
        return pd.DataFrame({"EPS Estimate": np.linspace(1, 2, 30), "Reported EPS": np.linspace(1.05, 2.1, 30),
                             "Surprise(%)": 5.0}, index=idx)


class FakeYF:
    Ticker = FakeTicker


@pytest.fixture
def offline(monkeypatch, tmp_path):
    monkeypatch.setattr(store, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(yahoo, "_yf", lambda: FakeYF)
    monkeypatch.setattr(macro, "sp500_constituents", lambda: pd.DataFrame(
        {"Symbol": ["FAKE", "PEER"], "GICS Sector": ["Information Technology"] * 2,
         "GICS Sub-Industry": ["Semiconductors"] * 2}))
    idx = pd.bdate_range("2018-01-02", periods=1800)
    monkeypatch.setattr(macro, "vix", lambda: pd.Series(18.0, index=idx))
    monkeypatch.setattr(macro, "yield10", lambda: pd.Series(np.linspace(2, 4.5, len(idx)), index=idx))
    import mcl.data.sec as sec

    def no_sec(*a, **k):
        raise RuntimeError("SEC offline in tests")
    monkeypatch.setattr(sec, "fundamentals", no_sec)
    monkeypatch.setattr(sec, "earnings_releases", no_sec)


def test_live_loader_and_study(offline):
    b = loader.load("FAKE")
    assert b.prices.index.tz is None
    assert {"close", "adj_close", "volume", "splits"} <= set(b.prices.columns)
    assert b.info["sector_etf"] == "XLK" and b.info["industry_etf"] == "SMH" and b.info["peers"] == ["PEER"]
    assert b.market is not None and b.sector is not None and b.industry is not None
    assert b.earnings is not None and set(b.earnings["timing"]) == {"amc"}
    assert any("fundamentals unavailable" in n for n in b.notes)
    R = study.run(b)
    assert "earn_table" in R and R["earn_summary"]["n"] >= 20
    assert "val_bands" not in R  # no fundamentals offline
    assert R["snapshot"]["phase"]
    # cached on second load
    assert store.load_frame("prices", "FAKE") is not None

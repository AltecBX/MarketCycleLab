import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def piecewise(points, steps=10, start="2020-01-01"):
    """Linear path through `points`, `steps` bars per segment, on business days."""
    seg = []
    for a, b in zip(points[:-1], points[1:]):
        seg += list(np.linspace(a, b, steps + 1))[:-1]
    seg.append(points[-1])
    return pd.Series(seg, index=pd.bdate_range(start, periods=len(seg)), dtype=float)


@pytest.fixture
def known_path():
    # 100 -> 120 -> 96 -> 110 -> 88 -> 130 -> 117 -> 140
    return piecewise([100, 120, 96, 110, 88, 130, 117, 140])


@pytest.fixture
def random_ohlcv():
    rng = np.random.default_rng(42)
    n = 1500
    idx = pd.bdate_range("2015-01-02", periods=n)
    c = pd.Series(100 * np.exp(np.cumsum(rng.normal(0.0003, 0.013, n))), index=idx)
    return pd.DataFrame({"open": c.shift(1).fillna(100.0), "high": c * 1.01, "low": c * 0.99, "close": c,
                         "adj_close": c, "volume": rng.integers(1_000_000, 3_000_000, n).astype(float)})

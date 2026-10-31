"""Valuation versus peers (research area 5).

Premium history uses the peer median each day (at least `min_peers` peers
with a valid multiple). The cross-section fit asks whether growth and margins
justify today's premium. The quadrant study separates "cheap and improving"
from "cheap and deteriorating" (the value-trap case) and scores what
historically followed each.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .indicators import expanding_pct_rank
from .evidence import conditional_table


def premium_history(stock: pd.Series, peers: dict[str, pd.Series], min_peers: int = 3,
                    log: bool = True) -> pd.DataFrame:
    """Stock multiple relative to the daily peer median, with point-in-time percentile."""
    P = pd.DataFrame(peers).reindex(stock.index)
    P = P.where(P > 0)
    med = P.median(axis=1).where(P.notna().sum(axis=1) >= min_peers)
    out = pd.DataFrame({"stock": stock, "peer_median": med, "n_peers": P.notna().sum(axis=1)})
    out["premium"] = out["stock"] / out["peer_median"] - 1.0
    rel = np.log(out["stock"] / out["peer_median"]) if log else out["premium"]
    out["premium_pctile"] = expanding_pct_rank(rel, 252)
    out["premium_median_to_date"] = out["premium"].expanding(252).median()
    return out


def cross_section_fit(snapshot: pd.DataFrame, metric: str, drivers=("rev_growth_yoy", "op_income_margin"),
                      min_n: int = 6) -> pd.DataFrame:
    """Across peers on one date: log(metric) ~ drivers. Residual > 0 = richer than fundamentals imply.

    `snapshot` is indexed by ticker. With fewer than `min_n` usable peers the
    fit is skipped, because a handful of names cannot pin down a slope.
    """
    cols = [c for c in drivers if c in snapshot]
    d = snapshot[[metric] + cols].dropna()
    d = d[d[metric] > 0]
    out = snapshot.copy()
    if len(d) < max(min_n, len(cols) + 3):
        out["fit_ok"] = False
        return out
    X = np.column_stack([np.ones(len(d))] + [d[c].to_numpy() for c in cols])
    y = np.log(d[metric].to_numpy())
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    Xa = np.column_stack([np.ones(len(out))] + [out[c].to_numpy(dtype=float) for c in cols])
    implied = np.exp(Xa @ beta)
    out["implied_multiple"] = implied
    out["premium_vs_implied"] = out[metric] / implied - 1.0
    out["fit_ok"] = True
    out["fit_n"] = len(d)
    return out


def quadrant_labels(val_pctile: pd.Series, fund_momentum: pd.Series, cheap: float = 0.3,
                    rich: float = 0.7) -> pd.Series:
    """cheap/fair/rich (own-history percentile) x improving/deteriorating fundamentals."""
    v = pd.Series(np.select([val_pctile <= cheap, val_pctile >= rich], ["cheap", "rich"], default="fair"),
                  index=val_pctile.index)
    m = pd.Series(np.where(fund_momentum > 0, "improving", "deteriorating"), index=val_pctile.index)
    lab = v + "_" + m
    lab[val_pctile.isna() | fund_momentum.isna()] = pd.NA
    return lab


def quadrant_study(daily: pd.DataFrame, metric: str, fwd: pd.Series, horizon_name: str = "fwd_126",
                   momentum_col: str = "rev_growth_accel", sample_every: int = 21) -> pd.DataFrame:
    """Forward returns by valuation x fundamental-momentum quadrant.

    Samples every `sample_every` bars to limit overlap. For a value metric
    where low = cheap (P/E, P/S), the percentile is used directly; for yields
    pass the inverted series.
    """
    d = daily.copy()
    d["val_pctile"] = expanding_pct_rank(d[metric].where(d[metric] > 0), 252)
    d["quadrant"] = quadrant_labels(d["val_pctile"], d.get(momentum_col))
    d[horizon_name] = fwd.reindex(d.index)
    d = d.iloc[::sample_every].dropna(subset=["quadrant", horizon_name])
    d["positive"] = d[horizon_name] > 0
    d["date"] = d.index
    return conditional_table(d, "quadrant", "positive", ret_col=horizon_name)

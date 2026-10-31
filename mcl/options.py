"""Covered calls, protective puts and collars on shares already owned: complete payoffs.

Prices come from Yahoo option chains (a snapshot: no history). A contract's price
is the bid/ask midpoint; when either side is missing the last trade is used and
the row is flagged. Before expiration, values are Black Scholes estimates at the
chain's implied volatility (r = 4%, no dividends); they are labeled as estimates.

Tax notes (US federal; information, not advice; statute citations in SYSTEM_PLAN.md):
* A call is a qualified covered call only if exchange traded, written more than
  30 days before expiration, and not deep in the money (IRC 1092(c)(4)). Deep in
  the money means a strike below the lowest qualified benchmark (LQB): the highest
  listed strike below the applicable stock price, with special rules in
  1092(c)(4)(D)(ii) to (iv), implemented in `lowest_qualified_benchmark` and checked
  against the statute text. The applicable stock price is the close on the last
  trading day before the call is written, or that day's open if it is more than
  110% of that close (1092(c)(4)(G)); the panel cannot know the open, so it uses
  the prior close and says so. Days are counted from the day the call is written.
* A qualified call struck below the applicable stock price suspends the stock's
  holding period while it is open, and a loss on it is long term if a gain on the
  stock would be (1092(f)).
* Premium on a call that expires or is bought back is short term gain or loss (1234(b)).
"""
from __future__ import annotations

import math
import re

import numpy as np
import pandas as pd
from scipy.stats import norm

RATE = 0.04


def bs_price(S: float, K: float, T: float, vol: float, kind: str = "call", r: float = RATE) -> float:
    if T <= 0 or vol <= 0:
        return max(0.0, S - K) if kind == "call" else max(0.0, K - S)
    d1 = (math.log(S / K) + (r + 0.5 * vol * vol) * T) / (vol * math.sqrt(T))
    d2 = d1 - vol * math.sqrt(T)
    if kind == "call":
        return S * norm.cdf(d1) - K * math.exp(-r * T) * norm.cdf(d2)
    return K * math.exp(-r * T) * norm.cdf(-d2) - S * norm.cdf(-d1)


def bs_delta(S: float, K: float, T: float, vol: float, kind: str = "call", r: float = RATE) -> float:
    if T <= 0 or vol <= 0:
        return float(S > K) if kind == "call" else -float(S < K)
    d1 = (math.log(S / K) + (r + 0.5 * vol * vol) * T) / (vol * math.sqrt(T))
    return norm.cdf(d1) if kind == "call" else norm.cdf(d1) - 1.0


def lowest_qualified_benchmark(strikes, applicable_price: float, days_to_expiry: int, strike: float) -> float:
    """LQB under IRC 1092(c)(4)(D) for a call with `strike` written `days_to_expiry` before expiration.

    (i)   highest listed strike below the applicable stock price;
    (ii)  term over 90 days and strike over $50: the second highest listed strike below that price;
    (iii) applicable price $25 or less: not less than 85% of the price;
    (iv)  applicable price $150 or less: not less than the price minus $10.
    """
    below = sorted(k for k in {float(x) for x in strikes} if k < applicable_price)
    if not below:
        return float("nan")
    lqb = below[-1]
    if days_to_expiry > 90 and strike > 50 and len(below) >= 2:
        lqb = below[-2]
    if applicable_price <= 25 and lqb < 0.85 * applicable_price:
        lqb = 0.85 * applicable_price
    if applicable_price <= 150 and lqb < applicable_price - 10:
        lqb = applicable_price - 10
    return lqb


def strike_gap(strikes, applicable_price: float) -> tuple[bool, float, float]:
    """Whether the listed strikes look incomplete just below the price: the gap from the price down to the
    highest strike below it is more than twice the tightest spacing among strikes within 15% of the price.
    (Live case: Yahoo's SMH 2026-12-04 chain had 26 calls and nothing between 500 and 525, stock 522.49.)"""
    ks = sorted({float(x) for x in strikes})
    below = [k for k in ks if k < applicable_price]
    near = [k for k in ks if abs(k / applicable_price - 1) <= 0.15]
    if not below or len(near) < 3:
        return False, np.nan, np.nan
    step = float(np.min(np.diff(near)))
    gap = applicable_price - below[-1]
    return bool(gap > 2 * step + 1e-9), below[-1], step


def qualified_covered_call(strikes, applicable_price: float, days_to_expiry: int, strike: float) -> dict:
    """qualified is True, False, or None when the answer depends on strikes missing from the list."""
    lqb = lowest_qualified_benchmark(strikes, applicable_price, days_to_expiry, strike)
    deep = bool(np.isfinite(lqb) and strike < lqb)
    qualified = days_to_expiry > 30 and not deep
    notes = []
    if days_to_expiry <= 30:
        notes.append("30 days or less to expiration: not a qualified covered call")
    if deep:
        notes.append(f"deep in the money (strike below the benchmark {lqb:.2f}): not a qualified covered call")
    gappy, k_below, step = strike_gap(strikes, applicable_price)
    if qualified and gappy and strike < applicable_price:
        qualified = None
        notes.append(f"the strike list has no strikes between {k_below:g} and the price {applicable_price:.2f} although "
                     f"strikes {step:g} apart are listed nearby; the benchmark may be higher than {lqb:.2f}. "
                     f"Confirm the listed strikes with your broker")
    if qualified and strike < applicable_price:
        notes.append("qualified but in the money: the stock's holding period stops while the call is open")
    return {"qualified": qualified, "lqb": lqb, "deep_itm": deep, "notes": notes}


def grant_date(now: pd.Timestamp | None = None) -> pd.Timestamp:
    """Day a call written now would be granted: today on a weekday before 4:00pm New York time,
    otherwise the next weekday (exchange holidays are not modeled)."""
    now = pd.Timestamp.now(tz="America/New_York") if now is None else pd.Timestamp(now)
    d = now.tz_localize(None).normalize() if now.tzinfo else now.normalize()
    if d.weekday() < 5 and now.hour < 16:
        return d
    return d + pd.offsets.BDay(1)


def mid_price(row) -> tuple[float, bool]:
    bid, ask, last = (float(row.get(k, np.nan) or np.nan) for k in ("bid", "ask", "lastPrice"))
    if np.isfinite(bid) and np.isfinite(ask) and bid > 0 and ask > 0:
        return (bid + ask) / 2, False
    return (last if np.isfinite(last) else np.nan), True


def nearest(df: pd.DataFrame, target: float, side: str = "any") -> pd.Series | None:
    d = df
    eps = 1e-6 * max(1.0, abs(target))          # 100 x 1.10 is 110.00000000000001: keep the 110 strike
    if side == "at_or_above":
        d = df[df["strike"] >= target - eps]
    elif side == "at_or_below":
        d = df[df["strike"] <= target + eps]
    if d.empty:
        return None
    return d.iloc[(d["strike"] - target).abs().argsort().iloc[0]]


def delta_pick(calls: pd.DataFrame, S: float, T: float, target: float = 0.20) -> pd.Series | None:
    """Out of the money call whose Black Scholes delta (at its own implied volatility) is closest to `target`."""
    iv = calls["impliedVolatility"].astype(float)
    c = calls[(calls["strike"] > S) & (calls["strike"] <= 3 * S) & (iv > 0.01) & (iv < 3.0)]
    if c.empty or T <= 0:
        return None
    d = np.array([bs_delta(S, float(k), T, float(v)) for k, v in zip(c["strike"], c["impliedVolatility"], strict=True)])
    return c.iloc[int(np.argmin(np.abs(d - target)))]


def strategies(S: float, prior_close: float, shares: int, calls: pd.DataFrame, puts: pd.DataFrame,
               days: int, coverages=(0.25, 0.5, 1.0)) -> pd.DataFrame:
    """One row per (strategy, strike, coverage): premium, sale price, protection, upside cap, tax flags."""
    calls, puts = price_bounds(calls, puts, S)
    T = max(days, 0) / 365.0
    strikes = calls["strike"].tolist()
    picks = []
    for lab, x, side in (("call 5% OTM", 1.05, "at_or_above"), ("call 10% OTM", 1.10, "at_or_above"),
                         ("call 15% OTM", 1.15, "at_or_above"), ("call 10% ITM", 0.90, "at_or_below")):
        row = nearest(calls, S * x, side)
        if row is not None:
            picks.append((lab, row))
    d20 = delta_pick(calls, S, T, 0.20)
    if d20 is not None:
        picks.insert(0, ("call 0.20 delta", d20))
    put = nearest(puts, S * 0.90, "at_or_below")
    rows = []
    for lab, row in picks:
        K = float(row["strike"])
        p, stale = mid_price(row)
        iv = float(row.get("impliedVolatility", np.nan) or np.nan)
        intrinsic = max(0.0, S - K)
        q = qualified_covered_call(strikes, prior_close, days, K)
        for cov in coverages:
            contracts = int(shares * cov // 100)
            if contracts == 0:
                continue
            rows.append({"strategy": "covered call", "label": lab, "strike": K, "coverage": cov, "contracts": contracts,
                         "premium_per_share": p, "premium_total": p * 100 * contracts,
                         "intrinsic": intrinsic, "time_value": p - intrinsic if np.isfinite(p) else np.nan,
                         "sale_price_if_assigned": K + p, "downside_breakeven": S - p,
                         "upside_capped_above": K,
                         "delta": bs_delta(S, K, T, iv) if np.isfinite(iv) else np.nan, "iv": iv,
                         "stock_equivalent_shares": shares - (bs_delta(S, K, T, iv) if np.isfinite(iv) else 1.0) * 100 * contracts,
                         "qualified_covered_call": q["qualified"], "tax_notes": "; ".join(q["notes"]),
                         "quote": "last trade" if stale else "mid"})
    if put is not None:
        P = float(put["strike"])
        q, stale = mid_price(put)
        for cov in coverages:
            contracts = int(shares * cov // 100)
            if contracts == 0:
                continue
            rows.append({"strategy": "protective put", "label": "put 10% OTM", "strike": P, "coverage": cov,
                         "contracts": contracts, "premium_per_share": -q, "premium_total": -q * 100 * contracts,
                         "floor_per_share": P - q, "upside_breakeven": S + q,
                         "iv": float(put.get("impliedVolatility", np.nan) or np.nan),
                         "quote": "last trade" if stale else "mid", "tax_notes": ""})
        call10 = nearest(calls, S * 1.10, "at_or_above")
        if call10 is not None:
            K = float(call10["strike"])
            c, stale_c = mid_price(call10)
            net = c - q
            qc = qualified_covered_call(strikes, prior_close, days, K)
            for cov in coverages:
                contracts = int(shares * cov // 100)
                if contracts == 0:
                    continue
                rows.append({"strategy": "collar", "label": "collar put 10% / call 10%", "strike": f"{P:g}/{K:g}",
                             "coverage": cov, "contracts": contracts, "premium_per_share": net,
                             "premium_total": net * 100 * contracts, "floor_per_share": P + net,
                             "sale_price_if_assigned": K + net, "upside_capped_above": K,
                             "quote": "last trade" if (stale or stale_c) else "mid",
                             "qualified_covered_call": qc["qualified"],
                             "tax_notes": "; ".join(qc["notes"] + ["review constructive sale rules (IRC 1259) for tight collars"])})
    return pd.DataFrame(rows)


def payoff_at_expiry(S: float, shares: int, st: pd.DataFrame, moves=(-0.3, -0.2, -0.1, 0.0, 0.1, 0.2, 0.3)) -> pd.DataFrame:
    """Profit or loss versus today's value of the whole position (shares plus options) at expiration."""
    out = []
    for m in moves:
        ST = S * (1 + m)
        row = {"move": m, "hold": shares * (ST - S)}
        for r in st.itertuples():
            n = 100 * r.contracts
            if r.strategy == "covered call":
                v = shares * (ST - S) + n * (r.premium_per_share - max(0.0, ST - r.strike))
            elif r.strategy == "protective put":
                v = shares * (ST - S) + n * (r.premium_per_share + max(0.0, r.strike - ST))
            else:
                P, K = (float(x) for x in str(r.strike).split("/"))
                v = shares * (ST - S) + n * (r.premium_per_share + max(0.0, P - ST) - max(0.0, ST - K))
            row[f"{r.label} @ {r.coverage:.0%}"] = v
        out.append(row)
    return pd.DataFrame(out)


def next_day_estimate(S: float, shares: int, st: pd.DataFrame, days: int, moves=(-0.1, 0.1)) -> pd.DataFrame:
    """Black Scholes estimate of the position's change if the stock moves tomorrow (implied volatility unchanged)."""
    T0, T1 = max(days, 0) / 365.0, max(days - 1, 0) / 365.0
    out = []
    for m in moves:
        S1 = S * (1 + m)
        row = {"move": m, "hold": shares * (S1 - S)}
        for r in st[st["strategy"] == "covered call"].itertuples():
            if not np.isfinite(r.iv):
                continue
            dc = bs_price(S1, r.strike, T1, r.iv) - bs_price(S, r.strike, T0, r.iv)
            row[f"{r.label} @ {r.coverage:.0%}"] = shares * (S1 - S) - 100 * r.contracts * dc
        out.append(row)
    return pd.DataFrame(out)


def price_bounds(calls: pd.DataFrame, puts: pd.DataFrame, S: float) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Drop quotes no standard contract can have: a call worth more than the share, a put worth more than
    its strike. Live, Yahoo listed NFLX contracts adjusted for the 10 for 1 split under standard symbols
    (2027-01-15 270 strike call bid $953 with the stock at $62.08); their deliverable is not 100 shares."""
    def mids(df):
        return pd.Series([mid_price(r)[0] for _, r in df.iterrows()], index=df.index, dtype=float)
    if len(calls):
        calls = calls[~(mids(calls) > S)]
    if len(puts):
        puts = puts[~(mids(puts) > puts["strike"].astype(float))]
    return calls, puts


def standard_contracts(df: pd.DataFrame, ticker: str) -> pd.DataFrame:
    """Keep standard contracts (symbol = ticker, yymmdd, C or P, strike x 1000 in 8 digits). Contracts adjusted
    for a split or merger often carry another root and have a different deliverable. If no symbol matches
    (unusual roots), keep everything. Yahoo does not always change the symbol (live NFLX case), so
    `price_bounds` and the limits in `delta_pick` are the second line of defense."""
    if "contractSymbol" not in df or df.empty:
        return df
    ok = df["contractSymbol"].astype(str).str.fullmatch(rf"{re.escape(ticker.upper())}\d{{6}}[CP]\d{{8}}")
    return df[ok].copy() if ok.any() else df


def chain(ticker: str, expiry: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    from .data import yahoo
    oc = yahoo._yf().Ticker(ticker).option_chain(expiry)
    return standard_contracts(oc.calls, ticker), standard_contracts(oc.puts, ticker)


def expirations(ticker: str) -> list[str]:
    from .data import yahoo
    return list(yahoo._yf().Ticker(ticker).options or [])


def pick_expirations(exps: list[str], today: pd.Timestamp, next_earnings=None) -> list[str]:
    """Up to two expirations, counted from `today` (the day the call would be written):
    the last one before the next report (at least a week out), and the first one after the report
    that is more than 30 days out, so a qualified covered call is always among the choices.
    Without a report date: the first more than 30 days out and the first at least 60 days out."""
    ds = sorted(pd.Timestamp(e) for e in exps)
    q = today + pd.Timedelta(days=31)
    out = []
    if next_earnings is not None and pd.notna(next_earnings):
        E = pd.Timestamp(next_earnings)
        before = [d for d in ds if today + pd.Timedelta(days=7) <= d < E]
        after = [d for d in ds if d > E and d >= q]
        out = ([before[-1]] if before else []) + ([after[0]] if after else [])
    if not out:
        a = [d for d in ds if d >= q]
        b = [d for d in ds if d >= today + pd.Timedelta(days=60)]
        out = ([a[0]] if a else []) + ([b[0]] if b and (not a or b[0] != a[0]) else [])
    return [d.strftime("%Y-%m-%d") for d in out]

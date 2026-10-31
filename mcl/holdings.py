"""Holdings monitor: python -m mcl holdings [TICKER ...] [--options]

Reads the user's positions and prints, per holding and for the portfolio, what
the position is worth, how much profit has been given back versus a budget,
how far a losing position is from its cost, the earnings and gap risk ahead,
moving average streak context, and (with --options) the complete payoffs of
covered calls, puts and collars from today's option chain.

Inputs (both stay on the user's machine; data/user/ files are git-ignored):
* data/user/holdings.csv with columns ticker, shares, cost (per share), and
  optional option_income (premium collected, from the user's records),
  acquired (YYYY-MM-DD, for tax term), willing_to_sell (0 to 1); or
* a CSV download of a "Position" sheet laid out with tickers across row 1 and
  the rows "Price Paid", "Quantity" and "Option Profit" (Google Sheets: File,
  Download, Comma separated values, current sheet), passed with --position-csv.

Nothing here recommends an action. Each number is labeled: position math and
prices are facts; outcome statistics are historical associations with their
sample sizes; option values before expiration are model estimates.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from .config import USER_DIR

DEFAULT_GIVEBACK = 0.25     # share of the peak unrealized gain the user accepts giving back
DEFAULT_WINDOW = 63         # sessions over which the peak is measured (about 3 months)


# ---------------------------------------------------------------- input
def parse_number(x) -> float:
    s = str(x).strip().replace(",", "").replace("$", "")
    if s in ("", "-", "#VALUE!", "#N/A", "#REF!", "#DIV/0!", "nan", "None"):
        return np.nan
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()").rstrip("%")
    try:
        v = float(s)
    except ValueError:
        return np.nan
    return -v if neg else v


def _from_position_layout(raw: pd.DataFrame) -> pd.DataFrame:
    header = raw.iloc[0].tolist()
    cols = []
    for j, v in enumerate(header[1:], start=1):
        v = str(v).strip()
        if v.lower() == "total":
            break
        if v:
            cols.append((j, v.upper()))
    label = {str(raw.iloc[i, 0]).strip().lower(): i for i in range(len(raw))}
    for need in ("quantity", "price paid"):
        if need not in label:
            raise ValueError(f"Position layout: row '{need}' not found in the first column")
    rows = []
    for j, t in cols:
        shares = parse_number(raw.iloc[label["quantity"], j])
        if not np.isfinite(shares) or shares <= 0:
            continue
        rows.append({"ticker": t, "shares": shares, "cost": parse_number(raw.iloc[label["price paid"], j]),
                     "option_income": parse_number(raw.iloc[label["option profit"], j]) if "option profit" in label else np.nan})
    return pd.DataFrame(rows)


def read_holdings(path: str | Path) -> pd.DataFrame:
    raw = pd.read_csv(path, header=None, dtype=str, keep_default_na=False)
    first = [str(x).strip().lower() for x in raw.iloc[0]]
    if "ticker" in first:
        df = pd.read_csv(path, dtype=str, keep_default_na=False)
        df.columns = [c.strip().lower() for c in df.columns]
        out = pd.DataFrame({"ticker": df["ticker"].str.strip().str.upper(),
                            "shares": df["shares"].map(parse_number),
                            "cost": df["cost"].map(parse_number) if "cost" in df else np.nan})
        for c in ("option_income", "willing_to_sell"):
            out[c] = df[c].map(parse_number) if c in df else np.nan
        out["acquired"] = pd.to_datetime(df["acquired"], errors="coerce") if "acquired" in df else pd.NaT
        out = out[out["shares"] > 0]
    elif any(str(x).strip().lower() == "quantity" for x in raw.iloc[:, 0]):
        out = _from_position_layout(raw)
        out["willing_to_sell"] = np.nan
        out["acquired"] = pd.NaT
    else:
        raise ValueError(f"{path}: expected a 'ticker' column or a Position layout with a 'Quantity' row")
    out = out[out["ticker"].str.match(r"^[A-Z][A-Z0-9.\-]{0,9}$")]
    return out.groupby("ticker", as_index=False).agg(
        shares=("shares", "sum"), cost=("cost", "first"), option_income=("option_income", "first"),
        acquired=("acquired", "min"), willing_to_sell=("willing_to_sell", "first"))


def default_path() -> Path:
    return USER_DIR / "holdings.csv"


# ---------------------------------------------------------------- per position
def giveback(close: pd.Series, cost: float, budget: float = DEFAULT_GIVEBACK, window: int = DEFAULT_WINDOW) -> dict:
    """Profit given back from the highest close in the window, per share (today's share count assumed throughout)."""
    c = close.dropna()
    price = float(c.iloc[-1])
    w = c.tail(window)
    peak = float(w.max())
    out = {"window": window, "peak_close": peak, "peak_date": w.idxmax(), "budget": budget}
    if not np.isfinite(cost) or peak <= cost:
        out["applies"] = False
        return out
    peak_gain = peak - cost
    used = max(0.0, (peak - price) / peak_gain)
    floor = peak - budget * peak_gain
    out.update({"applies": True, "peak_gain_per_share": peak_gain, "given_back_share": used,
                "floor_price": floor, "room_to_floor_pct": price / floor - 1.0, "budget_used_up": price < floor,
                "stock_from_peak_pct": price / peak - 1.0})
    return out


def recovery(close: pd.Series, cost: float, effective_cost: float | None = None) -> dict:
    """Distance to cost, and how past drawdowns at least this deep (from the running high) resolved."""
    c = close.dropna()
    v = c.to_numpy(float)
    price = v[-1]
    hwm = np.maximum.accumulate(v)
    dd = v / hwm - 1.0
    depth = float(dd[-1])
    out = {"from_high_pct": depth, "high": float(hwm[-1]),
           "high_date": c.index[int(np.flatnonzero(v == hwm[-1])[-1])] if len(v) else None,
           "rally_to_cost_pct": cost / price - 1.0 if np.isfinite(cost) else np.nan,
           "rally_to_effective_cost_pct": (effective_cost / price - 1.0) if effective_cost and np.isfinite(effective_cost) else np.nan}
    if depth > -0.05:
        out["episodes"] = None
        return out
    # completed underwater episodes (new high reached) and whether each reached today's depth
    reached, rec_bars = 0, []
    i, n = 0, len(v)
    while i < n:
        if dd[i] < 0:
            start = i
            while i < n and dd[i] < 0:
                i += 1
            if i >= n:                      # the current episode: excluded
                break
            seg = dd[start:i]
            hit = np.flatnonzero(seg <= depth)
            if len(hit):
                reached += 1
                rec_bars.append(i - (start + hit[0]))
        i += 1
    out["episodes"] = {"n_reached": reached, "median_sessions_to_new_high": float(np.median(rec_bars)) if rec_bars else np.nan,
                       "share_within_250": float(np.mean(np.array(rec_bars) <= 250)) if rec_bars else np.nan}
    return out


def earnings_risk(prices: pd.DataFrame, earnings: pd.DataFrame | None, as_of: pd.Timestamp) -> dict:
    from .analytics import earnings as em
    out = {"next_date": None, "sessions_to": None, "n": 0}
    if earnings is None or earnings.empty:
        return out
    e = earnings.copy()
    e["date"] = pd.to_datetime(e["date"])
    if "kind" in e:
        e = e[e["kind"].fillna("report") == "report"]
    fut = e[e["date"] > as_of]
    if len(fut):
        nd = fut.iloc[0]
        out["next_date"] = nd["date"]
        # Yahoo stamps unconfirmed future dates with a placeholder time that classifies as during market hours
        t = str(nd.get("timing", "")).lower()
        out["next_timing"] = {"bmo": "before the open", "amc": "after the close"}.get(t, "time not confirmed")
        out["sessions_to"] = int(np.busday_count(as_of.date(), nd["date"].date()))
    past = e[e["date"] <= as_of]
    if len(past) < 2:
        return out
    tab, _ = em.event_study(prices, past)
    if tab.empty:
        return out
    r = tab["day0"].dropna()
    out.update({"n": len(r), "p10_reaction": float(r.quantile(0.1)), "p90_reaction": float(r.quantile(0.9)),
                "median_abs_reaction": float(r.abs().median()), "worst_reaction": float(r.min()),
                "worst_reaction_date": tab.loc[r.idxmin(), "report_date"]})
    return out


def position_card(h: pd.Series, prices: pd.DataFrame, earnings: pd.DataFrame | None,
                  budget: float = DEFAULT_GIVEBACK, window: int = DEFAULT_WINDOW) -> dict:
    from .analytics import streaks
    close = prices["close"].dropna()
    as_of = close.index[-1]
    price = float(close.iloc[-1])
    shares, cost = float(h["shares"]), float(h["cost"]) if pd.notna(h.get("cost")) else np.nan
    oi = float(h["option_income"]) if pd.notna(h.get("option_income")) else np.nan
    eff = cost - oi / shares if np.isfinite(cost) and np.isfinite(oi) else np.nan
    card = {"ticker": h["ticker"], "as_of": as_of, "price": price, "shares": shares, "cost": cost, "value": shares * price,
            "unrealized": shares * (price - cost) if np.isfinite(cost) else np.nan,
            "unrealized_pct": price / cost - 1.0 if np.isfinite(cost) and cost > 0 else np.nan,
            "option_income": oi, "effective_cost": eff,
            "acquired": h.get("acquired"), "willing_to_sell": h.get("willing_to_sell"),
            "history_start": close.index[0]}
    acq = h.get("acquired")
    if acq is not None and pd.notna(acq):
        card["tax_term"] = "long term" if (as_of - pd.Timestamp(acq)).days > 365 else "short term"
    else:
        card["tax_term"] = "unknown (no purchase date)"
    gb = giveback(close, cost, budget, window)
    card["giveback"] = gb
    card["recovery"] = recovery(close, cost, eff)
    er = earnings_risk(prices, earnings, as_of)
    card["earnings"] = er
    if gb.get("applies"):
        room = shares * max(0.0, price - gb["floor_price"])
        card["budget_room_dollars"] = room
        if er.get("n", 0) >= 8:
            card["p10_night_loss"] = card["value"] * min(0.0, er["p10_reaction"])
            card["p10_night_uses_budget"] = -card["p10_night_loss"] > room
    card["streaks"] = {n: streaks.streak_stats(close, n, horizons=(5, 10)) for n in (20, 50, 200)}
    return card


# ---------------------------------------------------------------- portfolio
def portfolio(cards: list[dict], closes: pd.DataFrame, spy: pd.Series | None, smh: pd.Series | None,
              lookback: int = 504) -> dict:
    df = pd.DataFrame([{k: c[k] for k in ("ticker", "shares", "price", "value", "cost", "unrealized", "option_income")}
                       for c in cards])
    total = float(df["value"].sum())
    df["weight"] = df["value"] / total if total else np.nan
    out = {"positions": df.sort_values("value", ascending=False), "total_value": total,
           "total_cost": float((df["shares"] * df["cost"]).sum(min_count=1)),
           "total_unrealized": float(df["unrealized"].sum(min_count=1)),
           "total_option_income": float(df["option_income"].sum(min_count=1))}
    # earnings in the next 10 sessions
    soon = [(c["ticker"], c["earnings"]["next_date"], c["earnings"]["sessions_to"], c["value"]) for c in cards
            if c["earnings"].get("sessions_to") is not None and c["earnings"]["sessions_to"] <= 10]
    out["earnings_next_10"] = sorted(soon, key=lambda x: x[2])
    out["earnings_next_10_share"] = sum(x[3] for x in soon) / total if total else np.nan
    # historical stress with today's shares
    # names listed inside the window are left out (and named) so one new listing cannot shorten the replay
    sh = df.set_index("ticker")["shares"]
    px = closes[sh.index.intersection(closes.columns)].tail(lookback).ffill()
    first = px.apply(lambda c: c.first_valid_index())
    late = [t for t in px.columns if first[t] is None or first[t] > px.index[0]]
    if len(late) == px.shape[1]:
        late = []
    keep = [t for t in px.columns if t not in late]
    pv = (px[keep] * sh.reindex(keep)).sum(axis=1, min_count=1)
    pv = pv[px[keep].notna().all(axis=1)]
    if len(pv) > 25:
        r1 = pv.pct_change().dropna()
        r20 = (pv / pv.shift(20) - 1).dropna()
        vals = df.set_index("ticker")["value"]
        out["stress"] = {"start": pv.index[0], "end": pv.index[-1], "worst_day": float(r1.min()), "worst_day_date": r1.idxmin(),
                         "worst_20": float(r20.min()), "worst_20_end": r20.idxmin(),
                         "max_drawdown": float((pv / pv.cummax() - 1).min()),
                         "names": len(keep), "of": int(px.shape[1]), "excluded": late,
                         "excluded_share": float(vals.reindex(late).sum() / total) if late and total else 0.0}
    # betas and downside co-movement
    rets = closes.pct_change().tail(252)
    betas = {}
    for ref_name, ref in (("SPY", spy), ("SMH", smh)):
        if ref is None:
            continue
        rr = ref.pct_change().reindex(rets.index)
        var = rr.var()
        betas[ref_name] = {t: float(rets[t].cov(rr) / var) for t in rets.columns if rets[t].notna().sum() > 120 and var > 0}
    out["betas"] = betas
    if betas.get("SPY"):
        out["scenario_market_minus10"] = sum(c["value"] * betas["SPY"].get(c["ticker"], 1.0) * -0.10 for c in cards)
    if betas.get("SMH"):
        out["scenario_semis_minus20"] = sum(c["value"] * betas["SMH"].get(c["ticker"], 0.0) * -0.20 for c in cards)
    if spy is not None:
        cr = closes.pct_change().tail(lookback)
        down = (spy.pct_change().reindex(cr.index) < -0.01).fillna(False)
        rd = cr[down]
        top = list(df.sort_values("value", ascending=False)["ticker"].head(15))
        cm = rd[[t for t in top if t in rd]].corr(min_periods=20)
        pairs = []
        for i, a in enumerate(cm.columns):
            for b in cm.columns[i + 1:]:
                v = cm.loc[a, b]
                if np.isfinite(v) and v >= 0.7:
                    pairs.append((a, b, float(v)))
        out["down_day_pairs"] = sorted(pairs, key=lambda x: -x[2])
        out["down_days"] = int(down.sum())
    return out


# ---------------------------------------------------------------- report
def _pct(x, digits=1, sign=True) -> str:
    if x is None or not np.isfinite(x):
        return "n/a"
    s = f"{abs(x) * 100:.{digits}f}%"
    return ("+" if x > 0 else "−" if x < 0 else "") + s if sign else s


def _usd(x, digits=0) -> str:
    if x is None or not np.isfinite(x):
        return "n/a"
    return ("−" if x < 0 else "") + f"${abs(x):,.{digits}f}"


def render_card(c: dict) -> str:
    L = [f"### {c['ticker']}  {_usd(c['price'], 2)} on {c['as_of'].date()}"]
    L.append(f"* Position: {c['shares']:,.0f} shares, cost {_usd(c['cost'], 2)}, value {_usd(c['value'])}, "
             f"unrealized {_usd(c['unrealized'])} ({_pct(c['unrealized_pct'])}); tax term {c['tax_term']}")
    if np.isfinite(c.get("option_income", np.nan)):
        L.append(f"* Option income recorded {_usd(c['option_income'])}; cost after that income {_usd(c['effective_cost'], 2)} per share")
    g = c["giveback"]
    below_cost = np.isfinite(c["cost"]) and c["price"] < c["cost"]
    if g.get("applies"):
        state = "BUDGET USED UP" if g["budget_used_up"] else "within budget"
        side = "above" if g["room_to_floor_pct"] >= 0 else "below"
        given = (f"profit given back {_pct(g['given_back_share'], 0, False)} of the peak gain" if not below_cost else
                 f"the whole peak gain of {_usd(g['peak_gain_per_share'], 2)} per share is gone and the stock is below cost")
        L.append(f"* Giveback: highest close in {g['window']} sessions {_usd(g['peak_close'], 2)} ({g['peak_date'].date()}); "
                 f"stock {_pct(g['stock_from_peak_pct'])} from it; {given}. Budget {_pct(g['budget'], 0, False)} ends at "
                 f"{_usd(g['floor_price'], 2)}, price {_pct(abs(g['room_to_floor_pct']), 1, False)} {side} it: {state}")
        if "p10_night_loss" in c:
            bad = (f"a 1 in 10 bad reaction ({_pct(c['earnings']['p10_reaction'])}, from {c['earnings']['n']} reports) "
                   f"= {_usd(c['p10_night_loss'])}")
            if c["budget_room_dollars"] <= 0:
                L.append(f"* One night earnings risk: budget already used up; {bad} more")
            else:
                uses = "would use up" if c["p10_night_uses_budget"] else "would not use up"
                L.append(f"* One night earnings risk: {bad}, which {uses} the {_usd(c['budget_room_dollars'])} of budget room left")
    if not g.get("applies") or below_cost:
        rec = c["recovery"]
        line = f"* Recovery: {_pct(rec['from_high_pct'])} from the high {_usd(rec['high'], 2)}"
        if rec.get("high_date") is not None:
            line += f" ({pd.Timestamp(rec['high_date']).date()})"
        line += f"; rally needed to cost {_pct(rec['rally_to_cost_pct'])}"
        if np.isfinite(rec.get("rally_to_effective_cost_pct", np.nan)):
            line += f", to cost after option income {_pct(rec['rally_to_effective_cost_pct'])}"
        L.append(line)
        ep = rec.get("episodes")
        if ep:
            if ep["n_reached"] == 0:
                L.append(f"  * No completed drawdown since {c['history_start'].date()} reached this depth: no comparable cases")
            else:
                L.append(f"  * Past drawdowns that reached this depth and later made a new high: {ep['n_reached']}; "
                         f"median {ep['median_sessions_to_new_high']:.0f} sessions from this depth to the new high; "
                         f"{_pct(ep['share_within_250'], 0, False)} within 250 sessions (association; ongoing drawdowns excluded, "
                         f"so this overstates recovery)")
    e = c["earnings"]
    if e.get("next_date") is not None:
        k = e["sessions_to"]
        L.append(f"* Next report {pd.Timestamp(e['next_date']).date()} ({e.get('next_timing', 'time not confirmed')}), "
                 f"{k} session{'s' if k != 1 else ''} away (date from Yahoo; confirm with the company)")
    if e.get("n", 0) >= 8:
        L.append(f"* Past reactions ({e['n']} reports): median size {_pct(e['median_abs_reaction'], 1, False)}, "
                 f"1 in 10 worst {_pct(e['p10_reaction'])}, 1 in 10 best {_pct(e['p90_reaction'])}, "
                 f"worst {_pct(e['worst_reaction'])} ({pd.Timestamp(e['worst_reaction_date']).date()})")
    elif e.get("n", 0):
        L.append(f"* Past reactions: only {e['n']} reports, too few for a distribution")
    for n, s in c["streaks"].items():
        if not s.get("streak"):
            continue
        h = s.get("h5", {})
        rare = s.get("share_reaching_today")
        line = (f"* {n} day average: {s['side']} for {s['streak']} session{'s' if s['streak'] != 1 else ''}, "
                f"{_pct(s['distance_pct'] / 100)} from it")
        if rare is not None and np.isfinite(rare):
            line += f"; {_pct(rare, 0, False)} of past {s['side']} streaks lasted this long (max {s['max_len']})"
        if h.get("n", 0) >= 10:
            line += (f"; next 5 sessions after those {h['n']}: median {_pct(h['median_ret_pct'] / 100)} "
                     f"(all {s['side']} days {_pct(h['base_median_ret_pct'] / 100)}), drop bigger than a typical move "
                     f"{_pct(h['pct_drop_gt_typical'] / 100, 0, False)} (all days {_pct(h['base_pct_drop_gt_typical'] / 100, 0, False)})")
        elif h.get("n") is not None:
            line += f"; {h['n']} comparable streaks, too few"
        L.append(line)
    return "\n".join(L)


def render_portfolio(p: dict, budget: float, window: int) -> str:
    L = ["## Portfolio",
         f"* Value {_usd(p['total_value'])}; cost {_usd(p['total_cost'])}; unrealized {_usd(p['total_unrealized'])}; "
         f"option income recorded {_usd(p['total_option_income'])}",
         f"* Giveback budget used for every position: {_pct(budget, 0, False)} of the peak gain over {window} sessions "
         f"(default; set with --giveback and --window)"]
    top = p["positions"].head(10)
    L.append("* Largest positions: " + ", ".join(f"{r.ticker} {_pct(r.weight, 1, False)}" for r in top.itertuples()))
    if p["earnings_next_10"]:
        L.append(f"* Reporting in the next 10 sessions ({_pct(p['earnings_next_10_share'], 0, False)} of value): " +
                 ", ".join(f"{t} {pd.Timestamp(d).date()}" for t, d, _, _ in p["earnings_next_10"]))
    s = p.get("stress")
    if s:
        names = (f"{s['names']} of {s['of']} names (left out, listed less than 2 years ago: {', '.join(s['excluded'])}; "
                 f"{_pct(s['excluded_share'], 1, False)} of value)" if s.get("excluded") else f"all {s['names']} names")
        L.append(f"* Today's shares of {names}, held from {s['start'].date()} to "
                 f"{s['end'].date()}: worst day {_pct(s['worst_day'])} ({s['worst_day_date'].date()}), worst 20 sessions "
                 f"{_pct(s['worst_20'])} (to {s['worst_20_end'].date()}), largest drawdown {_pct(s['max_drawdown'])}")
    if "scenario_market_minus10" in p:
        L.append(f"* Linear estimates from 1 year betas (selloffs are often worse): market −10% = "
                 f"{_usd(p['scenario_market_minus10'])}; SMH −20% = {_usd(p.get('scenario_semis_minus20', np.nan))}")
    if p.get("down_day_pairs"):
        L.append(f"* Among the 15 largest positions, pairs that moved together on the {p['down_days']} days SPY fell more "
                 f"than 1% (correlation 0.7 or more): " + ", ".join(f"{a}/{b} {v:.2f}" for a, b, v in p["down_day_pairs"][:12]))
    return "\n".join(L)


def render_options(ticker: str, S: float, shares: float, expiry: str, days: int, st: pd.DataFrame,
                   pay: pd.DataFrame, nd: pd.DataFrame, note: str = "") -> str:
    L = [f"#### {ticker} options expiring {expiry} ({days} days); stock {_usd(S, 2)}; {int(shares)} shares",
         "Covered calls are written against shares already owned. Prices are bid/ask midpoints from Yahoo "
         "(\"last trade\" where no live quote). Before expiration values are model estimates. " + note]
    cc = st[st["strategy"] == "covered call"]
    if len(cc):
        L.append("| Call | Strike | Coverage | Contracts | Premium | Of which time value | Sale price if assigned | "
                 "Breakeven if the stock falls | Delta | Shares of exposure left | Qualified covered call | Notes |")
        L.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for r in cc.itertuples():
            L.append(f"| {r.label} | {r.strike:g} | {r.coverage:.0%} | {r.contracts} | {_usd(r.premium_total)} "
                     f"({_usd(r.premium_per_share, 2)}/sh, {r.quote}) | {_usd(r.time_value, 2)}/sh | {_usd(r.sale_price_if_assigned, 2)} | "
                     f"{_usd(r.downside_breakeven, 2)} | {r.delta:.2f} | {r.stock_equivalent_shares:,.0f} | "
                     f"{'yes' if r.qualified_covered_call else 'no'} | {r.tax_notes} |")
    other = st[st["strategy"] != "covered call"]
    if len(other):
        L.append("| Choice | Strike | Coverage | Contracts | Net premium | Floor per share | Notes |")
        L.append("|---|---|---|---|---|---|---|")
        for r in other.itertuples():
            L.append(f"| {r.label} | {r.strike} | {r.coverage:.0%} | {r.contracts} | {_usd(r.premium_total)} | "
                     f"{_usd(r.floor_per_share, 2)} | {r.tax_notes} |")
    full = " @ 100%"
    cols = ["hold"] + [c for c in pay.columns if c not in ("move", "hold") and c.endswith(full)]
    L.append("At expiration, profit or loss versus today for the whole position, calls and puts on every share "
             "(100% coverage); hold = shares only:")
    L.append("| Stock move | " + " | ".join(c.removesuffix(full) for c in cols) + " |")
    L.append("|---|" + "---|" * len(cols))
    for m in pay["move"]:
        L.append(f"| {_pct(m, 0)} | " + " | ".join(_usd(pay.loc[pay["move"] == m, c].iloc[0]) for c in cols) + " |")
    if not nd.empty:
        cols2 = [c for c in nd.columns if c != "move" and (c == "hold" or c.endswith(full))]
        L.append("If the stock moves tomorrow (model estimate, implied volatility unchanged), 100% coverage:")
        L.append("| Move | " + " | ".join(c.removesuffix(full) for c in cols2) + " |")
        L.append("|---|" + "---|" * len(cols2))
        for m in nd["move"]:
            L.append(f"| {_pct(m, 0)} | " + " | ".join(_usd(nd.loc[nd['move'] == m, c].iloc[0]) for c in cols2) + " |")
    return "\n".join(L)


def option_panel(ticker: str, card: dict, close: pd.Series | None = None, grant: pd.Timestamp | None = None) -> str:
    from . import options as op
    S, shares = card["price"], card["shares"]
    if shares < 100:
        return f"#### {ticker}: fewer than 100 shares, no contracts to write"
    try:
        exps = op.expirations(ticker)
    except Exception as e:
        return f"#### {ticker}: option chain unavailable ({e})"
    if not exps:
        return f"#### {ticker}: no listed options"
    grant = op.grant_date() if grant is None else pd.Timestamp(grant)
    prior, prior_date = S, pd.Timestamp(card["as_of"])
    if close is not None:
        before = close.dropna()
        before = before[before.index < grant]
        if len(before):
            prior, prior_date = float(before.iloc[-1]), before.index[-1]
    note = (f"Days are counted from {grant.date()}, the day a call written now would be granted. The qualified covered "
            f"call test uses the {prior_date.date()} close {_usd(prior, 2)}; if the stock opens more than 10% above it, "
            f"that day's open applies instead (IRC 1092(c)(4)(G)).")
    out = []
    for ex in op.pick_expirations(exps, grant, card["earnings"].get("next_date")):
        try:
            calls, puts = op.chain(ticker, ex)
        except Exception as e:
            out.append(f"#### {ticker} {ex}: chain unavailable ({e})")
            continue
        days = int((pd.Timestamp(ex) - grant).days)
        st = op.strategies(S, prior, int(shares), calls, puts, days)
        if st.empty:
            continue
        pay = op.payoff_at_expiry(S, int(shares), st)
        nd = op.next_day_estimate(S, int(shares), st, days)
        out.append(render_options(ticker, S, shares, ex, days, st, pay, nd, note))
    return "\n\n".join(out) if out else f"#### {ticker}: no usable expirations"


# ---------------------------------------------------------------- run
def load_market_data(tickers: list[str]) -> dict:
    from .config import SEC_USER_AGENT
    from .data import loader, sec, yahoo
    data = {}
    for t in tickers:
        d = {"notes": []}
        try:
            d["prices"] = loader.get_prices(t)
        except Exception as e:
            d["notes"].append(f"prices unavailable: {e}")
            data[t] = d
            continue
        try:
            y = yahoo.earnings_dates(t)
        except Exception:
            y = None
        try:
            d["earnings"] = sec.merge_earnings(sec.earnings_releases(t), y) if SEC_USER_AGENT else y
        except Exception as e:
            d["earnings"] = y
            d["notes"].append(f"SEC dates unavailable ({e}); Yahoo only")
        data[t] = d
    return data


def run(path: str | Path | None = None, position_csv: str | Path | None = None, tickers: list[str] | None = None,
        with_options: bool = False, budget: float = DEFAULT_GIVEBACK, window: int = DEFAULT_WINDOW) -> str:
    from .data import loader
    src = position_csv or path or default_path()
    if not Path(src).exists():
        raise FileNotFoundError(f"{src} not found. Create data/user/holdings.csv (ticker,shares,cost,...) or pass "
                                f"--position-csv with a CSV download of the Position sheet.")
    h = read_holdings(src)
    if tickers:
        h = h[h["ticker"].isin([t.upper() for t in tickers])]
    data = load_market_data(h["ticker"].tolist())
    cards, skipped = [], []
    for r in h.itertuples(index=False):
        d = data.get(r.ticker, {})
        if "prices" not in d:
            skipped.append(f"{r.ticker} ({'; '.join(d.get('notes', [])) or 'no data'})")
            continue
        cards.append(position_card(pd.Series(r._asdict()), d["prices"], d.get("earnings"), budget, window))
    if not cards:
        return "No holdings with price data."
    closes = pd.DataFrame({c["ticker"]: data[c["ticker"]]["prices"]["close"] for c in cards}).sort_index()
    spy = smh = None
    try:
        spy = loader.get_prices("SPY")["close"]
        smh = loader.get_prices("SMH")["close"]
    except Exception:
        pass
    port = portfolio(cards, closes, spy, smh)
    as_of = max(c["as_of"] for c in cards).date()
    parts = [f"# Holdings monitor, prices through {as_of}",
             "Facts: positions and prices. Associations (with counts): streak and recovery outcomes, reaction ranges. "
             "Model estimates: option values before expiration. Nothing here is a recommendation.",
             render_portfolio(port, budget, window)]
    if skipped:
        parts.append("* Skipped: " + "; ".join(skipped))
    parts.append("## Positions")
    for c in sorted(cards, key=lambda c: -c["value"]):
        parts.append(render_card(c))
        if with_options:
            parts.append(option_panel(c["ticker"], c, data[c["ticker"]]["prices"]["close"]))
    return "\n\n".join(parts)

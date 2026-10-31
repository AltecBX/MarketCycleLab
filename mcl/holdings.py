"""Holdings monitor: python -m mcl holdings [TICKER ...] [--options]

Reads the user's positions and prints, per holding and for the portfolio, what
the position is worth, how much profit has been given back versus a budget,
how far a losing position is from its cost, the earnings and gap risk ahead,
moving average streak context, and (with --options) the complete payoffs of
covered calls, puts and collars from today's option chain.

Input: only the stock symbol, the price paid per share and the number of shares.
* The Position sheet: symbols across row 1 up to "Total", and the rows labeled
  "Price Paid" and "Quantity" in column A. Every other row is ignored. Either a
  CSV download or the Google Sheets values saved as JSON ({"values": [[...]]}).
* Or a simple CSV with columns symbol (or ticker), price paid (or cost) and
  quantity (or shares). Several lots of one symbol are combined at the
  weighted average price.
The repository is public: data/user/ and reports/holdings_*.md are git ignored
and must never be committed.

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


def _raw_table(path: str | Path) -> pd.DataFrame:
    """The file as a grid of strings: CSV, or JSON as Google Sheets returns values."""
    if str(path).lower().endswith(".json"):
        import json
        data = json.loads(Path(path).read_text())
        values = data["values"] if isinstance(data, dict) else data
        width = max(len(r) for r in values)
        return pd.DataFrame([[str(v) for v in r] + [""] * (width - len(r)) for r in values])
    return pd.read_csv(path, header=None, dtype=str, keep_default_na=False)


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
        rows.append({"ticker": t, "shares": shares, "cost": parse_number(raw.iloc[label["price paid"], j])})
    return pd.DataFrame(rows, columns=["ticker", "shares", "cost"])


def _pick(cols: list[str], *names: str) -> int | None:
    for n in names:
        if n in cols:
            return cols.index(n)
    return None


def read_holdings(path: str | Path) -> pd.DataFrame:
    """Columns ticker, shares, cost (price paid per share). Nothing else is read."""
    raw = _raw_table(path)
    first = [str(x).strip().lower() for x in raw.iloc[0]]
    sym = _pick(first, "symbol", "ticker")
    if sym is not None:
        qty, paid = _pick(first, "quantity", "shares"), _pick(first, "price paid", "price_paid", "cost")
        if qty is None or paid is None:
            raise ValueError(f"{path}: needs columns symbol, price paid and quantity")
        body = raw.iloc[1:]
        out = pd.DataFrame({"ticker": body[sym].str.strip().str.upper(),
                            "shares": body[qty].map(parse_number), "cost": body[paid].map(parse_number)})
        out = out[out["shares"] > 0]
    elif any(str(x).strip().lower() == "quantity" for x in raw.iloc[:, 0]):
        out = _from_position_layout(raw)
    else:
        raise ValueError(f"{path}: expected columns symbol, price paid, quantity, or the Position sheet layout")
    out = out[out["ticker"].str.match(r"^[A-Z][A-Z0-9.\-]{0,9}$")].copy()
    out["paid"] = out["shares"] * out["cost"]
    g = out.groupby("ticker", as_index=False).agg(shares=("shares", "sum"), paid=("paid", lambda x: x.sum(min_count=1)))
    g["cost"] = g["paid"] / g["shares"]                      # weighted average price paid across lots
    return g[["ticker", "shares", "cost"]]


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


def recovery(close: pd.Series, cost: float) -> dict:
    """Distance to cost, and how past drawdowns at least this deep (from the running high) resolved."""
    c = close.dropna()
    v = c.to_numpy(float)
    price = v[-1]
    hwm = np.maximum.accumulate(v)
    dd = v / hwm - 1.0
    depth = float(dd[-1])
    out = {"from_high_pct": depth, "high": float(hwm[-1]),
           "high_date": c.index[int(np.flatnonzero(v == hwm[-1])[-1])] if len(v) else None,
           "rally_to_cost_pct": cost / price - 1.0 if np.isfinite(cost) else np.nan}
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
    card = {"ticker": h["ticker"], "as_of": as_of, "price": price, "shares": shares, "cost": cost,
            "paid": shares * cost if np.isfinite(cost) else np.nan, "value": shares * price,
            "unrealized": shares * (price - cost) if np.isfinite(cost) else np.nan,
            "unrealized_pct": price / cost - 1.0 if np.isfinite(cost) and cost > 0 else np.nan,
            "history_start": close.index[0]}
    gb = giveback(close, cost, budget, window)
    card["giveback"] = gb
    card["recovery"] = recovery(close, cost)
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
    df = pd.DataFrame([{k: c[k] for k in ("ticker", "shares", "price", "value", "cost", "unrealized")} for c in cards])
    total = float(df["value"].sum())
    df["weight"] = df["value"] / total if total else np.nan
    out = {"positions": df.sort_values("value", ascending=False), "total_value": total,
           "total_cost": float((df["shares"] * df["cost"]).sum(min_count=1)),
           "total_unrealized": float(df["unrealized"].sum(min_count=1))}
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
    L.append(f"* Bought {c['shares']:,.0f} shares at {_usd(c['cost'], 2)} ({_usd(c['paid'])} paid); worth "
             f"{_usd(c['value'])} now; gain or loss {_usd(c['unrealized'])} ({_pct(c['unrealized_pct'])})")
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
        line += f"; rise needed to get back to the price paid {_pct(rec['rally_to_cost_pct'])}"
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
            line += f"; {h['n']} comparable streak{'' if h['n'] == 1 else 's'}, too few"
        L.append(line)
    return "\n".join(L)


def render_holdings(cards: list[dict]) -> str:
    """What was bought, at what price, how many shares, and what it is worth now."""
    L = ["## Holdings",
         "| Symbol | Shares | Price paid | Paid | Price now | Worth now | Gain or loss | Gain or loss % |",
         "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for c in sorted(cards, key=lambda c: -c["value"]):
        L.append(f"| {c['ticker']} | {c['shares']:,.0f} | {_usd(c['cost'], 2)} | {_usd(c['paid'])} | {_usd(c['price'], 2)} | "
                 f"{_usd(c['value'])} | {_usd(c['unrealized'])} | {_pct(c['unrealized_pct'])} |")
    paid = sum(c["paid"] for c in cards if np.isfinite(c["paid"]))
    value = sum(c["value"] for c in cards)
    gain = sum(c["unrealized"] for c in cards if np.isfinite(c["unrealized"]))
    L.append(f"| Total ({len(cards)}) | | | {_usd(paid)} | | {_usd(value)} | {_usd(gain)} | "
             f"{_pct(gain / paid if paid else np.nan)} |")
    return "\n".join(L)


def render_portfolio(p: dict, budget: float, window: int) -> str:
    L = ["## Portfolio",
         f"* Paid {_usd(p['total_cost'])}; worth {_usd(p['total_value'])} now; gain or loss {_usd(p['total_unrealized'])} "
         f"({_pct(p['total_unrealized'] / p['total_cost'] if p['total_cost'] else np.nan)})",
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


def _qcc(q) -> str:
    if q is None or (isinstance(q, float) and np.isnan(q)):
        return "check with broker"
    return "yes" if q else "no"


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
                     f"{_qcc(r.qualified_covered_call)} | {r.tax_notes} |")
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


# ---------------------------------------------------------------- dashboard data
def _num(x, nd: int = 4):
    """A finite number rounded for display, else None (JSON null)."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return round(v, nd) if np.isfinite(v) else None


def _day(x):
    if x is None or (not isinstance(x, str) and pd.isna(x)):
        return None
    return str(pd.Timestamp(x).date())


def dashboard_rows(cards: list[dict], port: dict, budget: float, window: int) -> dict:
    """Three row sets for the website: one row per holding, one portfolio row, and down day pairs.
    Only finite numbers, ISO dates and plain text, so they serialize as strict JSON."""
    total = port["total_value"]
    holdings = []
    for c in sorted(cards, key=lambda c: -c["value"]):
        g, r, e = c["giveback"], c["recovery"], c["earnings"]
        ep = r.get("episodes") or {}
        enough = e.get("n", 0) >= 8
        row = {"symbol": c["ticker"], "shares": _num(c["shares"]), "price_paid": _num(c["cost"]), "paid": _num(c["paid"], 2),
               "price": _num(c["price"]), "value": _num(c["value"], 2), "gain": _num(c["unrealized"], 2),
               "gain_pct": _num(c["unrealized_pct"]), "weight": _num(c["value"] / total if total else np.nan),
               "as_of": _day(c["as_of"]),
               "budget_state": ("used up" if g.get("budget_used_up") else "within budget") if g.get("applies") else "no gain to protect",
               "peak_close": _num(g.get("peak_close")), "peak_date": _day(g.get("peak_date")),
               "from_peak_pct": _num(c["price"] / g["peak_close"] - 1 if g.get("peak_close") else np.nan),
               "floor_price": _num(g.get("floor_price")) if g.get("applies") else None,
               "budget_room": _num(c.get("budget_room_dollars"), 2),
               "from_high_pct": _num(r.get("from_high_pct")), "high": _num(r.get("high")), "high_date": _day(r.get("high_date")),
               "rise_to_paid_pct": _num(r.get("rally_to_cost_pct")) if c["price"] < c["cost"] else None,
               "recovery_cases": ep.get("n_reached"), "recovery_median_sessions": _num(ep.get("median_sessions_to_new_high"), 0),
               "recovery_within_250": _num(ep.get("share_within_250")),
               "next_report": _day(e.get("next_date")), "report_time": e.get("next_timing") if e.get("next_date") is not None else None,
               "sessions_to_report": e.get("sessions_to"), "reports": int(e.get("n", 0)),
               "typical_move": _num(e.get("median_abs_reaction")) if enough else None,
               "bad_night": _num(e.get("p10_reaction")) if enough else None,
               "good_night": _num(e.get("p90_reaction")) if enough else None,
               "worst_night": _num(e.get("worst_reaction")) if enough else None,
               "worst_night_date": _day(e.get("worst_reaction_date")) if enough else None,
               "bad_night_dollars": _num(c["value"] * min(0.0, e["p10_reaction"]), 2) if enough else None}
        for n in (20, 50, 200):
            st = c["streaks"].get(n) or {}
            h = st.get("h5") or {}
            row[f"ma{n}_side"] = st.get("side")
            row[f"ma{n}_sessions"] = st.get("streak")
            row[f"ma{n}_gap"] = _num(st.get("distance_pct", np.nan) / 100)
            row[f"ma{n}_share_this_long"] = _num(st.get("share_reaching_today"))
            row[f"ma{n}_cases"] = h.get("n")
            row[f"ma{n}_next5_median"] = _num(h.get("median_ret_pct", np.nan) / 100) if h.get("n", 0) >= 10 else None
            row[f"ma{n}_next5_base"] = _num(h.get("base_median_ret_pct", np.nan) / 100) if h.get("n", 0) >= 10 else None
        holdings.append(row)
    st = port.get("stress") or {}
    paid, gain = port["total_cost"], port["total_unrealized"]
    portfolio = [{"as_of": _day(max(c["as_of"] for c in cards)), "positions": len(cards), "paid": _num(paid, 2),
                  "value": _num(total, 2), "gain": _num(gain, 2), "gain_pct": _num(gain / paid if paid else np.nan),
                  "reporting_10_count": len(port.get("earnings_next_10", [])),
                  "reporting_10_share": _num(port.get("earnings_next_10_share")),
                  "stress_start": _day(st.get("start")), "stress_end": _day(st.get("end")), "stress_names": st.get("names"),
                  "stress_left_out": ", ".join(st.get("excluded", [])) or None,
                  "stress_worst_day": _num(st.get("worst_day")), "stress_worst_day_date": _day(st.get("worst_day_date")),
                  "stress_worst_20": _num(st.get("worst_20")), "stress_worst_20_end": _day(st.get("worst_20_end")),
                  "stress_max_drawdown": _num(st.get("max_drawdown")),
                  "market_minus10": _num(port.get("scenario_market_minus10"), 2),
                  "semis_minus20": _num(port.get("scenario_semis_minus20"), 2),
                  "down_days": port.get("down_days"), "budget": budget, "window": window,
                  "generated_at": pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%dT%H:%M:%SZ")}]
    pairs = [{"pair": f"{a}/{b}", "first": a, "second": b, "correlation": _num(v, 2)}
             for a, b, v in port.get("down_day_pairs", [])]
    return {"holdings": holdings, "portfolio": portfolio, "pairs": pairs}


def write_dashboard_json(rows: dict, out_dir: str | Path) -> list[Path]:
    import json
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    paths = []
    for name, data in rows.items():
        f = out / f"holdings_{name}.json"
        f.write_text(json.dumps(data, allow_nan=False, indent=1))
        paths.append(f)
    return paths


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
        with_options: bool = False, budget: float = DEFAULT_GIVEBACK, window: int = DEFAULT_WINDOW,
        json_dir: str | Path | None = None) -> str:
    from .data import loader
    src = position_csv or path or default_path()
    if not Path(src).exists():
        raise FileNotFoundError(f"{src} not found. Create data/user/holdings.csv (symbol, price paid, quantity) or pass "
                                f"--position-csv with the Position sheet (CSV, or JSON values).")
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
    if json_dir is not None:
        write_dashboard_json(dashboard_rows(cards, port, budget, window), json_dir)
    as_of = max(c["as_of"] for c in cards).date()
    parts = [f"# Holdings monitor, prices through {as_of}",
             "Facts: positions and prices. Associations (with counts): streak and recovery outcomes, reaction ranges. "
             "Model estimates: option values before expiration. Nothing here is a recommendation.",
             render_holdings(cards),
             render_portfolio(port, budget, window)]
    if skipped:
        parts.append("* Skipped: " + "; ".join(skipped))
    parts.append("## Positions")
    for c in sorted(cards, key=lambda c: -c["value"]):
        parts.append(render_card(c))
        if with_options:
            parts.append(option_panel(c["ticker"], c, data[c["ticker"]]["prices"]["close"]))
    return "\n\n".join(parts)

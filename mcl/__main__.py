"""Command line: python -m mcl <command>

  fetch TICKER [TICKER ...]   download prices, fundamentals and earnings dates into the cache
  study TICKER [--threshold 0.10] [--out reports/TICKER.html] [--basis first|asof]
                              run every study, write an HTML report
  scan [TICKER ...]           watchlist phase and alerts (default: data/user/watchlist.json)
  market                      long-run S&P 500 study (Shiller, VIX, 10y), writes reports/market_study.md
  verify [TICKER ...]         check SEC quarterly fundamentals against the 10-K totals and Yahoo,
                              writes reports/verify_<TICKER>.csv (default: stocks in the watchlist)
  doctor [--offline]          preflight: Python, packages, SEC contact header, and each data source
  holdings [TICKER ...]       holdings monitor: giveback budget, recovery, earnings risk, streaks, portfolio
                              exposure; --options adds covered call, put and collar payoffs from today's chain;
                              input: symbol, price paid, quantity (data/user/holdings.csv, or --position-csv:
                              the Position sheet as CSV or as Google Sheets JSON values)
  demo                        HTML report on synthetic data (no network)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

from .config import BASES, REPORTS_DIR


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="mcl", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    basis_help = "fundamentals basis: first = as first reported (default, or MCL_FUNDAMENTALS), asof = restated as of each filing"
    f = sub.add_parser("fetch")
    f.add_argument("tickers", nargs="+")
    f.add_argument("--basis", choices=BASES, help=basis_help)
    s = sub.add_parser("study")
    s.add_argument("ticker")
    s.add_argument("--threshold", type=float, default=0.10)
    s.add_argument("--out")
    s.add_argument("--basis", choices=BASES, help=basis_help)
    sc = sub.add_parser("scan")
    sc.add_argument("tickers", nargs="*")
    sc.add_argument("--threshold", type=float, default=0.10)
    sc.add_argument("--basis", choices=BASES, help=basis_help)
    m = sub.add_parser("market")
    m.add_argument("--since", default="1950-01-01")
    v = sub.add_parser("verify")
    v.add_argument("tickers", nargs="*")
    v.add_argument("--no-yahoo", action="store_true", help="SEC-only checks")
    hp = sub.add_parser("holdings")
    hp.add_argument("tickers", nargs="*")
    hp.add_argument("--file", help="CSV with symbol, price paid, quantity (default data/user/holdings.csv)")
    hp.add_argument("--position-csv", help="the Position sheet: CSV download or Google Sheets values JSON")
    hp.add_argument("--options", action="store_true", help="add option payoffs from today's chain")
    hp.add_argument("--giveback", type=float, default=0.25, help="share of peak gain you accept giving back")
    hp.add_argument("--window", type=int, default=63, help="sessions over which the peak is measured")
    hp.add_argument("--out", help="also write the report to this markdown file")
    hp.add_argument("--json", help="also write the website data (holdings, portfolio, pairs) as JSON files to this folder")
    d = sub.add_parser("doctor")
    d.add_argument("--offline", action="store_true", help="skip the network probes")
    sub.add_parser("demo")
    a = ap.parse_args(argv)

    if a.cmd == "fetch":
        from .data import loader
        for t in a.tickers:
            b = loader.load(t, basis=a.basis)
            print(f"{t}: {len(b.prices)} bars {b.prices.index[0].date()} to {b.prices.index[-1].date()}; "
                  f"quarters {0 if b.quarters is None else len(b.quarters)}; "
                  f"earnings {0 if b.earnings is None else len(b.earnings)}; metric {b.metric}")
            for n in b.notes:
                print("   note:", n)
    elif a.cmd in ("study", "demo"):
        from . import study
        from .data import demo, loader
        from .report import html
        b = demo.bundle() if a.cmd == "demo" else loader.load(a.ticker, basis=a.basis)
        R = study.run(b, getattr(a, "threshold", 0.10))
        out = getattr(a, "out", None) or REPORTS_DIR / f"{b.ticker}.html"
        html.build(b, R, out)
        snap = R["snapshot"]
        print(f"{b.ticker}: {snap['phase_text']}")
        for x in snap["alerts"]:
            print("  -", x)
        print(f"report: {out}")
    elif a.cmd == "scan":
        from .analytics import state
        from .data import loader, universe
        tks = [t.upper() for t in a.tickers] or universe.load_watchlist()
        bundles = {}
        for t in tks:
            try:
                b = loader.load(t, with_regimes=False, basis=a.basis)
                bundles[t] = {"prices": b.prices, "valuation": b.valuation, "metric": b.metric, "next_earnings": b.next_earnings}
            except Exception as e:
                print(f"skip {t}: {e}")
        df = state.scan(bundles, a.threshold)
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        p = REPORTS_DIR / f"scan_{pd.Timestamp.today().date()}.csv"
        df.to_csv(p, index=False)
        with pd.option_context("display.width", 200, "display.max_colwidth", 80):
            print(df.drop(columns=["alerts"], errors="ignore").to_string(index=False))
        print(f"saved: {p}")
    elif a.cmd == "market":
        from . import market_study as ms
        out = ms.run(a.since)
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        p = REPORTS_DIR / "market_study.md"
        p.write_text(ms.markdown(out), encoding="utf-8")
        for k in ("episodes_10pct", "swing_declines_10pct", "annual", "cape_vs_12m", "trend_vs_drawdown", "vix_vs_12m",
                  "rates_vs_12m", "rally_odds", "decline_odds", "bounces"):
            if k in out and isinstance(out[k], pd.DataFrame):
                out[k].to_csv(REPORTS_DIR / f"market_{k}.csv", index=False)
        print(f"wrote {p}")
    elif a.cmd == "verify":
        from . import verify
        from .data import universe
        tks = [t.upper() for t in a.tickers] or [t for t in universe.load_watchlist()
                                                  if universe.classify(t)["source"] != "proxy"]
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        summaries = []
        for t in tks:
            try:
                res = verify.run(t, use_yahoo=not a.no_yahoo)
            except Exception as e:
                print(f"{t}: skipped ({e})\n")
                continue
            res["rows"].to_csv(REPORTS_DIR / f"verify_{t}.csv", index=False)
            summaries.append(res["summary"])
            print(verify.text(res))
            print(f"  details: {REPORTS_DIR / f'verify_{t}.csv'}\n")
        if summaries:
            allsum = pd.concat(summaries, ignore_index=True)
            allsum.to_csv(REPORTS_DIR / "verify_summary.csv", index=False)
            fails = allsum[allsum["status"] == "fail"]
            print(f"summary: {REPORTS_DIR / 'verify_summary.csv'}; "
                  f"{len(fails)} check(s) with a FAIL across {allsum['ticker'].nunique()} ticker(s)")
            return 1 if len(fails) else 0
        return 1
    elif a.cmd == "holdings":
        from . import holdings
        text = holdings.run(a.file, a.position_csv, a.tickers, a.options, a.giveback, a.window, a.json)
        print(text)
        out = a.out or REPORTS_DIR / f"holdings_{pd.Timestamp.today().date()}.md"
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        Path(out).write_text(text, encoding="utf-8")
        print(f"\nsaved: {out}")
    elif a.cmd == "doctor":
        from . import doctor
        rows = doctor.checks(network=not a.offline)
        print(doctor.text(rows))
        return 1 if any(r["status"] == "fail" for r in rows) else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())

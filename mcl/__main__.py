"""Command line: python -m mcl <command>

  fetch TICKER [TICKER ...]   download prices, fundamentals and earnings dates into the cache
  study TICKER [--threshold 0.10] [--out reports/TICKER.html]   run every study, write an HTML report
  scan [TICKER ...]           watchlist phase and alerts (default: data/user/watchlist.json)
  market                      long-run S&P 500 study (Shiller, VIX, 10y), writes reports/market_study.md
  demo                        HTML report on synthetic data (no network)
"""
from __future__ import annotations

import argparse
import sys

import pandas as pd

from .config import REPORTS_DIR


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="mcl", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("tickers", nargs="+")
    s = sub.add_parser("study")
    s.add_argument("ticker")
    s.add_argument("--threshold", type=float, default=0.10)
    s.add_argument("--out")
    sc = sub.add_parser("scan")
    sc.add_argument("tickers", nargs="*")
    sc.add_argument("--threshold", type=float, default=0.10)
    m = sub.add_parser("market")
    m.add_argument("--since", default="1950-01-01")
    sub.add_parser("demo")
    a = ap.parse_args(argv)

    if a.cmd == "fetch":
        from .data import loader
        for t in a.tickers:
            b = loader.load(t)
            print(f"{t}: {len(b.prices)} bars {b.prices.index[0].date()} to {b.prices.index[-1].date()}; "
                  f"quarters {0 if b.quarters is None else len(b.quarters)}; "
                  f"earnings {0 if b.earnings is None else len(b.earnings)}; metric {b.metric}")
            for n in b.notes:
                print("   note:", n)
    elif a.cmd in ("study", "demo"):
        from . import study
        from .data import demo, loader
        from .report import html
        b = demo.bundle() if a.cmd == "demo" else loader.load(a.ticker)
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
                b = loader.load(t, with_regimes=False)
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
    return 0


if __name__ == "__main__":
    sys.exit(main())

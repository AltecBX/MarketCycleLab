"""Preflight for live data (python -m mcl doctor).

Checks the Python version, packages, the SEC contact header, TLS
certificates, the cache folder, and one small request to each data source.
Each failed line says what breaks and how to fix it.
"""
from __future__ import annotations

import importlib
import re
import sys
import time

from .config import CACHE_DIR, SEC_USER_AGENT

PACKAGES = [("pandas", "2.2"), ("numpy", "1.26"), ("scipy", "1.11"), ("plotly", "5.20"), ("streamlit", "1.51"),
            ("yfinance", "0.2.54"), ("certifi", None)]


def _ver(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3])


def _timed(fn):
    t0 = time.time()
    try:
        detail = fn()
        return True, detail, time.time() - t0
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"[:300], time.time() - t0


def checks(network: bool = True) -> list[dict]:
    out = []

    def add(name, ok, detail, fix="", level=None):
        out.append({"check": name, "status": level or ("ok" if ok else "fail"), "detail": detail, "fix": "" if ok else fix})

    v = sys.version_info
    add("python", v >= (3, 10), f"{v.major}.{v.minor}.{v.micro} at {sys.executable}",
        "Use Python 3.12: brew install python@3.12, then recreate .venv with python3.12 -m venv .venv")
    for pkg, need in PACKAGES:
        try:
            m = importlib.import_module(pkg)
            have = getattr(m, "__version__", "?")
            ok = need is None or _ver(have) >= _ver(need)
            add(pkg, ok, have, f"pip install -U '{pkg}>={need}'" if need else f"pip install {pkg}")
        except ImportError:
            add(pkg, False, "not installed", "pip install -r requirements.txt (inside the activated .venv)")
    ua = SEC_USER_AGENT.strip()
    add("sec user agent", bool(re.search(r"\S+\s+\S+@\S+\.\S+", ua)), ua or "not set",
        'export MCL_SEC_USER_AGENT="Your Name you@domain.com" (add it to ~/.zshrc to keep it)')
    try:
        p = CACHE_DIR / ".write_test"
        p.write_text("x")
        p.unlink()
        add("cache folder", True, str(CACHE_DIR))
    except Exception as e:  # noqa: BLE001
        add("cache folder", False, f"{CACHE_DIR}: {e}", "Check folder permissions or set MCL_DATA_DIR")
    import ssl
    stats = ssl.create_default_context().cert_store_stats()
    paths = ssl.get_default_verify_paths()
    add("tls certificates", True, f"{stats.get('x509_ca', 0)} CA certs loaded from {paths.cafile or paths.capath}; "
        "falls back to certifi automatically if verification fails", level="ok")
    if not network:
        return out

    from .data import http, macro, sec

    def sec_probe():
        if not ua:
            raise RuntimeError("skipped: no MCL_SEC_USER_AGENT")
        d = sec._get("https://data.sec.gov/submissions/CIK0000320193.json")
        return f"{d.get('name', '?')} submissions OK"

    def yahoo_probe():
        import yfinance as yf
        h = yf.Ticker("SPY").history(period="5d", auto_adjust=False)
        if h is None or h.empty:
            raise RuntimeError("empty response (rate limited or blocked)")
        return f"SPY last close {h['Close'].iloc[-1]:.2f} on {h.index[-1].date()}"

    def fred_probe():
        df = macro._csv(macro.URLS["fred_dgs10"])
        return f"{len(df)} rows, last {df.iloc[-1].tolist()}"

    def github_probe():
        df = macro._csv(macro.URLS["sp500_constituents"])
        return f"{len(df)} S&P 500 members"

    probes = [
        ("SEC EDGAR", sec_probe, "fundamentals and earnings timing unavailable; prices still work",
         'Set MCL_SEC_USER_AGENT; if it is set and SEC returns 403, wait 10 minutes (rate limit) and retry'),
        ("Yahoo", yahoo_probe, "no prices: live mode will not load",
         "pip install -U yfinance; if rate limited (YFRateLimitError) wait and retry, or drop a CSV in data/user/prices/"),
        ("FRED", fred_probe, "10y yield falls back to Yahoo ^TNX", "Optional; check network/VPN"),
        ("GitHub mirrors", github_probe, "no GICS sector/peer table, no Shiller data for `mcl market`",
         "Check network/VPN access to raw.githubusercontent.com"),
    ]
    for name, fn, impact, fix in probes:
        ok, detail, secs = _timed(fn)
        add(name, ok, f"{detail} ({secs:.1f}s)" if ok else f"{detail}. Impact: {impact}", fix,
            level=None if ok or name in ("SEC EDGAR", "Yahoo") else "warn")
    out.append({"check": "tls mode", "status": "ok", "detail": http.tls_mode(), "fix": ""})
    return out


def text(rows: list[dict]) -> str:
    lines = []
    for r in rows:
        lines.append(f"{r['status'].upper():<5} {r['check']:<17} {r['detail']}")
        if r["fix"]:
            lines.append(f"{'':<23}fix: {r['fix']}")
    n_fail = sum(r["status"] == "fail" for r in rows)
    lines.append("All required checks passed." if not n_fail else f"{n_fail} required check(s) failed.")
    return "\n".join(lines)

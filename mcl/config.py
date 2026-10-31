"""Paths and default research settings. Override with environment variables."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("MCL_DATA_DIR", ROOT / "data"))
CACHE_DIR = DATA_DIR / "cache"
USER_DIR = DATA_DIR / "user"
REPORTS_DIR = Path(os.environ.get("MCL_REPORTS_DIR", ROOT / "reports"))

# SEC asks every client to identify itself with a contact address.
# Set MCL_SEC_USER_AGENT="Your Name your@email" before fetching EDGAR data.
SEC_USER_AGENT = os.environ.get("MCL_SEC_USER_AGENT", "")

HISTORY_START = os.environ.get("MCL_START", "2005-01-01")

# Fundamentals basis for valuation:
#   first  each quarter as first reported, kept forever (default)
#   asof   restated as of each filing date: a restatement counts from the day it was filed
FUNDAMENTALS_BASIS = os.environ.get("MCL_FUNDAMENTALS", "first").strip().lower()
BASES = ("first", "asof")

DEFAULTS = {
    "swing_threshold": 0.10,     # zigzag reversal size for swings and selloffs
    "near_high": 0.03,           # a decline 'starts from a high' within 3% of the all-time high
    "min_episode_depth": 0.05,   # ignore underwater episodes shallower than 5%
    "earnings_inline_band": 0.02,
    "min_gap_days": 20,          # de-cluster events closer than this
}

for d in (CACHE_DIR, USER_DIR):
    d.mkdir(parents=True, exist_ok=True)

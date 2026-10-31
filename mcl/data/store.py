"""Tiny CSV cache: data/cache/<kind>/<key>.csv with a freshness check."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pandas as pd

from ..config import CACHE_DIR


def path(kind: str, key: str, ext: str = "csv") -> Path:
    p = CACHE_DIR / kind
    p.mkdir(parents=True, exist_ok=True)
    safe = key.replace("^", "IDX_").replace("/", "_").replace("=", "_")
    return p / f"{safe}.{ext}"


def fresh(p: Path, max_age_hours: float) -> bool:
    return p.exists() and (time.time() - p.stat().st_mtime) < max_age_hours * 3600


def save_frame(df: pd.DataFrame, kind: str, key: str) -> Path:
    p = path(kind, key)
    df.to_csv(p)
    return p


def load_frame(kind: str, key: str, max_age_hours: float | None = None, parse_index: bool = True) -> pd.DataFrame | None:
    p = path(kind, key)
    if not p.exists() or (max_age_hours is not None and not fresh(p, max_age_hours)):
        return None
    df = pd.read_csv(p, index_col=0)
    if parse_index:
        df.index = pd.to_datetime(df.index, utc=False, errors="coerce")
        df = df[df.index.notna()]
    return df


def save_json(obj, kind: str, key: str) -> Path:
    p = path(kind, key, "json")
    p.write_text(json.dumps(obj))
    return p


def load_json(kind: str, key: str, max_age_hours: float | None = None):
    p = path(kind, key, "json")
    if not p.exists() or (max_age_hours is not None and not fresh(p, max_age_hours)):
        return None
    return json.loads(p.read_text())

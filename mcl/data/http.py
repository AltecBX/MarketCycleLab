"""Shared HTTP for SEC and the CSV mirrors (Yahoo goes through yfinance).

* TLS: uses the system certificate store. If verification fails because that
  store is empty (common with the python.org installer on macOS until
  "Install Certificates.command" is run), it retries once with certifi's
  bundle and keeps using it for the rest of the session.
* SEC fair access: at most ~8 requests per second to sec.gov hosts
  (SEC's limit is 10), and a clear message on 403.
* 404 is not retried: it means the resource does not exist (for example a
  company with no XBRL facts), so waiting will not help.
"""
from __future__ import annotations

import ssl
import threading
import time
import urllib.error
import urllib.request

SEC_MIN_INTERVAL = 0.125
_lock = threading.Lock()
_last_sec_call = 0.0
_ctx: ssl.SSLContext | None = None
_using_certifi = False


class NotFound(RuntimeError):
    pass


def _certifi_context() -> ssl.SSLContext | None:
    try:
        import certifi
    except ImportError:
        return None
    return ssl.create_default_context(cafile=certifi.where())


def tls_mode() -> str:
    return "certifi bundle" if _using_certifi else "system store"


def _is_cert_error(e: BaseException) -> bool:
    reason = getattr(e, "reason", e)
    return isinstance(reason, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in str(e)


def _throttle(url: str) -> None:
    global _last_sec_call
    if "sec.gov" not in url:
        return
    with _lock:
        wait = SEC_MIN_INTERVAL - (time.monotonic() - _last_sec_call)
        if wait > 0:
            time.sleep(wait)
        _last_sec_call = time.monotonic()


def get_bytes(url: str, headers: dict | None = None, timeout: float = 30, retries: int = 3) -> bytes:
    """GET with retries and exponential backoff (1s, 2s, 4s)."""
    global _ctx, _using_certifi
    req = urllib.request.Request(url, headers=headers or {})
    for attempt in range(retries + 1):
        _throttle(url)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=_ctx) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise NotFound(f"404 Not Found: {url}") from e
            if e.code == 403 and "sec.gov" in url:
                raise RuntimeError(
                    "SEC refused the request (403). Check MCL_SEC_USER_AGENT is 'Your Name you@domain.com' "
                    "and that nothing else on this network is hammering sec.gov (limit 10 requests/second).") from e
            if attempt == retries:
                raise
        except Exception as e:
            if _is_cert_error(e) and not _using_certifi:
                alt = _certifi_context()
                if alt is not None:
                    _ctx, _using_certifi = alt, True
                    continue
            if attempt == retries:
                raise
        time.sleep(2 ** attempt)
    raise RuntimeError(f"unreachable: {url}")

"""Retail trader positioning on gold, averaged across brokers by FXSSI."""
import logging
import threading
import time

import httpx

log = logging.getLogger(__name__)

URL = "https://c.fxssi.com/api/current-ratios"
PAIR = "XAUUSD"
TTL_S = 300

_lock = threading.Lock()
_cache: dict = {"at": 0.0, "data": None}


def _fetch() -> dict | None:
    r = httpx.get(URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
    r.raise_for_status()
    body = r.json()
    pair = body.get("pairs", {}).get(PAIR)
    if not pair or "average" not in pair:
        return None
    titles = body.get("broker_titles", {})
    long_pct = float(pair["average"])
    brokers = {titles.get(k, k): float(v) for k, v in pair.items() if k != "average"}
    return {
        "long_pct": round(long_pct, 1),
        "short_pct": round(100 - long_pct, 1),
        "brokers": brokers,
        "formed_utc": int(body.get("formed") or 0),
        "source": "FXSSI",
    }


def retail_sentiment() -> dict | None:
    """Percent of retail traders long vs short gold. Cached for five minutes; the last good value is kept if a refresh fails."""
    with _lock:
        if _cache["data"] is not None and time.time() - _cache["at"] < TTL_S:
            return _cache["data"]
        try:
            data = _fetch()
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("Sentiment fetch failed: %s", exc)
            data = None
        if data is not None:
            _cache["data"] = data
        _cache["at"] = time.time()
        return _cache["data"]

import calendar
import logging
import re
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

import feedparser
import httpx

from . import db
from .config import GDELT_MIN_INTERVAL_SECONDS, GDELT_QUERIES, RSS_FEEDS, RSS_KEYWORDS

log = logging.getLogger(__name__)

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) gold-mcp/0.1"}
GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc"

# Rough headline tone from gold's perspective: positive = bullish wording for gold/risk-off, negative = bearish.
_BULL = ("rall", "surge", "soar", "jump", "climb", "gain", "rebound", "record high", "safe haven", "safe-haven",
         "rate cut", "dovish", "weaker dollar", "dollar falls", "yields fall", "escalat", "attack", "strike")
_BEAR = ("fall", "drop", "slide", "slump", "tumble", "plunge", "decline", "pressure", "retreat", "hawkish",
         "rate hike", "stronger dollar", "dollar rises", "yields rise", "ceasefire", "sell-off", "selloff")

_last_gdelt_call = 0.0
_gdelt_backoff_until = 0.0


def gold_tone(title: str) -> float:
    t = title.lower()
    score = sum(w in t for w in _BULL) - sum(w in t for w in _BEAR)
    return max(-1.0, min(1.0, score / 2.0))


_KEYWORD_RE = re.compile(r"\b(?:" + "|".join(map(re.escape, RSS_KEYWORDS)) + ")", re.IGNORECASE)


def _relevant(title: str, summary: str = "") -> bool:
    return bool(_KEYWORD_RE.search(f"{title} {summary}"))


_FALLBACK_DATE_FORMATS = ("%b %d, %Y %H:%M GMT", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%SZ")


def _entry_time(e) -> int | None:
    parsed = e.get("published_parsed") or e.get("updated_parsed")
    if parsed:
        return calendar.timegm(parsed)
    raw = (e.get("published") or e.get("updated") or "").strip()
    for fmt in _FALLBACK_DATE_FORMATS:
        try:
            return int(datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            continue
    return None


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or "")).strip()


def poll_rss(client: httpx.Client | None = None) -> int:
    own = client is None
    client = client or httpx.Client(headers=UA, timeout=30, follow_redirects=True)
    rows = []
    try:
        for source, url in RSS_FEEDS.items():
            try:
                resp = client.get(url)
                resp.raise_for_status()
            except httpx.HTTPError as e:
                log.warning("RSS %s failed: %s", source, e)
                continue
            feed = feedparser.parse(resp.content)
            for e in feed.entries:
                title = _clean(e.get("title", ""))
                link = e.get("link")
                if not title or not link:
                    continue
                summary = _clean(e.get("summary", ""))
                if not _relevant(title, summary):
                    continue
                ts = _entry_time(e) or int(time.time())
                rows.append({
                    "url": link, "time_utc": ts, "source": source, "title": title,
                    "domain": urlparse(link).netloc, "tone": gold_tone(title), "query": "rss",
                })
    finally:
        if own:
            client.close()
    with db.session() as conn:
        added = db.insert_headlines(conn, rows)
    log.info("RSS: %d relevant items, %d new", len(rows), added)
    return added


def _gdelt_request(client: httpx.Client, params: dict) -> list[dict]:
    global _last_gdelt_call, _gdelt_backoff_until
    now = time.time()
    if now < _gdelt_backoff_until:
        return []
    wait = GDELT_MIN_INTERVAL_SECONDS - (now - _last_gdelt_call)
    if wait > 0:
        time.sleep(wait)
    _last_gdelt_call = time.time()
    try:
        resp = client.get(GDELT_URL, params=params)
    except httpx.HTTPError as e:
        log.warning("GDELT request failed: %s", e)
        return []
    if resp.status_code == 429:
        _gdelt_backoff_until = time.time() + 600
        log.info("GDELT rate limited; backing off 10 minutes")
        return []
    if resp.status_code != 200 or "json" not in resp.headers.get("content-type", ""):
        return []
    try:
        return resp.json().get("articles", []) or []
    except ValueError:
        return []


def _gdelt_rows(articles: list[dict], query_key: str) -> list[dict]:
    rows = []
    for a in articles:
        if a.get("language") not in (None, "English"):
            continue
        try:
            ts = int(datetime.strptime(a["seendate"], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).timestamp())
        except (KeyError, ValueError):
            continue
        title = _clean(a.get("title", ""))
        if not title or not a.get("url"):
            continue
        rows.append({
            "url": a["url"], "time_utc": ts, "source": "gdelt", "title": title,
            "domain": a.get("domain"), "tone": gold_tone(title), "query": query_key,
        })
    return rows


def poll_gdelt(timespan: str = "1d", start: datetime | None = None, end: datetime | None = None) -> int:
    added = 0
    with httpx.Client(headers=UA, timeout=40) as client:
        for key, q in GDELT_QUERIES.items():
            params = {"query": f"{q} sourcelang:english", "mode": "ArtList", "format": "json",
                      "maxrecords": 250, "sort": "DateDesc"}
            if start and end:
                params["startdatetime"] = start.strftime("%Y%m%d%H%M%S")
                params["enddatetime"] = end.strftime("%Y%m%d%H%M%S")
            else:
                params["timespan"] = timespan
            rows = _gdelt_rows(_gdelt_request(client, params), key)
            if rows:
                with db.session() as conn:
                    added += db.insert_headlines(conn, rows)
    if added:
        log.info("GDELT: %d new headlines", added)
    return added


def backfill_gdelt(days: int = 90, step_days: int = 7) -> int:
    """Walks back through GDELT's ~3-month window one week at a time; resumable via meta."""
    with db.session() as conn:
        done_until = int(db.get_meta(conn, "gdelt_backfill_cursor", "0") or 0)
    end = int(time.time()) if not done_until else done_until
    floor = int(time.time()) - days * 86400
    total = 0
    while end > floor and time.time() >= _gdelt_backoff_until:
        start = max(floor, end - step_days * 86400)
        total += poll_gdelt(start=datetime.fromtimestamp(start, timezone.utc), end=datetime.fromtimestamp(end, timezone.utc))
        if time.time() < _gdelt_backoff_until:
            break
        end = start
        with db.session() as conn:
            db.set_meta(conn, "gdelt_backfill_cursor", str(end))
    return total

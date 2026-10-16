"""MCP server exposing XAUUSD price history, news, scheduled events and reaction stats from the local gold DB."""
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mcp.server.mcpserver import MCPServer

from goldcore import analytics, db, explain, queries
from goldcore.config import SYMBOL, TF_SECONDS

INSTRUCTIONS = f"""
Data source: {SYMBOL} (spot gold vs USD, a 24/7 CFD) from a MetaTrader 5 terminal, the MT5 economic calendar,
and RSS/GDELT headlines, all stored in a local SQLite DB that a separate collector keeps updated.

Conventions:
- All times are UTC. Tools accept ISO-8601 strings (e.g. "2026-10-14T12:30:00Z") or unix seconds.
- Price moves are in USD per ounce. Calendar 'importance' is 1=low, 2=moderate, 3=high.
- Event reaction stats measure gold's move from the last completed bar before the release.

For a short-term outlook, start with build_prediction_context, then drill down with the other tools.
Treat the output as probabilistic context, not certainty; check 'freshness' to see how current the data is.
"""

mcp = MCPServer("gold-mcp", instructions=INSTRUCTIONS)


def _ts(v: str | int | float | None, default: int | None = None) -> int | None:
    if v is None or v == "":
        return default
    if isinstance(v, (int, float)) or str(v).lstrip("-").isdigit():
        return int(float(v))
    s = str(v).strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def _iso(ts: int | None) -> str | None:
    return None if ts is None else datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _with_iso(rows: list[dict], key: str = "time_utc") -> list[dict]:
    for r in rows:
        r["time"] = _iso(r.pop(key))
    return rows


_EVENT_FIELDS = ("time", "currency", "name", "importance_label", "actual", "forecast", "previous", "revised",
                 "unit", "event_id", "surprise", "ret_5m", "ret_15m", "ret_1h", "ret_4h", "range_1h")


def _compact_event(e: dict) -> dict:
    return {k: e[k] for k in _EVENT_FIELDS if k in e and e[k] is not None}


def _iso_freshness(f: dict) -> dict:
    for k in ("last_m1_bar_utc", "calendar_exported_utc", "latest_headline_utc"):
        if k in f:
            f[k] = _iso(f[k])
    return f


@mcp.tool()
def get_market_snapshot() -> dict:
    """Current gold price, recent changes (USD), ATR(14) per timeframe, 24h/7d ranges, EMA trend state, data freshness."""
    with db.session(readonly=True) as conn:
        snap = analytics.market_snapshot(conn)
    if "error" not in snap:
        snap["last_bar_utc"] = _iso(snap["last_bar_utc"])
        _iso_freshness(snap["freshness"])
    return snap


@mcp.tool()
def get_price_history(timeframe: str = "H1", start: str | None = None, end: str | None = None, limit: int = 200) -> dict:
    """OHLC candles for M1, M5, M15, M30, H1, H4 or D1. Without start, returns the latest `limit` bars (max 2000).

    Returns compact columns/rows to save tokens; times are bar open times in UTC.
    """
    tf = timeframe.upper()
    if tf not in TF_SECONDS:
        return {"error": f"timeframe must be one of {list(TF_SECONDS)}"}
    limit = max(1, min(int(limit), 2000))
    with db.session(readonly=True) as conn:
        df = queries.candles_df(conn, tf, _ts(start), _ts(end), limit)
    rows = [[_iso(r.time), round(r.open, 2), round(r.high, 2), round(r.low, 2), round(r.close, 2), int(r.tick_volume)]
            for r in df.itertuples(index=False)]
    return {"symbol": SYMBOL, "timeframe": tf, "columns": ["time", "open", "high", "low", "close", "tick_volume"],
            "count": len(rows), "rows": rows}


@mcp.tool()
def get_news_history(start: str | None = None, end: str | None = None, min_importance: int = 2,
                     include_headlines: bool = True, search: str | None = None, limit: int = 100,
                     include_urls: bool = True) -> dict:
    """Past economic calendar releases (with actual/forecast and gold's measured reaction) and news headlines.

    Defaults to the last 72 hours. `search` filters names/titles by substring. Headline 'tone' is a crude
    keyword score in [-1, 1] where positive means bullish wording for gold.
    """
    now = int(time.time())
    s, e = _ts(start, now - 72 * 3600), _ts(end, now)
    limit = max(1, min(int(limit), 500))
    with db.session(readonly=True) as conn:
        events = queries.calendar_events(conn, s, min(e, now), min_importance)
        if search:
            events = [ev for ev in events if search.lower() in ev["name"].lower()]
        heads = queries.headlines(conn, s, e, limit, search) if include_headlines else []
    events = [_compact_event(ev) for ev in _with_iso(events)][-limit:]
    heads = [{"time": h["time"], "source": h["source"], "title": h["title"], "tone": h["tone"],
              **({"url": h["url"]} if include_urls else {})} for h in _with_iso(heads)]
    return {"window": {"start": _iso(s), "end": _iso(e)}, "calendar_releases": events, "headlines": heads}


def _reaction_summary(conn, event_id: int) -> dict | None:
    st = analytics.event_reaction_stats(conn, event_id)
    if st.get("samples", 0) == 0:
        return None

    def pick(block: dict | None) -> dict | None:
        if not block:
            return None
        d1h, d15 = block.get("ret_1h"), block.get("ret_15m")
        if not d1h and not d15:
            return None
        return {"n": (d1h or d15)["n"], "median_15m": d15 and d15["median"], "median_1h": d1h and d1h["median"],
                "median_abs_1h": d1h and d1h["median_abs"], "pct_up_1h": d1h and d1h["pct_up"]}

    return {"samples": st["samples"], "all": pick(st.get("all")), "if_actual_above_forecast": pick(st.get("beat_forecast")),
            "if_actual_below_forecast": pick(st.get("missed_forecast"))}


@mcp.tool()
def get_upcoming_events(hours_ahead: float = 72, min_importance: int = 2, usd_only: bool = False,
                        non_usd_min_importance: int = 3) -> dict:
    """Scheduled calendar events in the next `hours_ahead` hours, with forecasts and a summary of how gold
    historically moved after each event (overall and split by actual above/below forecast).

    USD events use `min_importance`; other currencies use `non_usd_min_importance` (default high only),
    or are excluded entirely with usd_only=True.
    """
    with db.session(readonly=True) as conn:
        events = queries.upcoming_events(conn, hours_ahead, min(min_importance, non_usd_min_importance))
        events = [e for e in events if (e["importance"] >= min_importance if e["currency"] == "USD"
                                        else not usd_only and e["importance"] >= non_usd_min_importance)]
        out = []
        for e in _with_iso(events):
            item = _compact_event(e)
            item["historical_gold_reaction"] = _reaction_summary(conn, int(e["event_id"]))
            out.append(item)
        exported = db.get_meta(conn, "calendar_generated_utc")
    return {"hours_ahead": hours_ahead, "calendar_exported": _iso(int(exported)) if exported else None,
            "count": len(out), "events": out}


@mcp.tool()
def get_event_reaction_stats(event: str, surprise_sign: str | None = None) -> dict:
    """Distribution of gold's USD move 5m/15m/1h/4h after past releases of an event, plus the 1h high-low range.

    `event` is a calendar event_id or part of a name (e.g. "Nonfarm Payrolls", "CPI", "Interest Rate Decision").
    `surprise_sign` = "positive" (actual above forecast) or "negative" adds a 'selected' block for that case.
    """
    with db.session(readonly=True) as conn:
        st = analytics.event_reaction_stats(conn, event, surprise_sign)
    if "recent" in st:
        st["recent"] = _with_iso(st["recent"])
    return st


@mcp.tool()
def get_news_digest(days: int = 7, utc_offset_minutes: int = 0) -> dict:
    """Plain-English daily summaries (newest first): what gold did each day, which scheduled releases moved it and
    by how much, what the headlines were mostly about, and the overall headline mood. Days split at local midnight
    for `utc_offset_minutes` (e.g. 420 for UTC+7); times in the text are in that local time."""
    with db.session(readonly=True) as conn:
        days_out = explain.digest(conn, max(1, min(int(days), 30)), int(utc_offset_minutes))
    for d in days_out:
        for k in ("start_utc", "end_utc"):
            d[k] = _iso(d[k])
        if d.get("biggest_hour"):
            d["biggest_hour"]["time"] = _iso(d["biggest_hour"].pop("time_utc"))
        for r in d["key_releases"]:
            r["time"] = _iso(r.pop("time_utc"))
        for t in d["topics"]:
            for ex in t["examples"]:
                ex["time"] = _iso(ex.pop("time_utc"))
                ex.pop("url", None)
    return {"utc_offset_minutes": utc_offset_minutes, "days": days_out}


@mcp.tool()
def get_volatility_profile(days: int = 90) -> dict:
    """Typical H1 high-low range in USD by UTC hour of day and by weekday over the last `days` days."""
    with db.session(readonly=True) as conn:
        return analytics.volatility_profile(conn, max(7, min(int(days), 365)))


@mcp.tool()
def estimate_swing_range(horizon_hours: float = 4) -> dict:
    """Baseline statistical swing estimate for the next `horizon_hours` (0.25-72): empirical distribution of
    recent price changes and high-low ranges over the same horizon, widened for scheduled events in the window,
    plus a heuristic directional bias from trend and headline tone."""
    with db.session(readonly=True) as conn:
        est = analytics.estimate_swing_range(conn, horizon_hours)
    for e in est.get("events_in_window", []):
        e["time"] = _iso(e.pop("time_utc"))
    return est


@mcp.tool()
def build_prediction_context(horizon_hours: float = 4) -> dict:
    """One-call bundle for a short-term gold outlook: market snapshot, recent H1 and M15 candles, last 24h of
    releases and headlines, upcoming events inside (and shortly after) the horizon with historical reactions,
    the hour-of-day volatility profile, and the baseline swing estimate."""
    horizon_hours = max(0.25, min(float(horizon_hours), 72))
    now = int(time.time())
    return {
        "generated": _iso(now),
        "horizon_hours": horizon_hours,
        "snapshot": get_market_snapshot(),
        "recent_h1": get_price_history("H1", limit=48),
        "recent_m15": get_price_history("M15", limit=32),
        "today_and_yesterday_summary": [
            {"date": d["date"], "summary": d["summary"], "key_releases": [r["text"] + " " + (r["gold_reaction_text"] or "")
                                                                          for r in d["key_releases"]]}
            for d in get_news_digest(2)["days"]
        ],
        "news_last_24h": get_news_history(_iso(now - 86400), _iso(now), min_importance=2, limit=30,
                                          include_urls=False),
        "upcoming_events": get_upcoming_events(hours_ahead=horizon_hours + 12, min_importance=2),
        "volatility_by_hour_utc": get_volatility_profile(60).get("by_hour_utc"),
        "baseline_estimate": estimate_swing_range(horizon_hours),
    }


@mcp.prompt()
def short_term_gold_outlook(horizon_hours: str = "4") -> str:
    """Guided analysis of gold's likely swing over the next few hours."""
    return f"""Produce a short-term outlook for {SYMBOL} over the next {horizon_hours} hours.

1. Call build_prediction_context(horizon_hours={horizon_hours}). Check snapshot.freshness; warn if the last M1 bar
   is more than 10 minutes old or the calendar export is stale.
2. Describe the current state: price, trend on H1/H4/D1, position within the 24h and 7d ranges, ATR.
3. For each moderate/high-impact event inside the window, use its historical gold reaction (and
   get_event_reaction_stats if you need more detail) to explain what an above- or below-forecast print would likely do.
4. Weigh recent releases and headlines (Fed policy, inflation, USD/yields, geopolitics) for directional pressure.
5. Give: expected range (low-high), most likely direction with a confidence level, key levels, the scenarios
   that would invalidate the view, and when the next volatility spike is due.
6. Anchor your numbers to baseline_estimate and state clearly where and why you deviate from it.
This is probabilistic analysis, not financial advice."""


def _heartbeat() -> None:
    """While this process is alive, Cursor has the server open. The chart reads the timestamp."""
    while True:
        try:
            with db.session() as conn:
                db.set_meta(conn, "mcp_heartbeat_utc", str(int(time.time())))
        except Exception:
            pass
        time.sleep(15)


def main() -> None:
    threading.Thread(target=_heartbeat, name="mcp-heartbeat", daemon=True).start()
    mcp.run("stdio")


if __name__ == "__main__":
    main()

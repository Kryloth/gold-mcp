import asyncio
import logging
import subprocess
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from goldcore import analytics, db, explain, queries, sentiment
from goldcore.collector import Collector
from goldcore.config import ROOT, SYMBOL, TF_SECONDS

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)

collector = Collector()


@asynccontextmanager
async def lifespan(_: FastAPI):
    collector.start()
    yield
    await asyncio.to_thread(collector.stop)


app = FastAPI(title="Gold MCP", lifespan=lifespan)


def _now() -> int:
    return int(time.time())


_mcp_proc = {"at": 0.0, "running": False}
_CREATE_NO_WINDOW = 0x08000000


def _mcp_process_running() -> bool:
    now = time.time()
    if now - _mcp_proc["at"] < 20:
        return bool(_mcp_proc["running"])
    running = False
    try:
        completed = subprocess.run(
            [
                "powershell", "-NoProfile", "-NonInteractive", "-Command",
                "(Get-CimInstance Win32_Process -Filter \"name = 'python.exe'\" | "
                "Where-Object { $_.CommandLine -match 'mcp_server' }).Count",
            ],
            capture_output=True, text=True, timeout=6, creationflags=_CREATE_NO_WINDOW,
        )
        running = completed.returncode == 0 and completed.stdout.strip() not in ("", "0")
    except (OSError, subprocess.TimeoutExpired):
        running = False
    _mcp_proc["at"] = now
    _mcp_proc["running"] = running
    return running


def _mcp_last_seen(conn) -> int | None:
    raw = db.get_meta(conn, "mcp_heartbeat_utc")
    return int(raw) if raw and str(raw).isdigit() else None


@app.get("/api/status")
def status():
    with db.session(readonly=True) as conn:
        fresh = queries.data_freshness(conn)
        last = _mcp_last_seen(conn)
    heartbeat = last is not None and _now() - last <= 45
    return {
        "symbol": SYMBOL,
        "mt5_connected": collector.feed.connected,
        "collectors": collector.status,
        "data": fresh,
        "mcp": {"connected": heartbeat or _mcp_process_running(), "last_seen_utc": last},
    }


@app.get("/api/candles")
def candles(tf: str = "M15", start: int | None = Query(None, alias="from"), end: int | None = Query(None, alias="to"),
            limit: int = Query(3000, le=20000)):
    if tf not in TF_SECONDS:
        raise HTTPException(400, f"tf must be one of {list(TF_SECONDS)}")
    with db.session(readonly=True) as conn:
        df = queries.candles_df(conn, tf, start, end, limit)
    return {"tf": tf, "candles": df[["time", "open", "high", "low", "close", "tick_volume"]].to_dict("records")}


@app.get("/api/events")
def events(start: int | None = Query(None, alias="from"), end: int | None = Query(None, alias="to"),
           min_importance: int = 2, currency: str | None = None):
    start = start or _now() - 30 * 86400
    end = end or _now() + 14 * 86400
    with db.session(readonly=True) as conn:
        rows = queries.calendar_events(conn, start, end, min_importance, currency.split(",") if currency else None)
    return [explain.enrich_event(e) for e in rows]


@app.get("/api/headlines")
def get_headlines(start: int | None = Query(None, alias="from"), end: int | None = Query(None, alias="to"),
                  limit: int = Query(200, le=2000), q: str | None = None):
    with db.session(readonly=True) as conn:
        return queries.headlines(conn, start or 0, end or _now() + 3600, limit, q)


@app.get("/api/upcoming")
def upcoming(hours: float = 168, min_importance: int = 2):
    with db.session(readonly=True) as conn:
        rows = queries.upcoming_events(conn, hours, min_importance)
        history: dict[int, dict] = {}
        for e in rows:
            if e["event_id"] not in history:
                history[e["event_id"]] = explain.history_sentences(analytics.event_reaction_stats(conn, int(e["event_id"])))
            explain.enrich_event(e)
            e["history"] = history[e["event_id"]]
    return rows


@app.get("/api/event-stats/{event}")
def event_stats(event: str):
    with db.session(readonly=True) as conn:
        return analytics.event_reaction_stats(conn, event)


@app.get("/api/explain-event/{value_id}")
def explain_event(value_id: int):
    with db.session(readonly=True) as conn:
        row = conn.execute(
            "SELECT e.*, r.ret_5m, r.ret_15m, r.ret_1h, r.ret_4h, r.range_1h FROM calendar_events e "
            "LEFT JOIN event_reactions r ON r.value_id=e.value_id WHERE e.value_id=?", (value_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Unknown event")
        return explain.explain_event(conn, dict(row))


@app.get("/api/digest")
def digest(days: int = Query(7, ge=1, le=60), tz: int = 0):
    """tz: viewer's UTC offset in minutes, so days split at local midnight."""
    with db.session(readonly=True) as conn:
        return explain.digest(conn, days, tz)


@app.get("/api/outlook")
def outlook(hours: float = 4, tz: int = 0):
    with db.session(readonly=True) as conn:
        return explain.outlook(conn, hours, tz)


@app.get("/api/trades")
def trades():
    """Open positions and pending orders from the MetaTrader 5 terminal."""
    return collector.feed.account_trades()


@app.get("/api/history")
def history(start: int = Query(..., alias="from")):
    """Closed trades that exited at or after `from` (unix seconds). Nothing is sent to the broker."""
    now = int(time.time())
    if start > now + 60:
        raise HTTPException(400, "That start time is in the future.")
    if now - start > 90 * 86400:
        raise HTTPException(400, "History only goes back 90 days.")
    return collector.feed.trade_history(start)


@app.get("/api/account")
def account(day_start: int = Query(..., alias="from")):
    """Balance, equity, and profit since the given local midnight (unix seconds)."""
    return collector.feed.account_summary(day_start)


@app.get("/api/market-flow")
def market_flow():
    """Buy vs sell pressure from live ticks, and retail trader positioning from FXSSI."""
    return {"ticks": collector.feed.tick_flow(), "retail": sentiment.retail_sentiment()}


class MarketOrder(BaseModel):
    side: str = Field(pattern="^(buy|sell)$")
    volume: float = Field(gt=0)
    profit: float = Field(gt=0)


def _order_call(fn):
    try:
        return fn()
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/orders/plan")
def order_plan(body: MarketOrder):
    """Price a market order and the target for the profit asked for. Nothing is sent."""
    return _order_call(lambda: collector.feed.plan_market(body.side, body.volume, body.profit))


@app.post("/api/orders")
def place_order(body: MarketOrder):
    """Send a market order on the logged-in account, with the target set for that profit."""
    return _order_call(lambda: collector.feed.place_market(body.side, body.volume, body.profit))


@app.post("/api/orders/{ticket}/close")
def close_order(ticket: int):
    """Close an open position at the market, or cancel a waiting order."""
    return _order_call(lambda: collector.feed.close_trade(ticket))


@app.get("/api/snapshot")
def snapshot():
    with db.session(readonly=True) as conn:
        return analytics.market_snapshot(conn)


@app.get("/api/swing")
def swing(hours: float = 4):
    with db.session(readonly=True) as conn:
        return analytics.estimate_swing_range(conn, hours)


@app.websocket("/ws/ticks")
async def ticks(ws: WebSocket):
    await ws.accept()
    last = None
    try:
        while True:
            tick = await asyncio.to_thread(collector.feed.tick)
            if tick and tick != last:
                await ws.send_json(tick)
                last = tick
            await asyncio.sleep(0.5)
    except (WebSocketDisconnect, RuntimeError):
        pass


_dist = ROOT / "frontend" / "dist"
if _dist.exists():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        return FileResponse(_dist / "index.html")

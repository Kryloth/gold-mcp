import logging
import threading
import time
from datetime import datetime, timezone

import MetaTrader5 as mt5

from . import db
from .config import LOOKBACK_DAYS, SYMBOL, TF_SECONDS, TIMEFRAMES

log = logging.getLogger(__name__)

MT5_TF = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1,
}

# Window size per request during backfill, sized to stay well under typical "Max bars" limits.
BACKFILL_WINDOW_DAYS = {"M1": 7, "M5": 30, "M15": 60, "M30": 120, "H1": 240, "H4": 730, "D1": 3650}


def _srv_dt(srv_ts: int) -> datetime:
    # MT5 bar times are raw trade-server seconds; it expects request datetimes in the same frame.
    return datetime.fromtimestamp(srv_ts, tz=timezone.utc)


def _deals_by_position(deals) -> dict[int, list]:
    grouped: dict[int, list] = {}
    trade = (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL)
    for deal in deals:
        if int(deal.type) not in trade or not int(deal.position_id):
            continue
        grouped.setdefault(int(deal.position_id), []).append(deal)
    return grouped


def _entries(group: list):
    return [d for d in group if int(d.entry) == mt5.DEAL_ENTRY_IN and float(d.volume) > 0]


def _exits(group: list):
    out = (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY)
    return [d for d in group if int(d.entry) in out and float(d.volume) > 0]


class MT5Feed:
    def __init__(self, symbol: str = SYMBOL):
        self.symbol = symbol
        self.lock = threading.RLock()
        self.connected = False
        self.server_offset = 0

    def connect(self) -> bool:
        with self.lock:
            if self.connected and mt5.terminal_info() is not None:
                return True
            if not mt5.initialize():
                log.warning("MT5 initialize failed: %s", mt5.last_error())
                self.connected = False
                return False
            if not mt5.symbol_select(self.symbol, True):
                log.error("Symbol %s not available: %s", self.symbol, mt5.last_error())
                mt5.shutdown()
                self.connected = False
                return False
            self.connected = True
            self._detect_offset()
            return True

    def shutdown(self) -> None:
        with self.lock:
            mt5.shutdown()
            self.connected = False

    def _detect_offset(self) -> None:
        for _ in range(10):
            tick = mt5.symbol_info_tick(self.symbol)
            if tick is not None and abs(tick.time - time.time()) < 15 * 3600:
                raw = tick.time - time.time()
                # Server offsets are whole quarter-hours; rounding absorbs tick staleness.
                self.server_offset = int(round(raw / 900.0) * 900)
                break
            time.sleep(0.5)
        with db.session() as conn:
            db.set_meta(conn, "server_offset", str(self.server_offset))
        log.info("Server time offset: %+d s", self.server_offset)

    def _rows(self, rates) -> list[tuple]:
        off = self.server_offset
        return [
            (int(r["time"]) - off, float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]),
             int(r["tick_volume"]), int(r["spread"]))
            for r in rates
        ]

    def _fetch_range(self, tf: str, start_srv: int, end_srv: int):
        with self.lock:
            rates = mt5.copy_rates_range(self.symbol, MT5_TF[tf], _srv_dt(start_srv), _srv_dt(end_srv))
        if rates is None:
            log.debug("copy_rates_range %s returned None: %s", tf, mt5.last_error())
            return []
        return rates

    def _last_time(self, conn, tf: str) -> int | None:
        row = conn.execute("SELECT MAX(time_utc) AS t FROM candles WHERE tf=?", (tf,)).fetchone()
        return row["t"]

    def backfill(self, tf: str) -> int:
        now_srv = int(time.time()) + self.server_offset
        with db.session() as conn:
            if db.get_meta(conn, f"backfilled_{tf}") == "1":
                return 0
            first = conn.execute("SELECT MIN(time_utc) AS t FROM candles WHERE tf=?", (tf,)).fetchone()["t"]
        start_srv = now_srv - LOOKBACK_DAYS * 86400
        end_target = (first + self.server_offset) if first else now_srv
        window = BACKFILL_WINDOW_DAYS[tf] * 86400
        total = 0
        cursor = start_srv
        while cursor < end_target:
            stop = min(cursor + window, end_target + TF_SECONDS[tf])
            rates = self._fetch_range(tf, cursor, stop)
            if len(rates):
                with db.session() as conn:
                    total += db.upsert_candles(conn, tf, self._rows(rates))
            cursor = stop
        with db.session() as conn:
            db.set_meta(conn, f"backfilled_{tf}", "1")
        log.info("Backfilled %s: %d bars", tf, total)
        return total

    def sync(self, tf: str) -> int:
        with db.session() as conn:
            last = self._last_time(conn, tf)
        now_srv = int(time.time()) + self.server_offset
        if last is None:
            start_srv = now_srv - BACKFILL_WINDOW_DAYS[tf] * 86400
        else:
            # Re-fetch the last two bars so the still-forming bar gets updated.
            start_srv = last + self.server_offset - TF_SECONDS[tf]
        rates = self._fetch_range(tf, start_srv, now_srv + 86400)
        if not len(rates):
            return 0
        with db.session() as conn:
            n = db.upsert_candles(conn, tf, self._rows(rates))
            db.set_meta(conn, f"synced_{tf}", str(int(time.time())))
        return n

    def sync_all(self, backfill: bool = True) -> dict[str, int]:
        if not self.connect():
            return {}
        result = {}
        for tf in TIMEFRAMES:
            try:
                if backfill:
                    self.backfill(tf)
                result[tf] = self.sync(tf)
            except Exception:
                log.exception("Sync failed for %s", tf)
        return result

    def account_trades(self) -> dict:
        """Open positions and pending orders on the terminal's logged-in account. Read only."""
        empty = {"connected": False, "symbol": self.symbol, "positions": [], "orders": []}
        with self.lock:
            if not self.connected and not self.connect():
                return empty
            positions = mt5.positions_get()
            orders = mt5.orders_get()
            if positions is None or orders is None:
                err = mt5.last_error()
                if not err or err[0] != 1:
                    log.warning("MT5 trades read failed: %s", err)
                    return empty
                positions = positions or ()
                orders = orders or ()
        off = self.server_offset

        def potential(d: dict, kind: str, level: str = "tp") -> float | None:
            """Profit from the entry to the target ("tp") or to the stop ("sl"). A stop below a buy entry comes out negative."""
            close_at = float(d[level] or 0)
            volume = float(d.get("volume") if kind == "position" else d.get("volume_current") or 0)
            if close_at <= 0 or volume <= 0:
                return None
            action = mt5.ORDER_TYPE_SELL if int(d["type"]) % 2 else mt5.ORDER_TYPE_BUY
            value = mt5.order_calc_profit(action, d["symbol"], volume, float(d["price_open"]), close_at)
            return round(float(value), 2) if value is not None else None

        def side(code: int) -> str:
            return {
                mt5.ORDER_TYPE_BUY: "buy",
                mt5.ORDER_TYPE_SELL: "sell",
                mt5.ORDER_TYPE_BUY_LIMIT: "buy limit",
                mt5.ORDER_TYPE_SELL_LIMIT: "sell limit",
                mt5.ORDER_TYPE_BUY_STOP: "buy stop",
                mt5.ORDER_TYPE_SELL_STOP: "sell stop",
                mt5.ORDER_TYPE_BUY_STOP_LIMIT: "buy stop limit",
                mt5.ORDER_TYPE_SELL_STOP_LIMIT: "sell stop limit",
            }.get(int(code), "order")

        def row(raw, kind: str) -> dict:
            d = raw._asdict()
            opened = int(d.get("time") or d.get("time_setup") or 0)
            return {
                "ticket": int(d["ticket"]),
                "symbol": d["symbol"],
                "side": side(d["type"]),
                "kind": kind,
                "volume": float(d.get("volume") if kind == "position" else d.get("volume_current") or 0),
                "price": float(d["price_open"]),
                "sl": float(d["sl"] or 0),
                "tp": float(d["tp"] or 0),
                "profit": float(d["profit"]) if kind == "position" else None,
                "potential": potential(d, kind),
                "risk": potential(d, kind, "sl"),
                "swap": float(d.get("swap") or 0),
                "time_utc": opened - off if opened else 0,
                "comment": d.get("comment") or "",
            }

        with self.lock:
            return {
                "connected": True,
                "symbol": self.symbol,
                "positions": [row(p, "position") for p in positions],
                "orders": [row(o, "order") for o in orders],
            }

    def _target_from(self, side: str, volume: float, entry: float, profit: float, info) -> tuple[float, float]:
        """Price at which this fill would earn `profit`. A buy target is above the fill; a sell target is below it."""
        action = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL
        sign = 1 if side == "buy" else -1
        per = mt5.order_calc_profit(action, self.symbol, volume, entry, entry + sign)
        if per is None or per <= 0:
            raise RuntimeError("MetaTrader 5 could not price that order.")
        tick_size = float(info.trade_tick_size or info.point or 0.01)
        digits = int(info.digits)

        def fit(raw: float) -> float:
            if tick_size > 0:
                raw = round(raw / tick_size) * tick_size
            return round(raw, digits)

        tp = fit(entry + sign * (profit / per))
        got = None
        for _ in range(6):
            got = mt5.order_calc_profit(action, self.symbol, volume, entry, tp)
            if got is None or got <= 0:
                break
            if abs(got - profit) < 0.01:
                break
            tp = fit(entry + (tp - entry) * (profit / got))
        if side == "buy" and tp <= entry or side == "sell" and tp >= entry:
            raise RuntimeError("The target would sit on the losing side of the filled price, so it was not set.")
        stops = float(info.trade_stops_level or 0) * float(info.point or 0)
        if stops > 0 and abs(tp - entry) < stops:
            raise RuntimeError("That profit puts the target closer than the broker allows.")
        realized = round(float(got), 2) if got is not None and got > 0 else round(profit, 2)
        return tp, realized

    def _market_request(self, side: str, volume: float, profit: float) -> dict:
        """Build a market order. The target is quoted from the current price and applied again after the fill. Caller holds the lock."""
        if side not in ("buy", "sell"):
            raise RuntimeError("Choose buy or sell.")
        if profit <= 0:
            raise RuntimeError("Enter a profit greater than zero.")
        if not self.connected and not self.connect():
            raise RuntimeError("MetaTrader 5 is not connected.")
        term = mt5.terminal_info()
        if term is not None and not term.trade_allowed:
            raise RuntimeError("Algo Trading is off in MetaTrader 5. Turn it on, then try again.")
        info = mt5.symbol_info(self.symbol)
        tick = mt5.symbol_info_tick(self.symbol)
        if info is None or tick is None:
            raise RuntimeError("Gold price is not available from MetaTrader 5.")
        if not info.visible and not mt5.symbol_select(self.symbol, True):
            raise RuntimeError("MetaTrader 5 could not select the gold symbol.")
        step = float(info.volume_step or 0.01)
        snapped = round(round(volume / step) * step, 8)
        if snapped < float(info.volume_min) or snapped > float(info.volume_max):
            raise RuntimeError(f"Lots must be between {info.volume_min:g} and {info.volume_max:g}.")
        price = float(tick.ask if side == "buy" else tick.bid)
        tp, realized = self._target_from(side, snapped, price, profit, info)
        filling = int(info.filling_mode or 0)
        if filling & 1:
            type_filling = mt5.ORDER_FILLING_FOK
        elif filling & 2:
            type_filling = mt5.ORDER_FILLING_IOC
        else:
            type_filling = mt5.ORDER_FILLING_RETURN
        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": self.symbol,
            "volume": snapped,
            "type": mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL,
            "price": price,
            "sl": 0.0,
            "tp": 0.0,
            "deviation": 30,
            "magic": 251016,
            "comment": "gold app",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": type_filling,
        }
        return {
            "request": request,
            "info": info,
            "plan": {
                "side": side,
                "volume": snapped,
                "profit": realized,
                "price": price,
                "tp": tp,
            },
        }

    def plan_market(self, side: str, volume: float, profit: float) -> dict:
        """Price a market order and its target. Nothing is sent."""
        with self.lock:
            return self._market_request(side, volume, profit)["plan"]

    def place_market(self, side: str, volume: float, profit: float) -> dict:
        """Send a market order, then set the target from the filled price so slippage cannot flip it into a loss."""
        with self.lock:
            built = self._market_request(side, volume, profit)
            request = built["request"]
            check = mt5.order_check(request)
            if check is None or check.retcode not in (0, mt5.TRADE_RETCODE_DONE):
                comment = getattr(check, "comment", None) if check is not None else None
                raise RuntimeError(comment or "MetaTrader 5 rejected the order.")
            result = mt5.order_send(request)
            if result is None or result.retcode not in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED):
                comment = getattr(result, "comment", None) if result is not None else None
                raise RuntimeError(comment or "MetaTrader 5 did not accept the order.")
            position_id = int(result.order or 0)
            if result.deal:
                deals = mt5.history_deals_get(ticket=result.deal)
                if deals:
                    position_id = int(deals[0].position_id)
            opened = mt5.positions_get(ticket=position_id)
            fill = float(opened[0].price_open) if opened else float(result.price or request["price"])
            tp, realized = self._target_from(built["plan"]["side"], request["volume"], fill, profit, built["info"])
            moved = mt5.order_send({
                "action": mt5.TRADE_ACTION_SLTP,
                "symbol": self.symbol,
                "position": position_id,
                "sl": 0.0,
                "tp": tp,
            })
            if moved is None or moved.retcode not in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED):
                comment = getattr(moved, "comment", None) if moved is not None else None
                raise RuntimeError(comment or "The order filled, but the target could not be set.")
            return {
                "side": built["plan"]["side"],
                "volume": request["volume"],
                "profit": realized,
                "price": fill,
                "tp": tp,
                "ticket": position_id,
            }

    def close_trade(self, ticket: int) -> dict:
        """Close an open position at the market, or cancel a waiting order."""
        with self.lock:
            if not self.connected and not self.connect():
                raise RuntimeError("MetaTrader 5 is not connected.")
            term = mt5.terminal_info()
            if term is not None and not term.trade_allowed:
                raise RuntimeError("Algo Trading is off in MetaTrader 5. Turn it on, then try again.")
            held = mt5.positions_get(ticket=ticket)
            if held:
                pos = held[0]
                info = mt5.symbol_info(pos.symbol)
                tick = mt5.symbol_info_tick(pos.symbol)
                if info is None or tick is None:
                    raise RuntimeError("The price for that position is not available.")
                selling = pos.type == mt5.POSITION_TYPE_BUY
                filling = int(info.filling_mode or 0)
                if filling & 1:
                    type_filling = mt5.ORDER_FILLING_FOK
                elif filling & 2:
                    type_filling = mt5.ORDER_FILLING_IOC
                else:
                    type_filling = mt5.ORDER_FILLING_RETURN
                result = mt5.order_send({
                    "action": mt5.TRADE_ACTION_DEAL,
                    "symbol": pos.symbol,
                    "position": int(pos.ticket),
                    "volume": float(pos.volume),
                    "type": mt5.ORDER_TYPE_SELL if selling else mt5.ORDER_TYPE_BUY,
                    "price": float(tick.bid if selling else tick.ask),
                    "deviation": 30,
                    "magic": 251016,
                    "comment": "gold app close",
                    "type_time": mt5.ORDER_TIME_GTC,
                    "type_filling": type_filling,
                })
                if result is None or result.retcode not in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED):
                    comment = getattr(result, "comment", None) if result is not None else None
                    raise RuntimeError(comment or "MetaTrader 5 did not close the position.")
                return {"ticket": int(pos.ticket), "kind": "position", "price": float(result.price or 0)}
            if mt5.orders_get(ticket=ticket):
                result = mt5.order_send({"action": mt5.TRADE_ACTION_REMOVE, "order": int(ticket)})
                if result is None or result.retcode not in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED):
                    comment = getattr(result, "comment", None) if result is not None else None
                    raise RuntimeError(comment or "MetaTrader 5 did not cancel the order.")
                return {"ticket": int(ticket), "kind": "order", "price": 0.0}
            raise RuntimeError("That order is already closed.")

    def account_summary(self, day_start_utc: int) -> dict:
        """Balance, equity, and how much the account made since `day_start_utc`, leaving out deposits and withdrawals."""
        with self.lock:
            if not self.connected and not self.connect():
                return {"connected": False}
            info = mt5.account_info()
            if info is None:
                return {"connected": False}
            off = self.server_offset
            now = int(time.time())
            deals = mt5.history_deals_get(_srv_dt(day_start_utc + off), _srv_dt(now + off + 60)) or ()
            trade_types = (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL)
            realized = 0.0
            moved_cash = 0.0
            carried: list[tuple[int, str, float, float]] = []
            for d in deals:
                cost = float(d.profit) + float(d.commission) + float(d.swap) + float(getattr(d, "fee", 0.0))
                if d.type not in trade_types:
                    moved_cash += cost
                    continue
                realized += cost
                if d.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_INOUT, mt5.DEAL_ENTRY_OUT_BY):
                    opened = mt5.history_deals_get(position=d.position_id) or ()
                    entry = next((e for e in opened if e.entry == mt5.DEAL_ENTRY_IN), None)
                    if entry is not None and int(entry.time) - off < day_start_utc:
                        carried.append((int(entry.type), d.symbol, float(d.volume), float(entry.price)))
            for p in mt5.positions_get() or ():
                if int(p.time) - off < day_start_utc:
                    carried.append((int(p.type), p.symbol, float(p.volume), float(p.price_open)))
            at_midnight = 0.0
            closes: dict[str, float | None] = {}
            for kind, symbol, volume, opened_at in carried:
                if symbol not in closes:
                    bars = mt5.copy_rates_from(symbol, mt5.TIMEFRAME_M1, _srv_dt(day_start_utc + off - 1), 1)
                    closes[symbol] = float(bars[-1]["close"]) if bars is not None and len(bars) else None
                mark = closes[symbol]
                if mark is None:
                    continue
                action = mt5.ORDER_TYPE_SELL if kind == mt5.DEAL_TYPE_SELL else mt5.ORDER_TYPE_BUY
                value = mt5.order_calc_profit(action, symbol, volume, opened_at, mark)
                if value is not None:
                    at_midnight += float(value)
            floating = float(info.profit)
        today = realized + floating - at_midnight
        start_equity = float(info.balance) - realized - moved_cash + at_midnight
        return {
            "connected": True,
            "currency": info.currency,
            "balance": round(float(info.balance), 2),
            "equity": round(float(info.equity), 2),
            "floating": round(floating, 2),
            "margin_free": round(float(info.margin_free), 2),
            "margin_level": round(float(info.margin_level), 1) if info.margin_level else None,
            "margin_used": round(float(info.margin), 2),
            "margin_call": float(info.margin_so_call),
            "stop_out": float(info.margin_so_so),
            "stop_mode_pct": int(info.margin_so_mode) == mt5.ACCOUNT_STOPOUT_MODE_PERCENT,
            "realized_today": round(realized, 2),
            "floating_at_start": round(at_midnight, 2),
            "today": round(today, 2),
            "today_pct": round(100 * today / start_equity, 2) if start_equity > 0 else None,
            "start_equity": round(start_equity, 2),
            "moved_cash_today": round(moved_cash, 2),
        }

    def tick_flow(self, window_s: int = 300, baseline_s: int = 3600) -> dict | None:
        """Buy vs sell pressure from price ticks. Each bid move up counts as a buy tick, each move down as a sell tick."""
        with self.lock:
            if not self.connected and not self.connect():
                return None
            end = int(time.time()) + self.server_offset + 5
            ticks = mt5.copy_ticks_range(self.symbol, _srv_dt(end - baseline_s - 5), _srv_dt(end), mt5.COPY_TICKS_ALL)
        if ticks is None or len(ticks) < 2:
            return None
        cut = (end - 5 - window_s) * 1000
        times = ticks["time_msc"]
        bids = ticks["bid"]
        recent = times >= cut
        moves = bids[1:] - bids[:-1]
        recent_moves = moves[recent[1:]]
        up = int((recent_moves > 0).sum())
        down = int((recent_moves < 0).sum())
        count = int(recent.sum())
        span_min = max(1.0, (int(times[-1]) - int(times[0])) / 60000)
        typical = len(ticks) / span_min
        per_min = count / (window_s / 60)
        recent_bids = bids[recent]
        moved = float(recent_bids[-1] - recent_bids[0]) if len(recent_bids) else 0.0
        return {
            "window_s": window_s,
            "ticks": count,
            "up": up,
            "down": down,
            "buy_pct": round(100 * up / (up + down), 1) if up + down else 50.0,
            "per_min": round(per_min, 1),
            "typical_per_min": round(typical, 1),
            "activity": round(per_min / typical, 2) if typical else None,
            "moved": round(moved, 3),
        }

    def trade_history(self, from_utc: int) -> dict:
        """Closed positions whose exit is at or after `from_utc`. Read only."""
        empty = {
            "connected": False, "from": from_utc, "count": 0, "net": 0.0,
            "wins": 0, "losses": 0, "flat": 0, "best": None, "worst": None,
            "avg_win": None, "avg_loss": None, "truncated": False, "trades": [],
        }
        with self.lock:
            if not self.connected and not self.connect():
                return empty
            off = self.server_offset
            now = int(time.time())
            # Entries can sit before the window, so read a little further back and fetch the rest only when needed.
            deals = mt5.history_deals_get(_srv_dt(from_utc + off - 14 * 86400), _srv_dt(now + off + 120))
            if deals is None:
                log.warning("MT5 history read failed: %s", mt5.last_error())
                return empty
            open_ids = {int(p.ticket) for p in (mt5.positions_get() or ())}
            grouped = _deals_by_position(deals)
            for pid in [pid for pid, group in grouped.items() if not _entries(group)]:
                extra = mt5.history_deals_get(position=pid) or ()
                grouped[pid] = _deals_by_position(extra).get(pid, [])

        rows = []
        for pid, group in grouped.items():
            if pid in open_ids:
                continue
            ins = _entries(group)
            outs = _exits(group)
            if not ins or not outs:
                continue
            close_utc = max(int(d.time) for d in outs) - off
            if close_utc < from_utc:
                continue
            in_vol = sum(float(d.volume) for d in ins)
            out_vol = sum(float(d.volume) for d in outs)
            if in_vol <= 0 or out_vol <= 0:
                continue
            costs = sum(float(d.commission) + float(d.swap) + float(getattr(d, "fee", 0.0) or 0.0) for d in ins + outs)
            net = sum(float(d.profit) for d in ins + outs) + costs
            last = max(outs, key=lambda d: (int(d.time), int(d.ticket)))
            reason = {
                mt5.DEAL_REASON_TP: "target",
                mt5.DEAL_REASON_SL: "stop",
                mt5.DEAL_REASON_SO: "stop out",
            }.get(int(last.reason), "closed")
            if reason == "closed" and "gold app" in (last.comment or "").lower():
                reason = "closed here"
            opened = min(ins, key=lambda d: int(d.time))
            rows.append({
                "position": pid,
                "symbol": opened.symbol,
                "side": "sell" if int(opened.type) == mt5.DEAL_TYPE_SELL else "buy",
                "volume": round(out_vol, 2),
                "open_price": round(sum(float(d.price) * float(d.volume) for d in ins) / in_vol, 5),
                "close_price": round(sum(float(d.price) * float(d.volume) for d in outs) / out_vol, 5),
                "open_utc": int(opened.time) - off,
                "close_utc": close_utc,
                "net": round(net, 2),
                "costs": round(costs, 2),
                "reason": reason,
                "closes": len(outs),
            })
        rows.sort(key=lambda r: r["close_utc"], reverse=True)
        nets = [r["net"] for r in rows]
        win_nets = [n for n in nets if n > 0.005]
        loss_nets = [n for n in nets if n < -0.005]
        cap = 1000
        return {
            "connected": True,
            "from": from_utc,
            "count": len(rows),
            "net": round(sum(nets), 2),
            "wins": len(win_nets),
            "losses": len(loss_nets),
            "flat": len(rows) - len(win_nets) - len(loss_nets),
            "best": round(max(win_nets), 2) if win_nets else None,
            "worst": round(min(loss_nets), 2) if loss_nets else None,
            "avg_win": round(sum(win_nets) / len(win_nets), 2) if win_nets else None,
            "avg_loss": round(sum(loss_nets) / len(loss_nets), 2) if loss_nets else None,
            "truncated": len(rows) > cap,
            "trades": rows[:cap],
        }

    def tick(self) -> dict | None:
        with self.lock:
            if not self.connected and not self.connect():
                return None
            t = mt5.symbol_info_tick(self.symbol)
        if t is None:
            return None
        return {
            "symbol": self.symbol,
            "time_utc": int(t.time) - self.server_offset,
            "time_msc_utc": int(t.time_msc) - self.server_offset * 1000,
            "bid": t.bid,
            "ask": t.ask,
        }

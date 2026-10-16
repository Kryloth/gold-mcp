import sqlite3
import time

import pandas as pd

from .config import TF_SECONDS

IMPORTANCE_LABEL = {0: "none", 1: "low", 2: "moderate", 3: "high"}


def candles_df(conn: sqlite3.Connection, tf: str, start: int | None = None, end: int | None = None,
               limit: int | None = None) -> pd.DataFrame:
    if tf not in TF_SECONDS:
        raise ValueError(f"Unknown timeframe {tf}; use one of {list(TF_SECONDS)}")
    sql = "SELECT time_utc AS time, o AS open, h AS high, l AS low, c AS close, tick_volume, spread FROM candles WHERE tf=?"
    args: list = [tf]
    if start is not None:
        sql += " AND time_utc>=?"
        args.append(int(start))
    if end is not None:
        sql += " AND time_utc<=?"
        args.append(int(end))
    if limit and start is None:
        sql = f"SELECT * FROM ({sql} ORDER BY time_utc DESC LIMIT ?) ORDER BY time"
        args.append(int(limit))
    else:
        sql += " ORDER BY time_utc"
        if limit:
            sql += " LIMIT ?"
            args.append(int(limit))
    return pd.read_sql_query(sql, conn, params=args)


def _event_dict(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["importance_label"] = IMPORTANCE_LABEL.get(d.get("importance"), "?")
    return d


def calendar_events(conn: sqlite3.Connection, start: int, end: int, min_importance: int = 1,
                    currencies: list[str] | None = None, with_reactions: bool = True) -> list[dict]:
    sql = (
        "SELECT e.*, r.surprise, r.surprise_z, r.ret_5m, r.ret_15m, r.ret_1h, r.ret_4h, r.range_1h "
        if with_reactions else "SELECT e.* "
    )
    sql += "FROM calendar_events e "
    if with_reactions:
        sql += "LEFT JOIN event_reactions r ON r.value_id=e.value_id "
    sql += "WHERE e.time_utc BETWEEN ? AND ? AND e.importance>=?"
    args: list = [int(start), int(end), int(min_importance)]
    if currencies:
        sql += f" AND e.currency IN ({','.join('?' * len(currencies))})"
        args += currencies
    sql += " ORDER BY e.time_utc"
    return [_event_dict(r) for r in conn.execute(sql, args)]


def upcoming_events(conn: sqlite3.Connection, hours_ahead: float = 72, min_importance: int = 2,
                    currencies: list[str] | None = None) -> list[dict]:
    now = int(time.time())
    events = calendar_events(conn, now - 900, now + int(hours_ahead * 3600), min_importance, currencies, False)
    return [e for e in events if e["actual"] is None]


def headlines(conn: sqlite3.Connection, start: int, end: int, limit: int = 200, search: str | None = None) -> list[dict]:
    sql = "SELECT * FROM headlines WHERE time_utc BETWEEN ? AND ?"
    args: list = [int(start), int(end)]
    if search:
        sql += " AND title LIKE ?"
        args.append(f"%{search}%")
    sql += " ORDER BY time_utc DESC LIMIT ?"
    args.append(int(limit))
    return [dict(r) for r in conn.execute(sql, args)]


def data_freshness(conn: sqlite3.Connection) -> dict:
    now = int(time.time())
    out = {}
    row = conn.execute("SELECT MAX(time_utc) t FROM candles WHERE tf='M1'").fetchone()
    out["last_m1_bar_utc"] = row["t"]
    out["m1_age_seconds"] = now - row["t"] if row["t"] else None
    row = conn.execute("SELECT value FROM meta WHERE key='calendar_generated_utc'").fetchone()
    out["calendar_exported_utc"] = int(row["value"]) if row else None
    row = conn.execute("SELECT MAX(time_utc) t, COUNT(*) n FROM headlines").fetchone()
    out["latest_headline_utc"], out["headline_count"] = row["t"], row["n"]
    row = conn.execute("SELECT COUNT(*) n FROM calendar_events").fetchone()
    out["calendar_event_count"] = row["n"]
    return out

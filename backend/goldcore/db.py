import sqlite3
from contextlib import contextmanager
from typing import Iterable, Iterator

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS candles (
    tf TEXT NOT NULL,
    time_utc INTEGER NOT NULL,
    o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
    tick_volume INTEGER, spread INTEGER,
    PRIMARY KEY (tf, time_utc)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS calendar_events (
    value_id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL,
    time_utc INTEGER NOT NULL,
    country TEXT, currency TEXT, name TEXT NOT NULL, code TEXT,
    importance INTEGER, sector INTEGER, unit TEXT, multiplier INTEGER DEFAULT 0,
    actual REAL, forecast REAL, previous REAL, revised REAL
);
CREATE INDEX IF NOT EXISTS ix_cal_time ON calendar_events(time_utc);
CREATE INDEX IF NOT EXISTS ix_cal_event ON calendar_events(event_id, time_utc);

CREATE TABLE IF NOT EXISTS headlines (
    url TEXT PRIMARY KEY,
    time_utc INTEGER NOT NULL,
    source TEXT, title TEXT NOT NULL, domain TEXT, tone REAL, query TEXT
);
CREATE INDEX IF NOT EXISTS ix_head_time ON headlines(time_utc);

CREATE TABLE IF NOT EXISTS event_reactions (
    value_id INTEGER PRIMARY KEY,
    event_id INTEGER NOT NULL,
    time_utc INTEGER NOT NULL,
    surprise REAL, surprise_z REAL,
    base_price REAL,
    ret_5m REAL, ret_15m REAL, ret_1h REAL, ret_4h REAL,
    range_1h REAL
);
CREATE INDEX IF NOT EXISTS ix_react_event ON event_reactions(event_id);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


def connect(readonly: bool = False) -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    if readonly and DB_PATH.exists():
        conn = sqlite3.connect(f"file:{DB_PATH.as_posix()}?mode=ro", uri=True, timeout=30, check_same_thread=False)
    else:
        conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        _migrate(conn)
    conn.row_factory = sqlite3.Row
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    cols = {r[1] for r in conn.execute("PRAGMA table_info(calendar_events)")}
    if "multiplier" not in cols:
        conn.execute("ALTER TABLE calendar_events ADD COLUMN multiplier INTEGER DEFAULT 0")
        # Force the next ingest to re-read the export so the new column gets filled.
        conn.execute("DELETE FROM meta WHERE key='calendar_file_mtime'")
        conn.commit()


@contextmanager
def session(readonly: bool = False) -> Iterator[sqlite3.Connection]:
    conn = connect(readonly)
    try:
        yield conn
        if not readonly:
            conn.commit()
    finally:
        conn.close()


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))


def get_meta(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def upsert_candles(conn: sqlite3.Connection, tf: str, rows: Iterable[tuple]) -> int:
    cur = conn.executemany(
        "INSERT INTO candles(tf, time_utc, o, h, l, c, tick_volume, spread) VALUES(?,?,?,?,?,?,?,?) "
        "ON CONFLICT(tf, time_utc) DO UPDATE SET o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, "
        "tick_volume=excluded.tick_volume, spread=excluded.spread",
        ((tf, *r) for r in rows),
    )
    return cur.rowcount


def upsert_calendar(conn: sqlite3.Connection, rows: Iterable[dict]) -> int:
    cur = conn.executemany(
        "INSERT INTO calendar_events(value_id, event_id, time_utc, country, currency, name, code, importance, sector, unit, "
        "multiplier, actual, forecast, previous, revised) VALUES(:value_id,:event_id,:time_utc,:country,:currency,:name,"
        ":code,:importance,:sector,:unit,:multiplier,:actual,:forecast,:previous,:revised) "
        "ON CONFLICT(value_id) DO UPDATE SET time_utc=excluded.time_utc, actual=excluded.actual, "
        "forecast=excluded.forecast, previous=excluded.previous, revised=excluded.revised, importance=excluded.importance, "
        "multiplier=excluded.multiplier, unit=excluded.unit",
        rows,
    )
    return cur.rowcount


def insert_headlines(conn: sqlite3.Connection, rows: Iterable[dict]) -> int:
    before = conn.total_changes
    conn.executemany(
        "INSERT OR IGNORE INTO headlines(url, time_utc, source, title, domain, tone, query) "
        "VALUES(:url,:time_utc,:source,:title,:domain,:tone,:query)",
        rows,
    )
    return conn.total_changes - before

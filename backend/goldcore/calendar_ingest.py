import json
import logging
from pathlib import Path

from . import db
from .config import CALENDAR_FILE

log = logging.getLogger(__name__)


def _num(v):
    return None if v is None else float(v)


def _read_text(path: Path) -> str:
    raw = path.read_bytes()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    return raw.decode("utf-8-sig")


def ingest(path: Path = CALENDAR_FILE) -> int:
    if not path.exists():
        log.info("Calendar file not found at %s (is the GoldCalendarExport service running?)", path)
        return 0
    mtime = str(int(path.stat().st_mtime))
    with db.session() as conn:
        if db.get_meta(conn, "calendar_file_mtime") == mtime:
            return 0
    try:
        payload = json.loads(_read_text(path))
    except (ValueError, OSError) as e:
        log.warning("Could not read calendar file: %s", e)
        return 0

    offset = int(payload.get("gmt_offset", 0))
    rows = [
        {
            "value_id": int(v["value_id"]),
            "event_id": int(v["event_id"]),
            "time_utc": int(v["time_server"]) - offset,
            "country": v.get("country"),
            "currency": v.get("currency"),
            "name": v["name"],
            "code": v.get("code"),
            "importance": int(v.get("importance", 0)),
            "sector": int(v.get("sector", 0)),
            "unit": (v.get("unit") or "").replace("CALENDAR_UNIT_", "").lower(),
            "multiplier": int(v.get("multiplier", 0)),
            "actual": _num(v.get("actual")),
            "forecast": _num(v.get("forecast")),
            "previous": _num(v.get("previous")),
            "revised": _num(v.get("revised")),
        }
        for v in payload.get("values", [])
    ]
    with db.session() as conn:
        db.upsert_calendar(conn, rows)
        db.set_meta(conn, "calendar_file_mtime", mtime)
        db.set_meta(conn, "calendar_generated_utc", str(int(payload.get("generated_at_server", 0)) - offset))
    log.info("Ingested %d calendar values", len(rows))
    return len(rows)

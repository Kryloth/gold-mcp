"""Install the MetaTrader calendar service so a new user never has to add it by hand.

MetaTrader reads the service list only when it starts, and it rewrites that list when it
closes. The list is updated only while the terminal is not running.
"""
import logging
import os
import shutil
import subprocess
from pathlib import Path

from .config import ROOT

log = logging.getLogger(__name__)

SERVICE_NAME = "GoldCalendarExport"
SOURCE = ROOT / "mql5" / "GoldCalendarExport.mq5"
SERVICE_BLOCK = """<service>
name=GoldCalendarExport
path=Services\\GoldCalendarExport.ex5
expertmode=1
enabled=1
<inputs>
InpCurrencies=USD,EUR,CNY,GBP,JPY
InpMinImportance=1
InpHistoryDays=730
InpAheadDays=14
InpIntervalSec=300
InpFileName=gold_calendar.json
</inputs>
</service>
"""

READY = 0
FAILED = 1
RESTART = 2


def _read(path: Path) -> str:
    raw = path.read_bytes()
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff") or b"\x00" in raw[:8]:
        return raw.decode("utf-16")
    return raw.decode("utf-8-sig")


def _write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-16")


def _terminals() -> list[Path]:
    root = Path(os.environ.get("APPDATA", "")) / "MetaQuotes" / "Terminal"
    if not root.is_dir():
        return []
    return [p for p in root.iterdir() if (p / "origin.txt").is_file() and (p / "MQL5").is_dir()]


def _running() -> bool:
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq terminal64.exe", "/NH"],
            capture_output=True, text=True, timeout=15, check=False,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return False
    return "terminal64.exe" in out.lower()


def _compile(editor: Path, mq5: Path) -> bool:
    ex5 = mq5.with_suffix(".ex5")
    before = ex5.stat().st_mtime if ex5.exists() else 0
    try:
        subprocess.run([str(editor), f"/compile:{mq5}", "/log"], timeout=120, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.warning("MetaEditor did not compile the calendar service: %s", exc)
        return ex5.exists()
    if not ex5.exists() or ex5.stat().st_mtime < before:
        log.warning("MetaEditor produced no calendar program at %s", ex5)
        return False
    return True


def _text(path: Path) -> str:
    raw = path.read_bytes()
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff") or b"\x00" in raw[:8]:
        text = raw.decode("utf-16")
    else:
        text = raw.decode("utf-8-sig")
    return "\n".join(line.rstrip() for line in text.splitlines() if line.strip())


def _ensure_service(data: Path, running: bool) -> int:
    """Copy and compile the service, then switch it on if MetaTrader is closed. Returns a status code."""
    services = data / "MQL5" / "Services"
    services.mkdir(parents=True, exist_ok=True)
    dest = services / SOURCE.name
    if not dest.exists() or _text(dest) != _text(SOURCE):
        shutil.copyfile(SOURCE, dest)

    origin = _read(data / "origin.txt").strip().strip("\x00")
    editor = Path(origin) / "metaeditor64.exe"
    ex5 = dest.with_suffix(".ex5")
    if editor.is_file() and (not ex5.exists() or dest.stat().st_mtime > ex5.stat().st_mtime):
        if not _compile(editor, dest) and not ex5.exists():
            return FAILED
    elif not ex5.exists():
        log.warning("MetaEditor was not found at %s", editor)
        return FAILED

    ini = data / "config" / "services.ini"
    current = _read(ini) if ini.exists() else ""
    if f"name={SERVICE_NAME}" in current:
        return READY
    if running:
        return RESTART
    ini.parent.mkdir(parents=True, exist_ok=True)
    block = SERVICE_BLOCK.replace("\n", "\r\n")
    _write(ini, (current.rstrip() + "\r\n" if current.strip() else "") + block)
    _allow_services(data)
    log.info("Calendar service switched on for %s", data.name)
    return READY


def _allow_services(data: Path) -> None:
    """A zero Services flag in common.ini keeps every service off. Only written while MetaTrader is closed."""
    ini = data / "config" / "common.ini"
    if not ini.exists():
        return
    text = _read(ini)
    if "Services=0" not in text.splitlines():
        return
    lines = ["Services=4294967295" if line == "Services=0" else line for line in text.splitlines()]
    _write(ini, "\r\n".join(lines) + ("\r\n" if text.endswith(("\n", "\r")) else ""))


def install_calendar_service() -> int:
    """Install GoldCalendarExport into every MetaTrader on this PC. Returns READY, FAILED, or RESTART."""
    if not SOURCE.is_file():
        log.warning("Calendar source is missing: %s", SOURCE)
        return FAILED
    folders = _terminals()
    if not folders:
        log.warning("No MetaTrader data folder found. Open MetaTrader once, then start the app again.")
        return FAILED
    running = _running()
    codes = [_ensure_service(folder, running) for folder in folders]
    if RESTART in codes:
        log.warning("Close MetaTrader, run start.bat again, then open MetaTrader. The calendar service starts with it.")
        return RESTART
    if all(code == FAILED for code in codes):
        return FAILED
    return READY


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    code = install_calendar_service()
    if code == READY:
        print("Calendar service is ready.")
    elif code == RESTART:
        print("Close MetaTrader completely, then double-click start.bat again.")
        print("That switches the calendar on. Open MetaTrader after that, then double-click start.bat once more.")
    else:
        print("The calendar service could not be installed. The app can still open, but the news tabs may be empty.")
    return code


if __name__ == "__main__":
    raise SystemExit(main())

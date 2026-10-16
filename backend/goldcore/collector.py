"""Background collection loops. Run standalone with `python -m goldcore.collector`."""
import logging
import threading
import time

from . import analytics, calendar_ingest, headlines
from .config import ANALYTICS_SECONDS, CALENDAR_INGEST_SECONDS, HEADLINE_POLL_SECONDS, MT5_SYNC_SECONDS
from .mt5_feed import MT5Feed

log = logging.getLogger(__name__)


class Collector:
    def __init__(self, feed: MT5Feed | None = None):
        self.feed = feed or MT5Feed()
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self.status: dict[str, dict] = {}

    def _run(self, name: str, fn, interval: float, initial_delay: float = 0) -> None:
        if self._stop.wait(initial_delay):
            return
        while not self._stop.is_set():
            started = time.time()
            try:
                result = fn()
                self.status[name] = {"ok": True, "last_run": int(started), "result": result}
            except Exception as e:
                log.exception("%s failed", name)
                self.status[name] = {"ok": False, "last_run": int(started), "error": str(e)}
            self._stop.wait(max(1.0, interval - (time.time() - started)))

    def _calendar(self) -> int:
        n = calendar_ingest.ingest()
        if n:
            analytics.compute_event_reactions()
        return n

    def _news(self) -> int:
        added = headlines.poll_rss()
        added += headlines.poll_gdelt("1h")
        added += headlines.backfill_gdelt()
        return added

    def start(self) -> None:
        jobs = [
            ("mt5", self.feed.sync_all, MT5_SYNC_SECONDS, 0),
            ("calendar", self._calendar, CALENDAR_INGEST_SECONDS, 2),
            ("headlines", self._news, HEADLINE_POLL_SECONDS, 5),
            ("analytics", analytics.compute_event_reactions, ANALYTICS_SECONDS, 30),
        ]
        for name, fn, interval, delay in jobs:
            t = threading.Thread(target=self._run, args=(name, fn, interval, delay), name=f"collector-{name}", daemon=True)
            t.start()
            self._threads.append(t)

    def stop(self) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout=15)
        self.feed.shutdown()


def main() -> None:
    import argparse

    from . import db

    parser = argparse.ArgumentParser(description="Run the gold data collectors")
    parser.add_argument("--rebackfill", action="store_true",
                        help="re-run the MT5 history backfill (e.g. after raising 'Max bars in chart')")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if args.rebackfill:
        with db.session() as conn:
            conn.execute("DELETE FROM meta WHERE key LIKE 'backfilled_%'")
    c = Collector()
    c.start()
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        c.stop()


if __name__ == "__main__":
    main()

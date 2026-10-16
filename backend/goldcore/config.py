import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _settings_file() -> dict[str, str]:
    path = ROOT / "settings.txt"
    found: dict[str, str] = {}
    if not path.is_file():
        return found
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        found[key.strip().lower()] = value.strip()
    return found


_settings = _settings_file()

SYMBOL = _settings.get("symbol") or os.environ.get("GOLD_SYMBOL") or "XAUUSD247m"
DB_PATH = Path(os.environ.get("GOLD_DB", ROOT / "data" / "gold.db"))

TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"]
TF_SECONDS = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600, "H4": 14400, "D1": 86400}
LOOKBACK_DAYS = int(os.environ.get("GOLD_LOOKBACK_DAYS", "730"))

MT5_SYNC_SECONDS = 60
CALENDAR_INGEST_SECONDS = 300
HEADLINE_POLL_SECONDS = 900
ANALYTICS_SECONDS = 1800

CALENDAR_FILE_NAME = "gold_calendar.json"
CALENDAR_FILE = Path(
    os.environ.get(
        "GOLD_CALENDAR_FILE",
        Path(os.environ.get("APPDATA", "")) / "MetaQuotes" / "Terminal" / "Common" / "Files" / CALENDAR_FILE_NAME,
    )
)

GDELT_QUERIES = {
    "gold": '(gold OR bullion OR XAUUSD) (price OR prices OR ounce)',
    "fed": '("Federal Reserve" OR FOMC OR Powell OR Warsh) (rates OR hike OR cut)',
    "inflation": '("consumer price index" OR CPI OR inflation) ("United States" OR US)',
    "dollar": '("US dollar" OR "dollar index" OR DXY OR "Treasury yields")',
    "geopolitics": '(war OR missile OR sanctions OR "Strait of Hormuz" OR ceasefire) (oil OR markets)',
}

RSS_FEEDS = {
    "fxstreet_news": "https://www.fxstreet.com/rss/news",
    "fxstreet_analysis": "https://www.fxstreet.com/rss/analysis",
    "investing_metals": "https://www.investing.com/rss/commodities_Metals.rss",
    "investing_news": "https://www.investing.com/rss/news_11.rss",
    "mining_com_gold": "https://www.mining.com/commodity/gold/feed/",
}
GDELT_MIN_INTERVAL_SECONDS = 10
RSS_KEYWORDS = (
    "gold", "xau", "bullion", "precious", "fed", "fomc", "powell", "warsh", "rate hike", "rate cut",
    "inflation", "cpi", "ppi", "pce", "payroll", "nfp", "jobless", "dollar", "usd", "yield", "treasur",
    "hormuz", "iran", "israel", "russia", "ukraine", "sanction", "tariff", "war", "missile", "central bank",
)

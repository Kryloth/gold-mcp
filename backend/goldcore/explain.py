"""Plain-English descriptions of calendar events, price moves and news, for beginners."""
import re
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache

import numpy as np

from . import analytics, queries

REGION = {"USD": "US", "EUR": "Eurozone", "GBP": "UK", "JPY": "Japan", "CNY": "China"}

# (pattern, plain name, what it is, why it matters for gold). First match wins, so specific patterns go first.
GLOSSARY: list[tuple[str, str, str, str]] = [
    (r"interest rate decision|fomc statement|rate statement",
     "Interest rate decision", "The central bank decides its main interest rate.",
     "Higher rates make interest-paying assets more attractive than gold, so hikes usually push gold down and cuts push it up."),
    (r"fomc press conference|fomc economic projections|fomc minutes|beige book",
     "Fed meeting details", "Extra detail on what the US central bank (the Fed) is thinking.",
     "Hints about future rate hikes usually hurt gold; hints about cuts usually help it."),
    (r"(chair|governor|president|member|speech|testimony)",
     "Central bank speech", "A central bank official speaks in public.",
     "Comments about future interest rates can move gold quickly, especially from the Fed Chair."),
    (r"nonfarm payrolls|private nonfarm",
     "Jobs report (new jobs added)", "How many jobs the US economy added last month.",
     "Strong hiring means the Fed can keep rates high, which usually weighs on gold. Weak hiring usually helps gold."),
    (r"adp nonfarm",
     "Private jobs estimate (ADP)", "An early estimate of private-sector hiring, two days before the official jobs report.",
     "Often read as a preview of the main jobs report."),
    (r"unemployment rate",
     "Unemployment rate", "The share of people who want a job but can't find one.",
     "Rising unemployment makes rate cuts more likely, which usually helps gold."),
    (r"jobless claims",
     "Weekly unemployment claims", "How many people filed for unemployment benefits last week.",
     "More claims point to a weaker job market, which usually helps gold."),
    (r"jolts",
     "Job openings", "How many jobs employers are trying to fill.",
     "Fewer openings point to a cooling economy, which usually helps gold."),
    (r"average hourly earnings|employment cost|unit labor",
     "Wage growth", "How fast pay is rising.",
     "Fast wage growth keeps inflation and interest rates high, which usually weighs on gold."),
    (r"core pce|pce price",
     "Inflation (Fed's favourite measure)", "The PCE price index, the inflation gauge the Fed targets.",
     "Hotter inflation means higher rates for longer, which usually weighs on gold in the short term."),
    (r"\bcpi\b|consumer price|hicp",
     "Inflation (consumer prices)", "How fast prices of everyday goods and services are rising.",
     "Hotter-than-expected inflation means rates stay high, which usually pushes gold down in the short term."),
    (r"\bppi\b|producer price",
     "Inflation (producer prices)", "How fast prices charged by businesses are rising; an early sign for consumer inflation.",
     "Higher producer prices can mean higher inflation ahead, which usually weighs on gold."),
    (r"inflation expectations",
     "Inflation expectations", "How much inflation people expect in the future.",
     "Higher expected inflation can support gold as a store of value, but can also mean higher rates."),
    (r"retail sales|retail control",
     "Shopping / consumer spending", "How much people spent in shops last month.",
     "Strong spending means a strong economy and possibly higher rates, which usually weighs on gold."),
    (r"\bgdp\b",
     "Economic growth (GDP)", "How fast the whole economy grew.",
     "Strong growth tends to weigh on gold; weak growth or recession fears tend to help it."),
    (r"\bpmi\b|ism |business barometer|empire state|philadelphia fed",
     "Business activity survey", "A survey asking companies whether business is getting better or worse.",
     "Weak readings raise growth worries, which usually help gold."),
    (r"consumer sentiment|consumer confidence|consumer expectations",
     "Consumer mood survey", "How confident people feel about the economy.",
     "Usually a smaller effect on gold."),
    (r"industrial production|factory orders|durable goods",
     "Factory output and orders", "How much factories produced or were asked to produce.",
     "Usually a smaller effect on gold."),
    (r"home sales|housing starts|building permits|hpi|construction",
     "Housing market data", "Activity in the housing market.",
     "Usually a smaller effect on gold."),
    (r"crude oil|rig count",
     "Oil supply data", "US oil stockpiles or drilling activity.",
     "Moves oil prices; gold is affected only indirectly."),
    (r"trade balance|current account|exports|imports",
     "Trade balance", "Exports minus imports.",
     "Usually a smaller effect on gold."),
    (r"auction",
     "Government bond auction", "The government borrows money by selling bonds.",
     "Weak demand can push bond yields up, which can weigh on gold."),
    (r"cftc gold",
     "Big traders' gold positions", "How many bets large speculators hold on gold rising vs falling.",
     "Shows positioning; usually not a short-term driver."),
]

HEADLINE_TOPICS: dict[str, str] = {
    "Interest rates & central banks": r"\b(fed|fomc|powell|warsh|rate hike|rate cut|rates?|central bank|ecb|boe|boj|pboc)\b",
    "Inflation": r"\b(inflation|cpi|ppi|pce|prices)\b",
    "US dollar & bond yields": r"\b(dollar|usd|dxy|yields?|treasur\w*|bonds?)\b",
    "Wars & world tensions": r"\b(war|missiles?|attacks?|strikes?|hormuz|iran\w*|israel\w*|houthis?|russia\w*|ukrain\w*|sanctions?|ceasefire|military|projectiles?)\b",
    "Jobs & economy": r"\b(jobs?|payrolls?|unemployment|jobless|gdp|retail sales|recession|growth|economy)\b",
    "Oil & energy": r"\b(oil|crude|opec|wti|brent|energy|shipping)\b",
    "Trade & tariffs": r"\b(tariffs?|trade war|trade deal|exports?|imports?)\b",
    "Gold & metals": r"\b(gold|xau|bullion|silver|precious|platinum|mining|miners?)\b",
}
_TOPIC_RE = {k: re.compile(v, re.IGNORECASE) for k, v in HEADLINE_TOPICS.items()}
_SUFFIX = {1: "K", 2: "M", 3: "B", 4: "T"}


@lru_cache(maxsize=4096)
def describe_event(name: str, currency: str) -> dict:
    region = REGION.get(currency, currency)
    for pattern, plain, what, why in GLOSSARY:
        if re.search(pattern, name, re.IGNORECASE):
            # Speeches and meeting documents are already readable and the speaker/document name matters.
            label = name if plain in ("Central bank speech", "Fed meeting details") else plain
            return {"plain_name": f"{region} {label}", "what_it_is": what, "why_it_matters": why}
    return {"plain_name": f"{region} {name}", "what_it_is": None, "why_it_matters": None}


def fmt_value(v: float | None, unit: str | None, multiplier: int | None) -> str | None:
    if v is None:
        return None
    unit = unit or ""
    if unit == "percent":
        return f"{v:g}%"
    suffix = _SUFFIX.get(int(multiplier or 0), "")
    s = f"{v:,.3f}".rstrip("0").rstrip(".") + suffix
    return f"${s}" if unit == "currency" else s


def result_vs_forecast(e: dict) -> tuple[str | None, str | None]:
    """Returns (short label, sentence) comparing actual with the forecast (or previous if no forecast)."""
    a, f, p = e.get("actual"), e.get("forecast"), e.get("previous")
    if a is None:
        return None, None
    fa = fmt_value(a, e.get("unit"), e.get("multiplier"))
    if f is not None:
        ff = fmt_value(f, e.get("unit"), e.get("multiplier"))
        if abs(a - f) < 1e-9:
            return "as expected", f"came in as expected ({fa})"
        label = "higher than expected" if a > f else "lower than expected"
        return label, f"came in {label} ({fa} vs {ff} expected)"
    if p is not None:
        fp = fmt_value(p, e.get("unit"), e.get("multiplier"))
        label = "up from last time" if a > p else "down from last time" if a < p else "same as last time"
        return label, f"came in at {fa}, {label} ({fp})"
    return "released", f"came in at {fa}"


def _usual(block: dict | None) -> tuple[str | None, int]:
    d = (block or {}).get("ret_1h")
    if not d or d["n"] < 3:
        return None, 0
    ups = round(d["pct_up"] * d["n"] / 100)
    caution = f"; only {d['n']} past cases, so this could be chance" if d["n"] < 6 else ""
    if d["pct_up"] >= 65:
        return (f"gold usually rose (up {ups} of {d['n']} times, typically about ${d['median_abs']:.0f} within an hour"
                f"{caution})"), d["n"]
    if d["pct_up"] <= 35:
        return (f"gold usually fell (down {d['n'] - ups} of {d['n']} times, typically about ${d['median_abs']:.0f} "
                f"within an hour{caution})"), d["n"]
    return f"gold went either way (no clear pattern in {d['n']} past releases)", d["n"]


def history_sentences(stats: dict) -> dict:
    """Plain-English summary of an event's past gold reactions."""
    allb = (stats.get("all") or {}).get("ret_1h")
    out = {"typical_move_1h": allb["median_abs"] if allb else None, "samples": stats.get("samples", 0)}
    if not allb:
        out["summary"] = "Not enough history yet to say how gold usually reacts."
        return out
    out["summary"] = (f"Over the last {allb['n']} releases, gold typically moved about ${allb['median_abs']:.0f} "
                      f"(up or down) in the hour after this news.")
    hi, _ = _usual(stats.get("beat_forecast"))
    lo, _ = _usual(stats.get("missed_forecast"))
    if hi:
        out["if_higher"] = f"When it came in higher than expected, {hi}."
    if lo:
        out["if_lower"] = f"When it came in lower than expected, {lo}."
    return out


def _gold_move(v: float | None, horizon: str) -> str | None:
    if v is None:
        return None
    verb = "rose" if v > 0 else "fell" if v < 0 else "was flat"
    return f"Gold {verb} ${abs(v):.2f} in the next {horizon}" if v else f"Gold was flat over the next {horizon}"


def enrich_event(e: dict) -> dict:
    d = describe_event(e["name"], e.get("currency") or "")
    label, sentence = result_vs_forecast(e)
    e.update(d)
    e["result_label"] = label
    e["result_text"] = f"{d['plain_name']} {sentence}." if sentence else None
    e["gold_reaction_text"] = _gold_move(e.get("ret_1h"), "hour")
    for k in ("actual", "forecast", "previous"):
        e[f"{k}_text"] = fmt_value(e.get(k), e.get("unit"), e.get("multiplier"))
    return e


def explain_event(conn, e: dict) -> dict:
    """Full beginner explanation for one calendar value (past or upcoming)."""
    e = enrich_event(dict(e))
    stats = analytics.event_reaction_stats(conn, int(e["event_id"]))
    e["history"] = history_sentences(stats)
    return e


def classify_headline(title: str) -> list[str]:
    return [k for k, rx in _TOPIC_RE.items() if rx.search(title)]


def _clock(ts: int, tz_minutes: int) -> str:
    return (datetime.fromtimestamp(ts, timezone.utc) + timedelta(minutes=tz_minutes)).strftime("%H:%M")


def _mood(tones: list[float]) -> str:
    if not tones:
        return "no headlines collected"
    m = float(np.mean(tones))
    if m > 0.15:
        return "leaning positive for gold"
    if m < -0.15:
        return "leaning negative for gold"
    return "mixed"


def day_digest(conn, day_start: int, tz_minutes: int) -> dict:
    day_end = day_start + 86400
    now = int(time.time())
    local_date = datetime.fromtimestamp(day_start, timezone.utc) + timedelta(minutes=tz_minutes)
    out: dict = {"date": local_date.strftime("%Y-%m-%d"), "weekday": local_date.strftime("%A"),
                 "start_utc": day_start, "end_utc": min(day_end, now), "is_today": day_start <= now < day_end}

    h1 = queries.candles_df(conn, "H1", day_start, day_end - 1)
    sentences: list[str] = []
    if not h1.empty:
        o, c = float(h1["open"].iloc[0]), float(h1["close"].iloc[-1])
        hi, lo = float(h1["high"].max()), float(h1["low"].min())
        chg = c - o
        out["price"] = {"open": o, "close": c, "high": hi, "low": lo, "change": round(chg, 2),
                        "change_pct": round(chg / o * 100, 2)}
        verb = "rose" if chg > 0 else "fell"
        so_far = " since midnight" if out["is_today"] else ""
        sentences.append(f"Gold {verb} ${abs(chg):.2f} ({abs(chg) / o * 100:.1f}%){so_far}, "
                         f"trading between ${lo:,.2f} and ${hi:,.2f} (a ${hi - lo:.0f} range).")
        h1 = h1.assign(move=h1["close"] - h1["open"])
        big = h1.loc[h1["move"].abs().idxmax()]
        out["biggest_hour"] = {"time_utc": int(big["time"]), "move": round(float(big["move"]), 2)}

    events = [enrich_event(e) for e in queries.calendar_events(conn, day_start, min(day_end, now), 2)]
    # Non-US releases only matter for gold when they are major, well-known reports.
    events = [e for e in events if e["currency"] == "USD" or (e["importance"] >= 3 and e["what_it_is"])]
    groups: dict[int, list[dict]] = {}
    for e in events:
        groups.setdefault(int(e["time_utc"]), []).append(e)
    key_releases = []
    for t, grp in groups.items():
        # Prefer the headline number a news report would quote (e.g. "CPI y/y 3.7%" rather than the raw index level).
        lead = sorted(grp, key=lambda x: (x["importance"], x["forecast"] is not None, x["currency"] == "USD",
                                          x["unit"] in ("percent", "job"), "y/y" in x["name"]), reverse=True)[0]
        move = next((x["ret_1h"] for x in grp if x.get("ret_1h") is not None), None)
        key_releases.append({
            "time_utc": t, "time_local": _clock(t, tz_minutes), "importance": lead["importance"],
            "plain_name": lead["plain_name"], "name": lead["name"], "currency": lead["currency"],
            "text": lead["result_text"] or f"{lead['plain_name']}.",
            "gold_reaction": move, "gold_reaction_text": _gold_move(move, "hour"),
            "also_released": list(dict.fromkeys(x["plain_name"] for x in grp
                                                if x is not lead and x["plain_name"] != lead["plain_name"]))[:4],
            "value_id": lead["value_id"],
        })
    key_releases.sort(key=lambda r: (abs(r["gold_reaction"] or 0), r["importance"]), reverse=True)
    out["key_releases"] = key_releases[:4]

    if out.get("biggest_hour") and key_releases:
        bt = out["biggest_hour"]["time_utc"]
        cause = next((r for r in key_releases if bt - 900 <= r["time_utc"] < bt + 3600), None)
        if cause and abs(out["biggest_hour"]["move"]) >= 0.3 * (out["price"]["high"] - out["price"]["low"]):
            direction = "drop" if out["biggest_hour"]["move"] < 0 else "jump"
            sentences.append(f"The biggest {direction} (${abs(out['biggest_hour']['move']):.0f} in one hour) came at "
                             f"{cause['time_local']}, right after this news: {cause['text']}")
    elif not key_releases:
        sentences.append("There were no major scheduled economic releases.")

    heads = queries.headlines(conn, day_start, day_end - 1, limit=500)
    topic_count: dict[str, list[dict]] = {}
    for h in heads:
        for t in classify_headline(h["title"]):
            topic_count.setdefault(t, []).append(h)
    topics = sorted(topic_count.items(), key=lambda kv: len(kv[1]), reverse=True)[:4]
    out["topics"] = [{"topic": t, "count": len(hs),
                      "examples": [{"title": h["title"], "url": h["url"], "time_utc": h["time_utc"]} for h in hs[:3]]}
                     for t, hs in topics]
    out["headline_count"] = len(heads)
    out["news_mood"] = _mood([h["tone"] for h in heads if h["tone"] is not None])
    if topics:
        names = [re.sub(r"^US ", "the US ", t) if t.startswith("US ") else t.lower() for t, _ in topics[:3]]
        listed = names[0] if len(names) == 1 else ", ".join(names[:-1]) + f" and {names[-1]}"
        sentences.append(f"The news was mostly about {listed}; overall headline mood was {out['news_mood']}.")
    if out["weekday"] in ("Saturday", "Sunday") and out.get("price") and out["price"]["high"] - out["price"]["low"] < 15:
        sentences.append("Weekend trading is usually quiet because the main gold markets are closed.")
    out["summary"] = " ".join(sentences) if sentences else "No data for this day yet."
    return out


def digest(conn, days: int = 7, tz_minutes: int = 0) -> list[dict]:
    now = int(time.time())
    local_now = datetime.fromtimestamp(now, timezone.utc) + timedelta(minutes=tz_minutes)
    local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_start = int((local_midnight - timedelta(minutes=tz_minutes)).replace(tzinfo=timezone.utc).timestamp())
    return [day_digest(conn, today_start - i * 86400, tz_minutes) for i in range(max(1, min(days, 60)))]


def outlook(conn, horizon_hours: float = 4, tz_minutes: int = 0) -> dict:
    est = analytics.estimate_swing_range(conn, horizon_hours)
    if "error" in est:
        return est
    h = est["horizon_hours"]
    hours = f"{h:g} hour" + ("" if h == 1 else "s")
    period = f"{h:g}-hour"
    lo, hi = est["price_band_80pct"]
    rng, rng80 = est["expected_high_low_range"]["median"], est["expected_high_low_range"]["p80"]
    bias = est["directional_bias"]
    lean = {"bullish": "slightly up", "bearish": "slightly down"}.get(bias["label"], "no clear direction")
    trend_words = {"up": "rising", "down": "falling", "mixed": "mixed"}
    why = []
    comps = bias["components"]
    if comps.get("H4_trend"):
        why.append(f"the price trend over the last few days is {trend_words.get(comps['H4_trend'], 'mixed')}")
    if comps.get("H1_trend"):
        why.append(f"the last few hours are {trend_words.get(comps['H1_trend'], 'mixed')}")
    tone = comps.get("headline_tone_24h")
    if tone is not None:
        why.append("today's headlines lean " + ("positive" if tone > 0.15 else "negative" if tone < -0.15 else "neutral") + " for gold")

    watch = []
    seen_times = set()
    for e in sorted(est.get("events_in_window", []), key=lambda x: x.get("hist_median_abs_1h_move") or 0, reverse=True):
        if e["time_utc"] in seen_times:
            continue
        seen_times.add(e["time_utc"])
        d = describe_event(e["name"], e.get("currency", "USD"))
        move = e.get("hist_median_abs_1h_move")
        watch.append({
            "time_utc": e["time_utc"], "time_local": _clock(e["time_utc"], tz_minutes), "plain_name": d["plain_name"],
            "name": e["name"], "importance": e["importance"],
            "text": (f"{d['plain_name']} at {_clock(e['time_utc'], tz_minutes)} usually moves gold about ${move:.0f} "
                     f"within an hour." if move else f"{d['plain_name']} at {_clock(e['time_utc'], tz_minutes)}."),
        })
    calm = est["event_volatility_multiplier"] < 1.05

    return {
        "horizon_hours": h,
        "price": est["price"],
        "likely_low": lo,
        "likely_high": hi,
        "typical_swing": rng,
        "big_swing": rng80,
        "lean": lean,
        "headline": f"In {hours}, gold will most likely be between ${lo:,.2f} and ${hi:,.2f}.",
        "explain_range": (f"This range was right about 8 out of 10 times in similar {period} periods over the last 60 days. "
                          f"1 in 10 times the price ended higher, and 1 in 10 times lower."),
        "explain_swing": (f"Along the way, expect the price to swing about ${rng:.0f} between its lowest and highest point. "
                          f"Bigger swings of ${rng80:.0f} or more happen about 1 in 5 times."),
        "explain_lean": (f"Leaning {lean}: " + (", ".join(why) if why else "no strong signals") +
                         ". This is a weak hint, not a forecast; the range above is the more reliable part."),
        "events_note": ("No major scheduled news in this window, so moves may be calmer than usual." if calm and not watch
                        else "Scheduled news in this window can cause sudden jumps, so the range has been widened."),
        "watch_out": sorted(watch, key=lambda w: w["time_utc"])[:5],
        "technical": est,
    }

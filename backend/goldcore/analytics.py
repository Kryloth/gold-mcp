import logging
import math
import time

import numpy as np
import pandas as pd

from . import db, queries
from .config import TF_SECONDS

log = logging.getLogger(__name__)

HORIZONS = {"ret_5m": 300, "ret_15m": 900, "ret_1h": 3600, "ret_4h": 14400}


class _Series:
    """Fast "price at time t" lookups over one timeframe's candles."""

    def __init__(self, df: pd.DataFrame, tf: str):
        self.tf = tf
        self.step = TF_SECONDS[tf]
        self.t = df["time"].to_numpy(dtype=np.int64)
        self.o = df["open"].to_numpy()
        self.h = df["high"].to_numpy()
        self.l = df["low"].to_numpy()
        self.c = df["close"].to_numpy()

    def covers(self, start: int, end: int) -> bool:
        return len(self.t) > 0 and self.t[0] <= start - self.step and self.t[-1] + self.step >= end

    def close_at(self, ts: int) -> float | None:
        # Close of the last bar that has fully finished by ts.
        i = int(np.searchsorted(self.t, ts - self.step, side="right")) - 1
        return float(self.c[i]) if i >= 0 else None

    def range_between(self, start: int, end: int) -> float | None:
        a = int(np.searchsorted(self.t, start, side="left"))
        b = int(np.searchsorted(self.t, end, side="left"))
        if b <= a:
            return None
        return float(self.h[a:b].max() - self.l[a:b].min())


def compute_event_reactions() -> int:
    with db.session() as conn:
        m1 = _Series(queries.candles_df(conn, "M1"), "M1")
        m5 = _Series(queries.candles_df(conn, "M5"), "M5")
        events = pd.read_sql_query(
            "SELECT value_id, event_id, time_utc, actual, forecast, previous FROM calendar_events "
            "WHERE time_utc <= ? ORDER BY time_utc", conn, params=[int(time.time())])
    if events.empty or not len(m5.t):
        return 0

    events["surprise"] = np.where(events["forecast"].notna(), events["actual"] - events["forecast"],
                                  events["actual"] - events["previous"])
    # Normalize each event's surprise by its own historical dispersion.
    std = events.groupby("event_id")["surprise"].transform(lambda s: s.std(ddof=0) if s.notna().sum() >= 4 else np.nan)
    events["surprise_z"] = np.where(std > 0, events["surprise"] / std, np.nan)

    now = int(time.time())
    rows = []
    for ev in events.itertuples(index=False):
        t = int(ev.time_utc)
        series = m1 if m1.covers(t, t + 300) else m5 if m5.covers(t, t + 300) else None
        if series is None:
            continue
        base = series.close_at(t)
        if base is None:
            continue
        rets = {}
        for key, secs in HORIZONS.items():
            if t + secs > now or (series is m5 and secs < 300):
                rets[key] = None
                continue
            p = series.close_at(t + secs)
            rets[key] = None if p is None else round(p - base, 3)
        rng = series.range_between(t, t + 3600) if t + 3600 <= now else None
        rows.append((int(ev.value_id), int(ev.event_id), t,
                     None if pd.isna(ev.surprise) else float(ev.surprise),
                     None if pd.isna(ev.surprise_z) else round(float(ev.surprise_z), 3),
                     base, rets["ret_5m"], rets["ret_15m"], rets["ret_1h"], rets["ret_4h"],
                     None if rng is None else round(rng, 3)))

    with db.session() as conn:
        conn.executemany(
            "INSERT OR REPLACE INTO event_reactions(value_id, event_id, time_utc, surprise, surprise_z, base_price, "
            "ret_5m, ret_15m, ret_1h, ret_4h, range_1h) VALUES(?,?,?,?,?,?,?,?,?,?,?)", rows)
    log.info("Computed reactions for %d events", len(rows))
    return len(rows)


def _dist(values: pd.Series) -> dict | None:
    v = values.dropna()
    if v.empty:
        return None
    return {
        "n": int(v.size),
        "mean": round(float(v.mean()), 2),
        "median": round(float(v.median()), 2),
        "p10": round(float(v.quantile(0.1)), 2),
        "p90": round(float(v.quantile(0.9)), 2),
        "median_abs": round(float(v.abs().median()), 2),
        "pct_up": round(float((v > 0).mean() * 100), 1),
    }


def event_reaction_stats(conn, event: str | int, surprise_sign: str | None = None, recent: int = 8) -> dict:
    """event: calendar event_id or a (partial) event name. Returns USD-move distributions for gold."""
    if isinstance(event, int) or str(event).isdigit():
        event_id, others = int(event), []
    else:
        # Gold is priced in USD, so US releases take priority over same-named events elsewhere.
        matches = [dict(r) for r in conn.execute(
            "SELECT event_id, name, currency, COUNT(*) n FROM calendar_events WHERE name LIKE ? GROUP BY event_id "
            "ORDER BY currency='USD' DESC, MAX(importance) DESC, n DESC LIMIT 6", (f"%{event}%",))]
        if not matches:
            return {"error": f"No calendar event matching '{event}'"}
        event_id = matches[0]["event_id"]
        others = [{k: m[k] for k in ("event_id", "name", "currency")} for m in matches[1:]]
    row = conn.execute(
        "SELECT event_id, name, currency, country, importance, unit FROM calendar_events WHERE event_id=? LIMIT 1",
        (event_id,)).fetchone()
    if row is None:
        return {"error": f"Unknown event_id {event_id}"}
    info = dict(row)
    df = pd.read_sql_query(
        "SELECT e.time_utc, e.actual, e.forecast, e.previous, r.surprise, r.surprise_z, r.ret_5m, r.ret_15m, r.ret_1h, "
        "r.ret_4h, r.range_1h FROM event_reactions r JOIN calendar_events e ON e.value_id=r.value_id "
        "WHERE r.event_id=? ORDER BY e.time_utc", conn, params=[event_id])

    def block(sub: pd.DataFrame) -> dict:
        return {k: _dist(sub[k]) for k in (*HORIZONS, "range_1h")}

    out = {"event": info, "other_matches": others, "units": "USD per ounce move in gold from the pre-release price",
           "samples": int(len(df)), "all": block(df)}
    if df.empty:
        return out
    out["beat_forecast"] = block(df[df["surprise"] > 0])
    out["missed_forecast"] = block(df[df["surprise"] < 0])
    out["in_line"] = block(df[df["surprise"] == 0])
    if surprise_sign in ("positive", "negative"):
        out["selected"] = out["beat_forecast" if surprise_sign == "positive" else "missed_forecast"]
    out["recent"] = df.tail(recent).iloc[::-1].replace({np.nan: None}).to_dict("records")
    return out


def atr(df: pd.DataFrame, period: int = 14) -> float | None:
    if len(df) < period + 1:
        return None
    prev = df["close"].shift(1)
    tr = pd.concat([df["high"] - df["low"], (df["high"] - prev).abs(), (df["low"] - prev).abs()], axis=1).max(axis=1)
    return round(float(tr.ewm(alpha=1 / period, adjust=False).mean().iloc[-1]), 3)


def volatility_profile(conn, days: int = 90) -> dict:
    df = queries.candles_df(conn, "H1", start=int(time.time()) - days * 86400)
    if df.empty:
        return {"error": "No H1 data"}
    df["range"] = df["high"] - df["low"]
    ts = pd.to_datetime(df["time"], unit="s", utc=True)
    by_hour = df.groupby(ts.dt.hour)["range"].agg(["mean", "median"]).round(2)
    by_dow = df.groupby(ts.dt.day_name())["range"].agg(["mean", "median"]).round(2)
    return {
        "window_days": days,
        "units": "USD high-low range of H1 bars",
        "by_hour_utc": {int(h): r.to_dict() for h, r in by_hour.iterrows()},
        "by_weekday": by_dow.to_dict("index"),
        "overall_median_h1_range": round(float(df["range"].median()), 2),
    }


def _ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def market_snapshot(conn) -> dict:
    m1 = queries.candles_df(conn, "M1", limit=1500)
    h1 = queries.candles_df(conn, "H1", limit=300)
    h4 = queries.candles_df(conn, "H4", limit=200)
    m15 = queries.candles_df(conn, "M15", limit=300)
    d1 = queries.candles_df(conn, "D1", limit=60)
    if m1.empty or h1.empty:
        return {"error": "No candle data yet"}
    last = float(m1["close"].iloc[-1])
    now = int(m1["time"].iloc[-1])

    def change(secs: int) -> float | None:
        past = m1[m1["time"] <= now - secs]
        return round(last - float(past["close"].iloc[-1]), 2) if not past.empty else None

    def trend(df: pd.DataFrame) -> dict:
        if len(df) < 60:
            return {}
        e20, e50 = _ema(df["close"], 20), _ema(df["close"], 50)
        slope = float(e20.iloc[-1] - e20.iloc[-6])
        state = "up" if e20.iloc[-1] > e50.iloc[-1] and slope > 0 else "down" if e20.iloc[-1] < e50.iloc[-1] and slope < 0 else "mixed"
        return {"ema20": round(float(e20.iloc[-1]), 2), "ema50": round(float(e50.iloc[-1]), 2),
                "ema20_slope_5bars": round(slope, 2), "state": state}

    last24 = h1[h1["time"] >= now - 86400]
    week = h1[h1["time"] >= now - 7 * 86400]
    return {
        "price": last,
        "last_bar_utc": now,
        "change": {"15m": change(900), "1h": change(3600), "4h": change(14400), "24h": change(86400)},
        "atr14": {"M15": atr(m15), "H1": atr(h1), "H4": atr(h4), "D1": atr(d1)},
        "range_24h": {"high": float(last24["high"].max()), "low": float(last24["low"].min())} if not last24.empty else None,
        "range_7d": {"high": float(week["high"].max()), "low": float(week["low"].min())} if not week.empty else None,
        "trend": {"H1": trend(h1), "H4": trend(h4), "D1": trend(d1)},
        "freshness": queries.data_freshness(conn),
    }


def headline_tone(conn, hours: float = 24) -> dict:
    rows = queries.headlines(conn, int(time.time() - hours * 3600), int(time.time()), limit=500)
    tones = [r["tone"] for r in rows if r["tone"] is not None]
    return {"hours": hours, "count": len(rows), "avg_gold_tone": round(float(np.mean(tones)), 3) if tones else None,
            "note": "Keyword-based tone in [-1, 1]; positive = bullish wording for gold. Crude, use as a weak signal."}


def estimate_swing_range(conn, horizon_hours: float = 4) -> dict:
    """Baseline: empirical distribution of gold moves over windows of this length, widened for scheduled events."""
    horizon_hours = max(0.25, min(float(horizon_hours), 72))
    tf = "M5" if horizon_hours <= 6 else "H1"
    step = TF_SECONDS[tf]
    df = queries.candles_df(conn, tf, start=int(time.time()) - 60 * 86400)
    snap = market_snapshot(conn)
    if df.empty or "error" in snap:
        return {"error": "Not enough candle data"}
    n = max(1, int(round(horizon_hours * 3600 / step)))
    close = df["close"]
    fwd_change = (close.shift(-n) - close).dropna()
    fwd_high = df["high"][::-1].rolling(n, min_periods=n).max()[::-1].shift(-1)
    fwd_low = df["low"][::-1].rolling(n, min_periods=n).min()[::-1].shift(-1)
    fwd_range = fwd_high - fwd_low

    now = int(time.time())
    # XAUUSD247m trades through the weekend at a fraction of weekday volatility; compare like with like.
    weekend = pd.to_datetime(df["time"], unit="s", utc=True).dt.dayofweek >= 5
    same_regime = weekend == (time.gmtime(now).tm_wday >= 5)
    fwd_change = fwd_change[same_regime.reindex(fwd_change.index)]
    fwd_range = fwd_range[same_regime].dropna()
    events = queries.calendar_events(conn, now, now + int(horizon_hours * 3600), min_importance=2, with_reactions=False)
    events = [e for e in events if e["actual"] is None]
    base_sigma = float(fwd_change.std())
    # Releases sharing a timestamp move gold together, so each release time contributes its largest sigma once.
    sigma_by_time: dict[int, float] = {}
    event_notes = []
    for e in events:
        st = event_reaction_stats(conn, int(e["event_id"]))
        d = (st.get("all") or {}).get("ret_1h")
        if d and d["n"] >= 3:
            # median |move| of a normal ~ 0.674 sigma
            ev_sigma = d["median_abs"] / 0.674
            event_notes.append({"name": e["name"], "currency": e["currency"], "time_utc": e["time_utc"],
                                "importance": e["importance_label"], "hist_median_abs_1h_move": d["median_abs"],
                                "hist_pct_up_1h": d["pct_up"], "samples": d["n"]})
        else:
            ev_sigma = base_sigma * 0.5 if e["importance"] >= 3 else 0.0
            event_notes.append({"name": e["name"], "currency": e["currency"], "time_utc": e["time_utc"],
                                "importance": e["importance_label"], "hist_median_abs_1h_move": None,
                                "note": "insufficient reaction history"})
        t = int(e["time_utc"])
        sigma_by_time[t] = max(sigma_by_time.get(t, 0.0), ev_sigma)
    extra_var = sum(s ** 2 for s in sigma_by_time.values())
    scale = math.sqrt(1 + extra_var / base_sigma ** 2) if base_sigma > 0 else 1.0

    price = snap["price"]
    q = lambda s, p: round(float(s.quantile(p)) * scale, 2)
    h1t, h4t = snap["trend"].get("H1", {}), snap["trend"].get("H4", {})
    tone = headline_tone(conn, 24)
    bias_score = (
        0.4 * {"up": 1, "down": -1}.get(h1t.get("state"), 0)
        + 0.4 * {"up": 1, "down": -1}.get(h4t.get("state"), 0)
        + 0.2 * (tone["avg_gold_tone"] or 0)
    )
    return {
        "price": price,
        "horizon_hours": horizon_hours,
        "method": (f"Empirical {tf} forward moves over the last 60 days for {n} bars, scaled by x{scale:.2f} for "
                   f"{len(events)} scheduled moderate/high-impact events at {len(sigma_by_time)} release times."),
        "expected_change_band": {"p10": q(fwd_change, 0.1), "p25": q(fwd_change, 0.25), "median": q(fwd_change, 0.5),
                                 "p75": q(fwd_change, 0.75), "p90": q(fwd_change, 0.9)},
        "price_band_80pct": [round(price + q(fwd_change, 0.1), 2), round(price + q(fwd_change, 0.9), 2)],
        "expected_high_low_range": {"median": q(fwd_range, 0.5), "p80": q(fwd_range, 0.8)},
        "event_volatility_multiplier": round(scale, 3),
        "events_in_window": event_notes,
        "directional_bias": {
            "score": round(bias_score, 2),
            "label": "bullish" if bias_score > 0.25 else "bearish" if bias_score < -0.25 else "neutral",
            "components": {"H1_trend": h1t.get("state"), "H4_trend": h4t.get("state"),
                           "headline_tone_24h": tone["avg_gold_tone"]},
            "note": "Heuristic only; the range estimate is the more reliable output.",
        },
    }

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api, fmtTime, money, TF_SECONDS,
  type AccountBook, type CalendarEvent, type Candle, type ChartSpan, type ClosedTrade, type Headline, type McpLink, type Outlook, type Snapshot, type Tick, type Timeframe,
} from "./api";
import PriceChart from "./components/PriceChart";
import NewsPanel from "./components/NewsPanel";
import UpcomingPanel from "./components/UpcomingPanel";
import EventDetail from "./components/EventDetail";
import OutlookPanel from "./components/OutlookPanel";
import DigestPanel from "./components/DigestPanel";
import OrdersPanel from "./components/OrdersPanel";
import HistoryPanel from "./components/HistoryPanel";
import MarketFlow from "./components/MarketFlow";
import AccountBar, { useAccount } from "./components/AccountBar";
import SpreadPop from "./components/SpreadPop";

const TIMEFRAMES: { tf: Timeframe; label: string }[] = [
  { tf: "M1", label: "1m" }, { tf: "M5", label: "5m" }, { tf: "M15", label: "15m" }, { tf: "M30", label: "30m" },
  { tf: "H1", label: "1h" }, { tf: "H4", label: "4h" }, { tf: "D1", label: "1D" },
];
const TF_WORDS: Record<Timeframe, string> = {
  M1: "1 minute", M5: "5 minutes", M15: "15 minutes", M30: "30 minutes", H1: "1 hour", H4: "4 hours", D1: "1 day",
};

function localDateKey(d: Date) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function periodBounds(now = Date.now()) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const week = new Date(day);
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  return {
    dayStart: Math.floor(day.getTime() / 1000),
    weekStart: Math.floor(week.getTime() / 1000),
    todayKey: localDateKey(day),
    weekKey: `week:${Math.floor(week.getTime() / 1000)}`,
  };
}

function openAt(bars: Candle[], boundary: number) {
  return bars.find((b) => b.time >= boundary)?.open ?? null;
}

function McpButton({ link }: { link: McpLink | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const connected = link?.connected === true;
  return (
    <div className="ind" ref={ref}>
      <button
        type="button"
        className={connected ? "on" : ""}
        onClick={() => setOpen((v) => !v)}
        title={connected ? "The AI data connection is live" : "The AI data connection is not running"}
      >
        <span className={`live ${connected ? "on" : ""}`} />
        MCP
      </button>
      {open && (
        <div className="ind-menu">
          <p><b>{connected ? "Connected" : "Not connected"}</b></p>
          <p className="muted">
            {connected
              ? "Cursor has the gold data server open, so an AI chat can read prices and news from here."
              : "Cursor has not started the gold data server. Enable gold-mcp in Cursor’s MCP settings, then start a chat that can use it."}
          </p>
          {link?.last_seen_utc != null && <p className="muted">Last seen {fmtTime(link.last_seen_utc, false)}</p>}
        </div>
      )}
    </div>
  );
}

type Tab = "orders" | "history" | "outlook" | "summary" | "upcoming" | "news";
const TABS: { id: Tab; label: string }[] = [
  { id: "orders", label: "Orders" },
  { id: "history", label: "History" },
  { id: "outlook", label: "Outlook" },
  { id: "summary", label: "Daily summary" },
  { id: "upcoming", label: "Coming up" },
  { id: "news", label: "All news" },
];

function dayCovers(candles: Candle[], start: number, end: number, step: number) {
  if (!candles.length) return false;
  const needUntil = Math.min(end, Math.floor(Date.now() / 1000)) - step;
  return candles[0].time <= start + step && candles[candles.length - 1].time >= needUntil;
}

function dayStats(candles: Candle[], span: ChartSpan, tf: Timeframe, tick: Tick | null) {
  const step = TF_SECONDS[tf];
  const until = Math.min(span.end, Date.now() / 1000);
  const liveBar = tick ? Math.floor(tick.time_utc / step) * step : -1;
  let open = 0;
  let close = 0;
  let high = -Infinity;
  let low = Infinity;
  let rangeSum = 0;
  let n = 0;
  for (const c of candles) {
    if (c.time >= until || c.time + step <= span.start) continue;
    const price = tick && c.time === liveBar ? tick.bid : null;
    const barHigh = price === null ? c.high : Math.max(c.high, price);
    const barLow = price === null ? c.low : Math.min(c.low, price);
    const barClose = price ?? c.close;
    if (n === 0) open = c.open;
    close = barClose;
    high = Math.max(high, barHigh);
    low = Math.min(low, barLow);
    rangeSum += barHigh - barLow;
    n += 1;
  }
  if (!n || open === 0) return null;
  const change = close - open;
  return { open, close, high, low, change, changePct: (change / open) * 100, avg: rangeSum / n, range: high - low, n };
}

const WARN_S = 15 * 60;

function NewsWarn({ events, onOpen }: { events: CalendarEvent[]; onOpen: (e: CalendarEvent) => void }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);
  const soon = events
    .filter((e) => e.importance >= 3 && e.time_utc - now > 0 && e.time_utc - now <= WARN_S)
    .sort((a, b) => a.time_utc - b.time_utc || b.importance - a.importance);
  if (!soon.length) return null;
  const when = soon[0].time_utc;
  const byName = new Map<string, CalendarEvent>();
  for (const e of soon) {
    if (e.time_utc !== when) break;
    const key = e.plain_name || e.name;
    if (!byName.has(key)) byName.set(key, e);
  }
  const names = [...byName.values()];
  const lead = names[0];
  const extra = names.length - 1;
  const moves = names.map((e) => e.history?.typical_move_1h).filter((n): n is number => n != null);
  const typical = moves.length ? Math.max(...moves) : null;
  const wait = when - now;
  const mins = Math.floor(wait / 60);
  const secs = Math.floor(wait % 60).toString().padStart(2, "0");
  const left = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  return (
    <button type="button" className="news-warn" onClick={() => onOpen(lead)}>
      <span className="when">in {left}</span>
      <span>
        <b>{lead.plain_name || lead.name}</b>
        {extra > 0 ? ` and ${extra} more` : ""}
        {typical != null ? ` · usually about $${Math.round(typical)} in the hour after` : ""}
      </span>
    </button>
  );
}

function DayReadout({ span, candles, tf, tick, onClose }: {
  span: ChartSpan; candles: Candle[]; tf: Timeframe; tick: Tick | null; onClose: () => void;
}) {
  const stats = dayStats(candles, span, tf, tick);
  const tfLabel = TIMEFRAMES.find((t) => t.tf === tf)?.label ?? tf;
  const up = stats ? stats.change >= 0 : span.up;
  return (
    <aside className={`day-card ${up ? "up" : "down"}`}>
      <header>
        <b>{span.label}</b>
        <button type="button" onClick={onClose} title="Clear the shading">×</button>
      </header>
      {!stats && <p className="muted">Loading candles…</p>}
      {stats && (
        <>
          <div className={`day-card-move ${up ? "up" : "down"}`}>
            {up ? "+" : "-"}{money(Math.abs(stats.change))}
            <small> ({up ? "+" : ""}{stats.changePct.toFixed(2)}%)</small>
          </div>
          <dl>
            <div><dt>Start price</dt><dd>{money(stats.open)}</dd></div>
            <div><dt>{span.today ? "Price now" : "End price"}</dt><dd>{money(stats.close)}</dd></div>
            <div><dt>Avg {tfLabel} candle move</dt><dd title="Average distance from each candle's low to its high">{money(stats.avg)}</dd></div>
            <div><dt>High to low</dt><dd>{money(stats.range)}</dd></div>
          </dl>
          <p className="muted">High {money(stats.high)} · low {money(stats.low)} · {stats.n} candle{stats.n === 1 ? "" : "s"}</p>
        </>
      )}
    </aside>
  );
}

function useInterval(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ref.current();
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function useTicks(): { tick: Tick | null; live: boolean } {
  const [tick, setTick] = useState<Tick | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws/ticks`);
      ws.onopen = () => setLive(true);
      ws.onmessage = (m) => setTick(JSON.parse(m.data));
      ws.onclose = () => {
        setLive(false);
        if (!closed) retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);
  return { tick, live };
}

export default function App() {
  const [tf, setTf] = useState<Timeframe>("M15");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [headlines, setHeadlines] = useState<Headline[]>([]);
  const [upcoming, setUpcoming] = useState<CalendarEvent[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [outlook4h, setOutlook4h] = useState<Outlook | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [visibleRange, setVisibleRange] = useState<{ from: number; to: number } | null>(null);
  const [focus, setFocus] = useState<{ time: number; nonce: number } | null>(null);
  const [span, setSpan] = useState<ChartSpan | null>(null);
  const [tab, setTab] = useState<Tab>("outlook");
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [anchors, setAnchors] = useState<{ todayOpen: number; weekOpen: number } | null>(null);
  const [yday, setYday] = useState<{ high: number; low: number } | null>(null);
  const [mcp, setMcp] = useState<McpLink | null>(null);
  const [book, setBook] = useState<AccountBook | null>(null);
  const [orderId, setOrderId] = useState<number | null>(null);
  const [closedTrade, setClosedTrade] = useState<ClosedTrade | null>(null);
  const closedFetch = useRef("");
  const { tick, live } = useTicks();
  const loadingOlder = useRef(false);
  const exhausted = useRef(false);
  const spanFetch = useRef("");

  useEffect(() => {
    let cancelled = false;
    exhausted.current = false;
    setCandles([]);
    api.candles(tf, { limit: 3000 })
      .then((c) => { if (!cancelled) { setCandles(c); setError(null); } })
      .catch((e) => setError(String(e)));
    return () => { cancelled = true; };
  }, [tf]);

  const loadOlder = useCallback(() => {
    if (loadingOlder.current || exhausted.current || !candles.length) return;
    loadingOlder.current = true;
    api.candles(tf, { to: candles[0].time - 1, limit: 2000 })
      .then((older) => {
        if (!older.length) exhausted.current = true;
        else setCandles((cur) => [...older.filter((o) => o.time < cur[0].time), ...cur]);
      })
      .finally(() => { loadingOlder.current = false; });
  }, [candles, tf]);

  useEffect(() => {
    if (!span || !candles.length) return;
    const step = TF_SECONDS[tf];
    if (dayCovers(candles, span.start, span.end, step)) return;
    const id = `${tf}:${span.start}`;
    if (spanFetch.current === id) return;
    spanFetch.current = id;
    let cancel = false;
    const need = Math.ceil((span.end - span.start) / step) + 5;
    api.candles(tf, { from: span.start, to: span.end - 1, limit: Math.min(20000, need) }).then((extra) => {
      if (cancel || !extra.length) return;
      setCandles((cur) => {
        const byTime = new Map(cur.map((c) => [c.time, c]));
        for (const c of extra) byTime.set(c.time, c);
        return [...byTime.values()].sort((a, b) => a.time - b.time);
      });
    }).catch(() => {});
    return () => { cancel = true; };
  }, [span, tf, candles]);

  useInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    api.events(now - 800 * 86400, now + 14 * 86400, 1).then(setEvents).catch(() => {});
    api.headlines(0, now + 3600, 2000).then(setHeadlines).catch(() => {});
    setRefreshKey((k) => k + 1);
  }, 300_000);

  useInterval(() => {
    api.upcoming(168, 2).then(setUpcoming).catch(() => {});
    api.snapshot().then(setSnapshot).catch(() => {});
    api.outlook(4).then(setOutlook4h).catch(() => {});
  }, 60_000);

  const onBarClick = useCallback((barTime: number) => {
    const step = TF_SECONDS[tf];
    const hits = events
      .filter((e) => e.importance >= 2 && e.time_utc >= barTime && e.time_utc < barTime + step)
      .sort((a, b) => b.importance - a.importance);
    if (hits.length) setSelected(hits.map((e) => e.value_id));
  }, [events, tf]);

  const focusTime = useCallback((t: number) => setFocus({ time: t, nonce: Date.now() }), []);
  const onVisibleRangeChange = useCallback((from: number, to: number) => setVisibleRange({ from, to }), []);
  const selectEvent = useCallback((e: CalendarEvent) => {
    const bundle = events
      .filter((item) => item.importance >= 2 && item.time_utc === e.time_utc)
      .sort((a, b) => b.importance - a.importance);
    setSelected((bundle.length ? bundle : [e]).map((item) => item.value_id));
  }, [events]);
  const highlightBar = useMemo(() => {
    const event = events.find((item) => item.value_id === selected[0]);
    if (!event) return null;
    const step = TF_SECONDS[tf];
    return Math.floor(event.time_utc / step) * step;
  }, [events, selected, tf]);
  const selectEventId = useCallback((id: number) => {
    const event = events.find((item) => item.value_id === id);
    if (event) selectEvent(event);
    else setSelected([id]);
  }, [events, selectEvent]);

  useEffect(() => {
    if (!closedTrade) return;
    const step = TF_SECONDS[tf];
    const from = closedTrade.open_utc - step * 8;
    const to = closedTrade.close_utc + step * 8;
    if (dayCovers(candles, from, to, step)) return;
    const id = `${tf}:${closedTrade.position}:${closedTrade.open_utc}`;
    if (closedFetch.current === id) return;
    closedFetch.current = id;
    let cancel = false;
    const need = Math.ceil((to - from) / step) + 10;
    api.candles(tf, { from, to: to - 1, limit: Math.min(20000, Math.max(need, 50)) }).then((extra) => {
      if (cancel || !extra.length) return;
      setCandles((cur) => {
        const byTime = new Map(cur.map((c) => [c.time, c]));
        for (const c of extra) byTime.set(c.time, c);
        return [...byTime.values()].sort((a, b) => a.time - b.time);
      });
    }).catch(() => {});
    return () => { cancel = true; };
  }, [closedTrade, tf, candles]);

  useEffect(() => {
    let cancel = false;
    const load = () => {
      api.trades().then((b) => { if (!cancel) setBook(b); }).catch(() => {});
    };
    load();
    const id = setInterval(load, 3_000);
    return () => { cancel = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    let cancel = false;
    const load = () => {
      api.status().then((s) => { if (!cancel) setMcp(s.mcp); }).catch(() => { if (!cancel) setMcp(null); });
    };
    load();
    const id = setInterval(load, 15_000);
    return () => { cancel = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    let cancel = false;
    const load = () => {
      const { dayStart, weekStart } = periodBounds();
      api.candles("H1", { from: weekStart, limit: 400 }).then((bars) => {
        if (cancel) return;
        const todayOpen = openAt(bars, dayStart);
        const weekOpen = openAt(bars, weekStart);
        if (todayOpen == null || weekOpen == null) return;
        setAnchors({ todayOpen, weekOpen });
      }).catch(() => {});
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { cancel = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    let cancel = false;
    const load = () => {
      const { dayStart } = periodBounds();
      api.candles("H1", { from: dayStart - 86400, to: dayStart - 1, limit: 48 }).then((bars) => {
        if (cancel) return;
        const inDay = bars.filter((b) => b.time < dayStart);
        if (!inDay.length) return;
        setYday({
          high: Math.max(...inDay.map((b) => b.high)),
          low: Math.min(...inDay.map((b) => b.low)),
        });
      }).catch(() => {});
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { cancel = true; clearInterval(id); };
  }, []);

  const price = tick?.bid ?? snapshot?.price;
  const ch24 = snapshot?.change?.["24h"];
  const { dayStart, weekStart, todayKey, weekKey } = periodBounds();
  const acct = useAccount(dayStart);
  const todayChange = anchors && price != null ? price - anchors.todayOpen : null;
  const weekChange = anchors && price != null ? price - anchors.weekOpen : null;
  const shownSpan = span && (span.key === todayKey || span.key === weekKey)
    ? { ...span, up: ((span.key === todayKey ? todayChange : weekChange) ?? 0) >= 0 }
    : span;
  const pickSpan = (next: ChartSpan) => setSpan((cur) => (cur?.key === next.key ? null : next));
  const chartTrades = useMemo(
    () => (book?.connected ? [...book.positions, ...book.orders].filter((t) => t.symbol === book.symbol) : []),
    [book],
  );
  const orderCount = (book?.positions.length ?? 0) + (book?.orders.length ?? 0);  const orderFocus = chartTrades.find((t) => t.ticket === orderId) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="top-row">
        <div className="symbol" title="Gold price in US dollars per ounce, from your MetaTrader 5 broker">
          <span className={`live ${live ? "on" : ""}`} title={live ? "Live prices from MT5" : "Not connected to MT5"} />
          Gold (XAUUSD)
        </div>
        <div className="price num num-price">{money(price)}</div>
        {ch24 != null && (
          <div className={ch24 >= 0 ? "tone-up" : "tone-down"} title="Change compared with 24 hours ago">
            {ch24 >= 0 ? "up" : "down"} <span className="num num-chg">{money(Math.abs(ch24))}</span> in 24h
          </div>
        )}
        {todayChange != null && (
          <button
            type="button"
            className={`chg ${todayChange >= 0 ? "up" : "down"} ${span?.key === todayKey ? "on" : ""}`}
            title="Since local midnight. Click to shade today on the chart."
            onClick={() => pickSpan({
              key: todayKey, label: "Today", start: dayStart, end: dayStart + 86400, up: todayChange >= 0, today: true,
            })}
          >
            Today <span className="num num-chg">{todayChange >= 0 ? "+" : "-"}{money(Math.abs(todayChange))}</span>
          </button>
        )}
        {weekChange != null && (
          <button
            type="button"
            className={`chg ${weekChange >= 0 ? "up" : "down"} ${span?.key === weekKey ? "on" : ""}`}
            title="Since Monday. Click to shade this week on the chart."
            onClick={() => pickSpan({
              key: weekKey, label: "This week", start: weekStart, end: weekStart + 7 * 86400, up: weekChange >= 0, today: true,
            })}
          >
            Week <span className="num num-chg">{weekChange >= 0 ? "+" : "-"}{money(Math.abs(weekChange))}</span>
          </button>
        )}
        {tick && <SpreadPop tick={tick} />}
        <AccountBar acct={acct} book={book} onShowOrders={() => setTab("orders")} />
        <MarketFlow />
        {outlook4h && !outlook4h.error && (
          <button className="outlook-chip" onClick={() => setTab("outlook")} title="Click for an explanation">
            Next 4 hours: likely {money(outlook4h.likely_low)} - {money(outlook4h.likely_high)}
          </button>
        )}
        <div className="tfs" title="How much time each candle on the chart covers">
          <McpButton link={mcp} />
          <span className="muted">Each candle =</span>
          {TIMEFRAMES.map((t) => (
            <button key={t.tf} className={t.tf === tf ? "active" : ""} onClick={() => setTf(t.tf)} title={TF_WORDS[t.tf]}>{t.label}</button>
          ))}
        </div>
        </div>
        <div className="legend">
          <span><i className="c-up" /> price went up</span>
          <span><i className="c-down" /> price went down</span>
          <span><i className="m-big" /> big news</span>
          <span><i className="m-med" /> medium news</span>
          <span><i className="s-lon" /> London</span>
          <span><i className="s-ny" /> New York</span>
          <span><i className="s-both" /> both open</span>
          <span><i className="o-line" /> your order</span>
          <span><i className="ask-line" /> buy price (ask)</span>
          <span className="muted">Click a marked candle to see what happened</span>
        </div>
      </header>
      {error && <div className="error">Can't reach the backend ({error}). Is the API running on port 8000?</div>}
      <main>
        <div className="left">
          <div className="chart-wrap">
            <PriceChart
              tf={tf}
              candles={candles}
              events={events}
              tick={tick}
              focus={focus}
              span={shownSpan}
              highlight={highlightBar}
              yday={yday}
              trades={chartTrades}
              orderFocus={orderFocus}
              closedFocus={closedTrade}
              onBarClick={onBarClick}
              onVisibleRangeChange={onVisibleRangeChange}
              onNeedOlder={loadOlder}
            />
            <NewsWarn events={upcoming} onOpen={selectEvent} />
            {shownSpan && <DayReadout span={shownSpan} candles={candles} tf={tf} tick={tick} onClose={() => setSpan(null)} />}
          </div>
          <EventDetail valueIds={selected} onClose={() => setSelected([])} />
        </div>
        <aside className="right">
          <nav className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={t.id === tab ? "active" : ""} onClick={() => setTab(t.id)}>
                {t.id === "orders" && orderCount > 0 ? `Orders ${orderCount}` : t.label}
              </button>
            ))}
          </nav>
          <div className="tab-body">
            {tab === "orders" && (
              <OrdersPanel
                book={book}
                tick={tick}
                acct={acct}
                selected={orderId}
                onSelect={(ticket) => { setClosedTrade(null); setOrderId((cur) => (cur === ticket ? null : ticket)); }}
                onPlaced={() => { api.trades().then(setBook).catch(() => {}); }}
              />
            )}
            {tab === "history" && (
              <HistoryPanel
                dayStart={dayStart}
                selected={closedTrade?.position ?? null}
                onPick={(trade) => { setOrderId(null); setClosedTrade(trade); }}
              />
            )}
            {tab === "outlook" && <OutlookPanel onFocusTime={focusTime} refreshKey={refreshKey} />}
            {tab === "summary" && (
              <DigestPanel activeDay={span?.key ?? null} activeIds={selected} onFocusTime={focusTime} onSelectDay={setSpan} onSelectRelease={selectEventId} refreshKey={refreshKey} />
            )}
            {tab === "upcoming" && <UpcomingPanel events={upcoming} onSelect={selectEvent} />}
            {tab === "news" && (
              <NewsPanel events={events} headlines={headlines} visibleRange={visibleRange} onSelectEvent={selectEvent} onFocusTime={focusTime} />
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

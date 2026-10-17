export type Timeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1";

export const TF_SECONDS: Record<Timeframe, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400,
};

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tick_volume: number;
}

export interface CalendarEvent {
  value_id: number;
  event_id: number;
  time_utc: number;
  country: string;
  currency: string;
  name: string;
  importance: number;
  importance_label: string;
  unit: string;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  revised: number | null;
  surprise?: number | null;
  ret_5m?: number | null;
  ret_15m?: number | null;
  ret_1h?: number | null;
  ret_4h?: number | null;
  range_1h?: number | null;
  plain_name: string;
  what_it_is: string | null;
  why_it_matters: string | null;
  result_label: string | null;
  result_text: string | null;
  gold_reaction_text: string | null;
  actual_text: string | null;
  forecast_text: string | null;
  previous_text: string | null;
  history?: EventHistory;
}

export interface EventHistory {
  typical_move_1h: number | null;
  samples: number;
  summary: string;
  if_higher?: string;
  if_lower?: string;
}

export interface ChartSpan {
  key: string;
  label: string;
  start: number;
  end: number;
  up: boolean;
  today: boolean;
}

export interface DayDigest {
  date: string;
  weekday: string;
  start_utc: number;
  end_utc: number;
  is_today: boolean;
  summary: string;
  price?: { open: number; close: number; high: number; low: number; change: number; change_pct: number };
  key_releases: {
    time_utc: number;
    time_local: string;
    importance: number;
    plain_name: string;
    name: string;
    text: string;
    gold_reaction: number | null;
    gold_reaction_text: string | null;
    also_released: string[];
    value_id: number;
  }[];
  topics: { topic: string; count: number; examples: { title: string; url: string; time_utc: number }[] }[];
  headline_count: number;
  news_mood: string;
}

export interface Outlook {
  error?: string;
  horizon_hours: number;
  price: number;
  likely_low: number;
  likely_high: number;
  typical_swing: number;
  big_swing: number;
  lean: string;
  headline: string;
  explain_range: string;
  explain_swing: string;
  explain_lean: string;
  events_note: string;
  watch_out: { time_utc: number; time_local: string; plain_name: string; name: string; importance: string; text: string }[];
}

export interface Headline {
  url: string;
  time_utc: number;
  source: string;
  title: string;
  domain: string;
  tone: number | null;
}

export interface Tick {
  symbol: string;
  time_utc: number;
  bid: number;
  ask: number;
}

export interface Dist {
  n: number;
  mean: number;
  median: number;
  p10: number;
  p90: number;
  median_abs: number;
  pct_up: number;
}

export type DistBlock = Record<"ret_5m" | "ret_15m" | "ret_1h" | "ret_4h" | "range_1h", Dist | null>;

export interface EventStats {
  error?: string;
  event?: { event_id: number; name: string; currency: string; importance: number };
  samples?: number;
  all?: DistBlock;
  beat_forecast?: DistBlock;
  missed_forecast?: DistBlock;
}

export interface TrendRead {
  ema20?: number;
  ema50?: number;
  ema20_slope_5bars?: number;
  state?: string;
}

export interface AccountTrade {
  ticket: number;
  symbol: string;
  side: string;
  kind: "position" | "order";
  volume: number;
  price: number;
  sl: number;
  tp: number;
  profit: number | null;
  potential: number | null;
  risk?: number | null;
  swap: number;
  time_utc: number;
  comment: string;
  magic?: number;
  source?: "manual" | "phone" | "web" | "app" | "ea";
  source_name?: string;
}

export interface AccountBook {
  connected: boolean;
  symbol: string;
  positions: AccountTrade[];
  orders: AccountTrade[];
}

export interface ClosedTrade {
  position: number;
  symbol: string;
  side: string;
  volume: number;
  open_price: number;
  close_price: number;
  open_utc: number;
  close_utc: number;
  net: number;
  costs: number;
  reason: "target" | "stop" | "stop out" | "closed" | "closed here";
  closes: number;
  magic?: number;
  source?: "manual" | "phone" | "web" | "app" | "ea";
  source_name?: string;
}

export interface TradeHistory {
  connected: boolean;
  from: number;
  count: number;
  net: number;
  wins: number;
  losses: number;
  flat: number;
  best: number | null;
  worst: number | null;
  avg_win: number | null;
  avg_loss: number | null;
  truncated: boolean;
  trades: ClosedTrade[];
}

export interface McpLink {
  connected: boolean;
  last_seen_utc: number | null;
}

export interface Snapshot {
  error?: string;
  price: number;
  change: Record<string, number | null>;
  atr14: Record<string, number | null>;
  trend?: Record<string, TrendRead>;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = `${path}: ${r.status}`;
    try {
      const data = await r.json() as { detail?: unknown };
      if (typeof data.detail === "string") detail = data.detail;
    } catch { /* the body was not JSON */ }
    throw new Error(detail);
  }
  return r.json() as Promise<T>;
}

export interface MarketFlow {
  ticks: {
    window_s: number;
    ticks: number;
    up: number;
    down: number;
    buy_pct: number;
    per_min: number;
    typical_per_min: number;
    activity: number | null;
    moved: number;
  } | null;
  retail: {
    long_pct: number;
    short_pct: number;
    brokers: Record<string, number>;
    formed_utc: number;
    source: string;
  } | null;
}

export interface AccountSummary {
  connected: boolean;
  currency?: string;
  balance?: number;
  equity?: number;
  floating?: number;
  margin_free?: number;
  margin_level?: number | null;
  margin_used?: number;
  margin_call?: number;
  stop_out?: number;
  stop_mode_pct?: boolean;
  realized_today?: number;
  floating_at_start?: number;
  today?: number;
  today_pct?: number | null;
  start_equity?: number;
  moved_cash_today?: number;
}

export interface OrderPlan {
  side: "buy" | "sell";
  volume: number;
  profit: number;
  loss: number;
  price: number;
  tp: number;
  sl: number;
  ticket?: number;
}

export const api = {
  candles: (tf: Timeframe, opts: { from?: number; to?: number; limit?: number } = {}) => {
    const p = new URLSearchParams({ tf, limit: String(opts.limit ?? 3000) });
    if (opts.from) p.set("from", String(opts.from));
    if (opts.to) p.set("to", String(opts.to));
    return get<{ candles: Candle[] }>(`/api/candles?${p}`).then((r) => r.candles);
  },
  events: (from: number, to: number, minImportance = 1) =>
    get<CalendarEvent[]>(`/api/events?from=${from}&to=${to}&min_importance=${minImportance}`),
  headlines: (from: number, to: number, limit = 500) =>
    get<Headline[]>(`/api/headlines?from=${from}&to=${to}&limit=${limit}`),
  upcoming: (hours = 168, minImportance = 2) =>
    get<CalendarEvent[]>(`/api/upcoming?hours=${hours}&min_importance=${minImportance}`),
  eventStats: (eventId: number) => get<EventStats>(`/api/event-stats/${eventId}`),
  explainEvent: (valueId: number) => get<CalendarEvent>(`/api/explain-event/${valueId}`),
  outlook: (hours: number) => get<Outlook>(`/api/outlook?hours=${hours}&tz=${TZ_MINUTES}`),
  digest: (days = 7) => get<DayDigest[]>(`/api/digest?days=${days}&tz=${TZ_MINUTES}`),
  snapshot: () => get<Snapshot>("/api/snapshot"),
  status: () => get<{ mcp: McpLink }>("/api/status"),
  trades: () => get<AccountBook>("/api/trades"),
  history: (from: number) => get<TradeHistory>(`/api/history?from=${from}`),
  marketFlow: () => get<MarketFlow>("/api/market-flow"),
  account: (dayStart: number) => get<AccountSummary>(`/api/account?from=${dayStart}`),
  planOrder: (side: "buy" | "sell", volume: number, profit: number | null, loss: number | null) =>
    post<OrderPlan>("/api/orders/plan", { side, volume, profit, loss }),
  placeOrder: (side: "buy" | "sell", volume: number, profit: number | null, loss: number | null) =>
    post<OrderPlan>("/api/orders", { side, volume, profit, loss }),
  closeOrder: (ticket: number) =>
    post<{ ticket: number; kind: "position" | "order"; price: number }>(`/api/orders/${ticket}/close`, {}),
};

export const TZ_MINUTES = -new Date().getTimezoneOffset();

export function placedTitle(source?: string, magic?: number) {
  if (source === "ea") return magic ? `Expert Advisor, magic ${magic}` : "Expert Advisor";
  if (source === "app") return "Placed from this app";
  if (source === "phone") return "Placed from the MetaTrader phone app";
  if (source === "web") return "Placed from the MetaTrader web terminal";
  return "Placed by hand in MetaTrader";
}

export const money = (v: number | null | undefined) =>
  v === null || v === undefined ? "-" : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const IMPORTANCE_WORD: Record<number, string> = { 1: "Small news", 2: "Medium news", 3: "Big news" };

export function fmtTime(ts: number, withDate = true): string {
  const d = new Date(ts * 1000);
  return withDate
    ? d.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined ? "-" : v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export const IMPORTANCE_COLOR: Record<number, string> = { 0: "#6b7280", 1: "#9ca3af", 2: "#facc15", 3: "#a855f7" };

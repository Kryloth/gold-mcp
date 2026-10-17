import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type IChartApiBase,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type ISeriesPrimitive,
  LineStyle,
  type PrimitiveHoveredItem,
  type Logical,
  type SeriesAttachedParameter,
  type SeriesMarker,
  type SeriesType,
  type Time,
  TickMarkType,
  type UTCTimestamp,
} from "lightweight-charts";
import { IMPORTANCE_COLOR, money, TF_SECONDS, type AccountTrade, type CalendarEvent, type Candle, type ChartSpan, type ClosedTrade, type Tick, type Timeframe } from "../api";

interface Props {
  tf: Timeframe;
  candles: Candle[];
  events: CalendarEvent[];
  tick: Tick | null;
  focus: { time: number; nonce: number } | null;
  span: ChartSpan | null;
  highlight: number | null;
  yday: { high: number; low: number } | null;
  trades: AccountTrade[];
  orderFocus: AccountTrade | null;
  closedFocus: ClosedTrade | null;
  onBarClick: (barTime: number) => void;
  onVisibleRangeChange: (from: number, to: number) => void;
  onNeedOlder: () => void;
}

const shortName = (e: CalendarEvent) => {
  const name = (e.plain_name || e.name).replace(/\s*\(.*\)/, "");
  return name.length > 22 ? `${name.slice(0, 20)}..` : name;
};

// Dots share a ground floor GROUND_PX above the highest visible candle and stack FLOOR_PX apart.
// A name sits on a subfloor SUBFLOOR_PX above its dot, in the gap before the next dot row.
const GROUND_PX = 12;
const FLOOR_PX = 22;
const SUBFLOOR_PX = 11;
const FONT_PX = 10;
const MAX_STACK = 4;
const SCALE_TOP = 0.24;
const SCALE_BOTTOM = 0.1;
// Scheduled news gets empty bar slots this far past the last candle (capped so M1 stays light, but still a full day ahead).
const FUTURE_SPAN_S = 14 * 86400;
const FUTURE_MAX_BARS = 1440;

// Empty slots begin the bar after `after`. A news time keeps a dummy value so its dot has a point to sit on.
function futurePoints(after: number, step: number, marks: Set<number>, price: number) {
  const count = Math.min(FUTURE_MAX_BARS, Math.ceil(FUTURE_SPAN_S / step));
  const points: { time: UTCTimestamp; value?: number }[] = [];
  if (marks.has(after)) points.push({ time: after as UTCTimestamp, value: price });
  for (let k = 1; k <= count; k++) {
    const time = (after + k * step) as UTCTimestamp;
    points.push(marks.has(time) ? { time, value: price } : { time });
  }
  return points;
}
const FONT = `-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif`;

type Stack = { shown: CalendarEvent[]; total: number };
type Column = Stack & { idx: number };
type FutureColumn = Stack & { time: number };
// bottom === null marks a scheduled release: its stem runs to the bottom of the pane.
type DropLine = { time: UTCTimestamp; top: number; bottom: number | null };
type NewsLabel = { time: UTCTimestamp; price: number; text: string; color: string };

const DROP_COLOR = "rgba(156, 163, 175, 0.7)";
const FUTURE_DROP_COLOR = "rgba(245, 196, 81, 0.35)";
const FUTURE_FILL = "rgba(245, 196, 81, 0.035)";
const FUTURE_EDGE = "rgba(245, 196, 81, 0.4)";
const FUTURE_TEXT = "rgba(245, 196, 81, 0.75)";
const LABEL_COLOR = "#e9d5ff";
const FUTURE_LABEL_COLOR = "#f5d0fe";

const dueLabel = (t: number) =>
  new Date(t * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

// Draws one stem per news column (dotted to the candle's high, dashed for scheduled news),
// the news names, and a shaded "coming up" zone right of the last candle.
class NewsDropLines implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private lines: DropLine[] = [];
  private labels: NewsLabel[] = [];
  private futureFrom: UTCTimestamp | null = null;
  private readonly paneViewsList: readonly IPrimitivePaneView[];

  constructor() {
    const zoneRenderer: IPrimitivePaneRenderer = {
      draw: (target) => {
        const chart = this.chart;
        if (!chart || this.futureFrom === null) return;
        const x = chart.timeScale().timeToCoordinate(this.futureFrom);
        if (x === null) return;
        const half = chart.timeScale().options().barSpacing / 2;
        target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
          const left = Math.max(0, Math.round((x - half) * hr));
          if (left >= bitmapSize.width) return;
          ctx.fillStyle = FUTURE_FILL;
          ctx.fillRect(left, 0, bitmapSize.width - left, bitmapSize.height);
          ctx.strokeStyle = FUTURE_EDGE;
          ctx.lineWidth = hr;
          ctx.setLineDash([4 * hr, 4 * hr]);
          ctx.beginPath();
          ctx.moveTo(left + hr / 2, 0);
          ctx.lineTo(left + hr / 2, bitmapSize.height);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.font = `600 ${FONT_PX * vr}px ${FONT}`;
          ctx.fillStyle = FUTURE_TEXT;
          ctx.textAlign = "left";
          ctx.textBaseline = "top";
          ctx.fillText("COMING UP", left + 6 * hr, 6 * vr);
        });
      },
    };
    const renderer: IPrimitivePaneRenderer = {
      draw: (target, utils) => {
        const chart = this.chart;
        const series = this.series;
        if (!chart || !series || !this.lines.length) return;
        target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
          ctx.lineWidth = hr;
          ctx.lineCap = "round";
          for (const future of [false, true]) {
            ctx.strokeStyle = future ? FUTURE_DROP_COLOR : DROP_COLOR;
            utils?.setLineStyle(ctx, future ? LineStyle.Dashed : LineStyle.SparseDotted);
            ctx.beginPath();
            for (const line of this.lines) {
              if ((line.bottom === null) !== future) continue;
              const x = chart.timeScale().timeToCoordinate(line.time);
              const yTop = series.priceToCoordinate(line.top);
              const yBot = line.bottom === null ? bitmapSize.height / vr : series.priceToCoordinate(line.bottom);
              if (x === null || yTop === null || yBot === null) continue;
              const start = yTop * vr + 4 * vr;
              const end = yBot * vr;
              if (end - start < 3 * vr) continue;
              const xB = Math.round(x * hr);
              ctx.moveTo(xB, start);
              ctx.lineTo(xB, end);
            }
            ctx.stroke();
          }
        });
      },
    };
    const labelRenderer: IPrimitivePaneRenderer = {
      draw: (target) => {
        const chart = this.chart;
        const series = this.series;
        if (!chart || !series || !this.labels.length) return;
        target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
          ctx.font = `${FONT_PX * vr}px ${FONT}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const taken: { l: number; r: number; t: number; b: number }[] = [];
          const gap = 6 * hr;
          const half = (FONT_PX / 2 + 1) * vr;
          for (const label of this.labels) {
            const x = chart.timeScale().timeToCoordinate(label.time);
            const y = series.priceToCoordinate(label.price);
            if (x === null || y === null) continue;
            const cx = Math.round(x * hr);
            const cy = Math.round(y * vr);
            const w = ctx.measureText(label.text).width / 2;
            const box = { l: cx - w - gap, r: cx + w + gap, t: cy - half, b: cy + half };
            if (taken.some((o) => box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t)) continue;
            taken.push(box);
            ctx.fillStyle = label.color;
            ctx.fillText(label.text, cx, cy);
          }
        });
      },
    };
    this.paneViewsList = [
      { zOrder: () => "bottom", renderer: () => zoneRenderer },
      { zOrder: () => "normal", renderer: () => renderer },
      { zOrder: () => "top", renderer: () => labelRenderer },
    ];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setOverlay(lines: DropLine[], labels: NewsLabel[], futureFrom: UTCTimestamp | null): void {
    this.lines = lines;
    this.labels = labels;
    this.futureFrom = futureFrom;
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.paneViewsList;
  }
}

const SHADE_UP = "rgba(34, 197, 94, 0.13)";
const SHADE_DOWN = "rgba(239, 68, 68, 0.13)";
const EDGE_UP = "rgba(74, 222, 128, 0.9)";
const EDGE_DOWN = "rgba(248, 113, 113, 0.9)";
const MARK_COLOR = "#f5c451";
const AVG_COLOR = "#f5c451";
const AVG_HALO = "rgba(15, 17, 21, 0.9)";
const WAVE_UP = "#86efac";
const WAVE_DOWN = "#fca5a5";
const WAVE_UP_FILL = "rgba(34, 197, 94, 0.62)";
const WAVE_DOWN_FILL = "rgba(248, 113, 113, 0.62)";
const PRICE_UP = "#4ade80";
const PRICE_DOWN = "#f87171";

type Wave = { t0: number; p0: number; t1: number; p1: number; change: number };
type DayFit = {
  t0: number; p0: number; t1: number; p1: number;
  startPrice: number; endPrice: number;
  startText: string; endText: string;
  upper: number; lower: number;
  waves: Wave[];
};

type Pivot = { time: number; price: number };

// Swings big enough to see: a turn counts once price reverses by `dev`.
function swingPivots(bars: { time: number; high: number; low: number }[], dev: number): Pivot[] {
  if (!bars.length) return [];
  const pivots: Pivot[] = [];
  let mode: "up" | "down" | "none" = "none";
  let hi = bars[0].high;
  let hiT = bars[0].time;
  let lo = bars[0].low;
  let loT = bars[0].time;
  for (const b of bars) {
    if (mode === "none") {
      if (b.high >= hi) { hi = b.high; hiT = b.time; }
      if (b.low <= lo) { lo = b.low; loT = b.time; }
      if (hi - lo < dev) continue;
      if (hiT >= loT) {
        pivots.push({ time: loT, price: lo });
        mode = "up";
        hi = b.high;
        hiT = b.time;
      } else {
        pivots.push({ time: hiT, price: hi });
        mode = "down";
        lo = b.low;
        loT = b.time;
      }
      continue;
    }
    if (mode === "up") {
      if (b.high >= hi) { hi = b.high; hiT = b.time; }
      if (hi - b.low >= dev) {
        pivots.push({ time: hiT, price: hi });
        mode = "down";
        lo = b.low;
        loT = b.time;
      }
    } else {
      if (b.low <= lo) { lo = b.low; loT = b.time; }
      if (b.high - lo >= dev) {
        pivots.push({ time: loT, price: lo });
        mode = "up";
        hi = b.high;
        hiT = b.time;
      }
    }
  }
  if (mode === "up") pivots.push({ time: hiT, price: hi });
  else if (mode === "down") pivots.push({ time: loT, price: lo });
  return pivots;
}

function dayWaves(bars: { time: number; high: number; low: number }[], range: number): Wave[] {
  if (bars.length < 2 || range <= 0) return [];
  let dev = range * 0.2;
  let pivots = swingPivots(bars, dev);
  while (pivots.length > 7 && dev < range * 0.45) {
    dev *= 1.3;
    pivots = swingPivots(bars, dev);
  }
  if (pivots.length < 3) {
    const finer = swingPivots(bars, range * 0.12);
    if (finer.length >= 3 && finer.length <= 7) pivots = finer;
  }
  const waves: Wave[] = [];
  for (let i = 1; i < pivots.length; i++) {
    const a = pivots[i - 1];
    const b = pivots[i];
    if (b.time <= a.time) continue;
    waves.push({ t0: a.time, p0: a.price, t1: b.time, p1: b.price, change: b.price - a.price });
  }
  return waves.length >= 2 ? waves : [];
}

// Best-fit line through the middle of each candle in the shaded day, plus the day's open and last price.
function fitDay(candles: Candle[], span: ChartSpan, step: number, tick: Tick | null): DayFit | null {
  const until = Math.min(span.end, Date.now() / 1000);
  const liveBar = tick ? Math.floor(tick.time_utc / step) * step : -1;
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  let startPrice = 0;
  let endPrice = 0;
  let tFirst = 0;
  let tLast = 0;
  const bars: { time: number; high: number; low: number }[] = [];
  const take = (time: number, open: number, high: number, low: number, close: number) => {
    if (n === 0) {
      startPrice = open;
      tFirst = time;
    }
    endPrice = close;
    tLast = time;
    bars.push({ time, high, low });
    const y = (high + low) / 2;
    n += 1;
    sx += time;
    sy += y;
    sxy += time * y;
    sxx += time * time;
  };
  for (const c of candles) {
    if (c.time >= until || c.time + step <= span.start) continue;
    const live = tick && c.time === liveBar ? tick.bid : null;
    take(
      c.time,
      c.open,
      live === null ? c.high : Math.max(c.high, live),
      live === null ? c.low : Math.min(c.low, live),
      live ?? c.close,
    );
  }
  if (tick && liveBar >= span.start && liveBar < until && liveBar !== tLast && (n === 0 || liveBar > tLast)) {
    take(liveBar, tick.bid, tick.bid, tick.bid, tick.bid);
  }
  if (!n) return null;
  const texts = {
    startPrice, endPrice,
    startText: `Start ${money(startPrice)}`, endText: `${span.today ? "Now" : "End"} ${money(endPrice)}`,
  };
  const plain = { t0: tFirst, p0: startPrice, t1: tLast, p1: endPrice, upper: 0, lower: 0, waves: [] as Wave[], ...texts };
  if (n < 2) return plain;
  const den = n * sxx - sx * sx;
  if (den === 0) return plain;
  const slope = (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  const above: number[] = [];
  const below: number[] = [];
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of bars) {
    const mid = intercept + slope * b.time;
    above.push(b.high - mid);
    below.push(b.low - mid);
    hi = Math.max(hi, b.high);
    lo = Math.min(lo, b.low);
  }
  // A high percentile, so one news spike does not blow the whole channel open.
  const atPct = (vals: number[], p: number) => {
    const sorted = [...vals].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p))];
  };
  const upper = atPct(above, 0.9);
  const lower = atPct(below, 0.1);
  return {
    t0: tFirst, p0: intercept + slope * tFirst, t1: tLast, p1: intercept + slope * tLast,
    upper, lower, waves: dayWaves(bars, hi - lo), ...texts,
  };
}

// Logical index of a unix time on a scale whose real bars are `times` and whose bars after the
// last one continue one `step` apart (the future-news slots).
function logicalOf(times: number[], t: number, step: number): number {
  const i = lowerBound(times, t);
  if (i < times.length && times[i] === t) return i;
  if (i <= 0) return (t - times[0]) / step;
  if (i >= times.length) return times.length - 1 + (t - times[times.length - 1]) / step;
  return i - 1 + (t - times[i - 1]) / (times[i] - times[i - 1]);
}

type HourMove = { t0: number; p0: number; t1: number; p1: number; change: number; done: boolean };
type NewsMark = { time: UTCTimestamp; candle: Candle | null; dots: number[]; move: HourMove | null; times: number[]; step: number };

// From the news candle's open to the price one hour later. That is the move the release had time to cause.
function hourMove(data: Candle[], newsBar: number, step: number): HourMove | null {
  const times = data.map((c) => c.time);
  const i = lowerBound(times, newsBar);
  if (i >= times.length || times[i] !== newsBar) return null;
  const doneBy = newsBar + 3600;
  let j = lowerBound(times, doneBy - step + 1) - 1;
  if (j < i) j = times.length - 1;
  if (j <= i) return null;
  const end = data[j];
  const p0 = data[i].open;
  const p1 = end.close;
  const t1 = end.time + step;
  return { t0: data[i].time, p0, t1, p1, change: p1 - p0, done: t1 >= newsBar + 3600 - 1 };
}

function drawWaveArrow(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  fill: string,
  border: string,
  hr: number,
): void {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const ux = Math.cos(ang);
  const uy = Math.sin(ang);
  const px = -uy;
  const py = ux;
  const shaft = 4.5 * hr;
  const headLen = Math.min(16 * hr, Math.hypot(b.x - a.x, b.y - a.y) * 0.45);
  const headW = 9 * hr;
  const baseX = b.x - ux * headLen;
  const baseY = b.y - uy * headLen;
  ctx.beginPath();
  ctx.moveTo(a.x + px * shaft, a.y + py * shaft);
  ctx.lineTo(baseX + px * shaft, baseY + py * shaft);
  ctx.lineTo(baseX + px * headW, baseY + py * headW);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(baseX - px * headW, baseY - py * headW);
  ctx.lineTo(baseX - px * shaft, baseY - py * shaft);
  ctx.lineTo(a.x - px * shaft, a.y - py * shaft);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 1.25 * hr;
  ctx.stroke();
}

// Outlines the candle for the release being read, and rings the news dots on that candle.
class NewsHighlight implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private mark: NewsMark | null = null;
  private readonly paneViewsList: readonly IPrimitivePaneView[];

  constructor() {
    const renderer: IPrimitivePaneRenderer = {
      draw: (target) => {
        const chart = this.chart;
        const series = this.series;
        const mark = this.mark;
        if (!chart || !series || !mark) return;
        const x = chart.timeScale().timeToCoordinate(mark.time);
        if (x === null) return;
        const half = chart.timeScale().options().barSpacing * 0.42;
        target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          const cx = Math.round(x * hr);
          if (mark.candle) {
            const yOf = (p: number) => {
              const y = series.priceToCoordinate(p);
              return y === null ? null : y * vr;
            };
            const yHigh = yOf(mark.candle.high);
            const yLow = yOf(mark.candle.low);
            const yOpen = yOf(mark.candle.open);
            const yClose = yOf(mark.candle.close);
            if (yHigh !== null && yLow !== null && yOpen !== null && yClose !== null) {
              const bodyTop = Math.min(yOpen, yClose);
              const bodyBot = Math.max(yOpen, yClose);
              const w = Math.max(2 * hr, half * hr);
              ctx.strokeStyle = MARK_COLOR;
              ctx.lineWidth = 1.5 * hr;
              ctx.beginPath();
              ctx.moveTo(cx, yHigh);
              ctx.lineTo(cx, yLow);
              ctx.stroke();
              ctx.fillStyle = "rgba(245, 196, 81, 0.28)";
              ctx.fillRect(cx - w, bodyTop, w * 2, Math.max(hr, bodyBot - bodyTop));
              ctx.strokeRect(cx - w, bodyTop, w * 2, Math.max(hr, bodyBot - bodyTop));
            }
          }
          ctx.strokeStyle = MARK_COLOR;
          ctx.lineWidth = 1.5 * hr;
          for (const price of mark.dots) {
            const y = series.priceToCoordinate(price);
            if (y === null) continue;
            ctx.beginPath();
            ctx.arc(cx, y * vr, 7 * vr, 0, Math.PI * 2);
            ctx.stroke();
          }
          const move = mark.move;
          if (!move || mark.times.length < 2) return;
          const xOf = (t: number) => chart.timeScale().logicalToCoordinate(logicalOf(mark.times, t, mark.step) as Logical);
          const yOf = (p: number) => series.priceToCoordinate(p);
          const x1 = xOf(move.t0);
          const x2 = xOf(move.t1);
          const y1 = yOf(move.p0);
          const y2 = yOf(move.p1);
          if (x1 === null || x2 === null || y1 === null || y2 === null) return;
          const up = move.change >= 0;
          drawWaveArrow(ctx, { x: x1 * hr, y: y1 * vr }, { x: x2 * hr, y: y2 * vr }, up ? WAVE_UP_FILL : WAVE_DOWN_FILL, up ? WAVE_UP : WAVE_DOWN, hr);
          const text = `${up ? "+" : "-"}${money(Math.abs(move.change))} · ${move.done ? "1h" : "so far"}`;
          ctx.font = `600 ${11 * vr}px ${FONT}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.lineWidth = 4;
          ctx.strokeStyle = AVG_HALO;
          ctx.strokeText(text, ((x1 + x2) / 2) * hr, ((y1 + y2) / 2) * vr - 14 * vr);
          ctx.fillStyle = up ? WAVE_UP : WAVE_DOWN;
          ctx.fillText(text, ((x1 + x2) / 2) * hr, ((y1 + y2) / 2) * vr - 14 * vr);
        });
      },
    };
    this.paneViewsList = [{ zOrder: () => "top", renderer: () => renderer }];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setMark(mark: NewsMark | null): void {
    this.mark = mark;
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.paneViewsList;
  }
}

// Tints one day on the chart: a wash behind the candles and brackets on top of them.
class DayShade implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private from = 0;
  private to = 0;
  private up = true;
  private step = 60;
  private times: number[] = [];
  private shown = false;
  private fit: DayFit | null = null;
  private readonly paneViewsList: readonly IPrimitivePaneView[];

  constructor() {
    const draw = (edges: boolean): IPrimitivePaneRenderer["draw"] => (target) => {
      const chart = this.chart;
      if (!chart || !this.shown || this.times.length < 1) return;
      const x1 = chart.timeScale().logicalToCoordinate(logicalOf(this.times, this.from, this.step) as Logical);
      const x2 = chart.timeScale().logicalToCoordinate(logicalOf(this.times, this.to, this.step) as Logical);
      if (x1 === null || x2 === null) return;
      target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
        const left = Math.round(Math.min(x1, x2) * hr);
        const right = Math.round(Math.max(x1, x2) * hr);
        if (right < 0 || left > bitmapSize.width) return;
        if (!edges) {
          ctx.fillStyle = this.up ? SHADE_UP : SHADE_DOWN;
          ctx.fillRect(Math.max(0, left), 0, Math.min(bitmapSize.width, right) - Math.max(0, left), bitmapSize.height);
          return;
        }
        ctx.strokeStyle = this.up ? EDGE_UP : EDGE_DOWN;
        ctx.lineWidth = hr;
        ctx.beginPath();
        if (left >= 0 && left <= bitmapSize.width) {
          ctx.moveTo(left + hr / 2, 0);
          ctx.lineTo(left + hr / 2, bitmapSize.height);
        }
        if (right >= 0 && right <= bitmapSize.width) {
          ctx.moveTo(right + hr / 2, 0);
          ctx.lineTo(right + hr / 2, bitmapSize.height);
        }
        ctx.stroke();
        this.drawAverage(ctx, hr, vr, bitmapSize.width, bitmapSize.height);
      });
    };
    this.paneViewsList = [
      { zOrder: () => "bottom", renderer: () => ({ draw: draw(false) }) },
      { zOrder: () => "top", renderer: () => ({ draw: draw(true) }) },
    ];
  }

  // The day's average arrow, a channel around it, and one arrow per swing.
  private drawAverage(ctx: CanvasRenderingContext2D, hr: number, vr: number, width: number, height: number): void {
    const chart = this.chart;
    const series = this.series;
    const fit = this.fit;
    if (!chart || !series || !fit) return;
    ctx.setLineDash([]);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const at = (t: number, price: number) => {
      const x = chart.timeScale().logicalToCoordinate(logicalOf(this.times, t, this.step) as Logical);
      const y = series.priceToCoordinate(price);
      if (x === null || y === null) return null;
      return { x: x * hr, y: y * vr };
    };
    const x1 = at(fit.t0, fit.p0);
    const x2 = at(fit.t1, fit.p1);
    if (!x1 || !x2 || Math.hypot(x2.x - x1.x, x2.y - x1.y) < 8) return;

    const stroke = (a: { x: number; y: number }, b: { x: number; y: number }, color: string, widthPx: number) => {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = AVG_HALO;
      ctx.lineWidth = widthPx + 2 * hr;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = widthPx;
      ctx.stroke();
    };
    const hi0 = at(fit.t0, fit.p0 + fit.upper);
    const hi1 = at(fit.t1, fit.p1 + fit.upper);
    const lo0 = at(fit.t0, fit.p0 + fit.lower);
    const lo1 = at(fit.t1, fit.p1 + fit.lower);
    const bound = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = "rgba(245, 196, 81, 0.8)";
      ctx.lineWidth = 1.25 * hr;
      ctx.stroke();
    };
    if (hi0 && hi1) bound(hi0, hi1);
    if (lo0 && lo1) bound(lo0, lo1);

    const wavePts = fit.waves.flatMap((w) => {
      const a = at(w.t0, w.p0);
      const b = at(w.t1, w.p1);
      if (!a || !b || Math.hypot(b.x - a.x, b.y - a.y) < 10) return [];
      return [{ w, a, b }];
    });
    for (const { w, a, b } of wavePts) {
      this.arrow(ctx, a, b, w.change >= 0 ? WAVE_UP_FILL : WAVE_DOWN_FILL, w.change >= 0 ? WAVE_UP : WAVE_DOWN, hr);
    }

    stroke(x1, x2, AVG_COLOR, 1.5 * hr);
    this.arrowHead(ctx, x1, x2, AVG_COLOR, 8 * hr);

    const ang = Math.atan2(x2.y - x1.y, x2.x - x1.x);
    const len = Math.hypot(x2.x - x1.x, x2.y - x1.y) || 1;
    let px = -(x2.y - x1.y) / len;
    let py = (x2.x - x1.x) / len;
    if (py > 0) { px = -px; py = -py; }
    const taken: { l: number; r: number; t: number; b: number }[] = [];
    const label = (text: string, x: number, y: number, align: CanvasTextAlign, color: string, size: number) => {
      ctx.font = `600 ${size * vr}px ${FONT}`;
      const w = ctx.measureText(text).width;
      const h = (size + 2) * vr;
      const cx = Math.min(width - 8 * hr, Math.max(8 * hr, x));
      const cy = Math.min(height - 12 * vr, Math.max(18 * vr, y));
      const left = align === "right" ? cx - w : align === "center" ? cx - w / 2 : cx;
      const box = { l: left - 3 * hr, r: left + w + 3 * hr, t: cy - h / 2, b: cy + h / 2 };
      if (taken.some((o) => box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t)) return;
      taken.push(box);
      this.paintText(ctx, text, cx, cy, align, color);
    };
    const rose = fit.endPrice >= fit.startPrice;
    label(fit.startText, x1.x - Math.cos(ang) * 10 * hr + px * 14 * hr, x1.y - Math.sin(ang) * 10 * hr + py * 14 * hr, "right", rose ? PRICE_DOWN : PRICE_UP, 11);
    label(fit.endText, x2.x + Math.cos(ang) * 16 * hr + px * 14 * hr, x2.y + Math.sin(ang) * 16 * hr + py * 14 * hr, "left", rose ? PRICE_UP : PRICE_DOWN, 11);
    label("AVG", (x1.x + x2.x) / 2 + px * 14 * hr, (x1.y + x2.y) / 2 + py * 14 * hr, "center", AVG_COLOR, 11);
    const wavesBySize = [...wavePts].sort((p, q) => Math.abs(q.w.change) - Math.abs(p.w.change));
    for (const { w, a, b } of wavesBySize) {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const wl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      let ox = -(b.y - a.y) / wl;
      let oy = (b.x - a.x) / wl;
      if (oy > 0) { ox = -ox; oy = -oy; }
      const text = `${w.change >= 0 ? "+" : "-"}${money(Math.abs(w.change))}`;
      label(text, mx + ox * 12 * hr, my + oy * 12 * hr, "center", w.change >= 0 ? WAVE_UP : WAVE_DOWN, 10);
    }
  }

  private arrow(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, fill: string, border: string, hr: number): void {
    drawWaveArrow(ctx, a, b, fill, border, hr);
  }

  private arrowHead(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }, color: string, head: number): void {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - head * Math.cos(ang - 0.45), b.y - head * Math.sin(ang - 0.45));
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - head * Math.cos(ang + 0.45), b.y - head * Math.sin(ang + 0.45));
    ctx.stroke();
  }

  private paintText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, align: CanvasTextAlign, color: string): void {
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.lineWidth = 4;
    ctx.strokeStyle = AVG_HALO;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setSpan(span: ChartSpan | null, times: number[], step: number, fit: DayFit | null): void {
    this.shown = span !== null;
    this.times = times;
    this.step = step;
    this.fit = span ? fit : null;
    if (span) {
      this.from = span.start;
      this.to = span.end;
      this.up = span.up;
    }
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.paneViewsList;
  }
}

function lowerBound(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Same plain name released together (e.g. CPI m/m and CPI y/y) is one item in the stack.
function stackOf(evs: CalendarEvent[]): Stack {
  const byName = new Map<string, CalendarEvent>();
  for (const e of [...evs].sort((a, b) => b.importance - a.importance)) {
    const key = e.plain_name || e.name;
    if (!byName.has(key)) byName.set(key, e);
  }
  const unique = [...byName.values()];
  return { shown: unique.slice(0, MAX_STACK), total: unique.length };
}

const pad = (n: number) => n.toString().padStart(2, "0");

// lightweight-charts renders UTC; show local time to match the news panels.
function tickMark(time: Time, type: TickMarkType): string {
  const d = new Date((time as number) * 1000);
  switch (type) {
    case TickMarkType.Year:
      return String(d.getFullYear());
    case TickMarkType.Month:
      return d.toLocaleString(undefined, { month: "short" });
    case TickMarkType.DayOfMonth:
      return String(d.getDate());
    default:
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}

const SESSIONS = [
  { tz: "Europe/London", name: "London", startH: 8, endH: 17, rgb: "200, 16, 46", row: 0 },
  { tz: "America/New_York", name: "New York", startH: 8, endH: 17, rgb: "59, 130, 246", row: 1 },
];
const SESSION_FILL = 0.12;
const SESSION_STRIPE = 0.2;

function zoneParts(timeZone: string, utcMs: number) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  return parts;
}

function zoneOffsetMs(timeZone: string, utcMs: number) {
  const p = zoneParts(timeZone, utcMs);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - utcMs;
}

function zonedUtc(timeZone: string, y: number, m: number, d: number, hour: number) {
  const guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  const utc = guess - zoneOffsetMs(timeZone, guess);
  return Math.floor((utc - (zoneOffsetMs(timeZone, utc) - zoneOffsetMs(timeZone, guess))) / 1000);
}

type SessionBand = { start: number; end: number; name: string; rgb: string; row: number };

let sessionCacheKey = "";
let sessionCache: SessionBand[] = [];

function sessionBands(from: number, to: number): SessionBand[] {
  const key = `${Math.floor(from / 3600)}:${Math.floor(to / 3600)}`;
  if (key === sessionCacheKey) return sessionCache;
  const seen = new Set<string>();
  const bands: SessionBand[] = [];
  const day0 = Math.floor(from / 86400) * 86400 - 86400;
  const day1 = Math.floor(to / 86400) * 86400 + 86400;
  for (let day = day0; day <= day1; day += 86400) {
    for (const spec of SESSIONS) {
      const p = zoneParts(spec.tz, (day + 12 * 3600) * 1000);
      const id = `${spec.name}:${p.year}-${p.month}-${p.day}`;
      if (seen.has(id) || p.weekday === "Sat" || p.weekday === "Sun") continue;
      seen.add(id);
      const start = zonedUtc(spec.tz, +p.year, +p.month, +p.day, spec.startH);
      const end = zonedUtc(spec.tz, +p.year, +p.month, +p.day, spec.endH);
      if (end <= from || start >= to) continue;
      bands.push({ start, end, name: spec.name, rgb: spec.rgb, row: spec.row });
    }
  }
  sessionCacheKey = key;
  sessionCache = bands;
  return bands;
}

// Weekday cash-market hours, behind the candles. London 08:00–17:00, New York 08:00–17:00.
class SessionShade implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private times: number[] = [];
  private step = 60;
  private readonly paneViewsList: readonly IPrimitivePaneView[];

  private layout(): { band: SessionBand; left: number; right: number }[] {
    const chart = this.chart;
    const times = this.times;
    if (!chart || times.length < 2) return [];
    const range = chart.timeScale().getVisibleRange();
    if (!range) return [];
    const out: { band: SessionBand; left: number; right: number }[] = [];
    for (const band of sessionBands(range.from as number, range.to as number)) {
      const x1 = chart.timeScale().logicalToCoordinate(logicalOf(times, band.start, this.step) as Logical);
      const x2 = chart.timeScale().logicalToCoordinate(logicalOf(times, band.end, this.step) as Logical);
      if (x1 === null || x2 === null) continue;
      out.push({ band, left: Math.min(x1, x2), right: Math.max(x1, x2) });
    }
    return out;
  }

  constructor() {
    const shade: IPrimitivePaneRenderer = {
      draw: (target) => {
        const spans = this.layout();
        if (!spans.length) return;
        target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr }) => {
          const fill = (l: number, r: number, style: string | CanvasPattern) => {
            const a = Math.max(0, Math.round(l * hr));
            const b = Math.min(bitmapSize.width, Math.round(r * hr));
            if (b <= a) return;
            ctx.fillStyle = style;
            ctx.fillRect(a, 0, b - a, bitmapSize.height);
          };
          const overlaps: { left: number; right: number }[] = [];
          for (const s of spans) {
            for (const o of spans) {
              if (o.band.row <= s.band.row) continue;
              const l = Math.max(s.left, o.left);
              const r = Math.min(s.right, o.right);
              if (r > l) overlaps.push({ left: l, right: r });
            }
          }
          for (const s of spans) {
            let at = s.left;
            const cuts = overlaps.filter((o) => o.right > s.left && o.left < s.right).sort((a, b) => a.left - b.left);
            for (const cut of cuts) {
              fill(at, cut.left, `rgba(${s.band.rgb}, ${SESSION_FILL})`);
              at = Math.max(at, cut.right);
            }
            fill(at, s.right, `rgba(${s.band.rgb}, ${SESSION_FILL})`);
          }
          if (!overlaps.length) return;
          const [first, second] = SESSIONS;
          const w = Math.max(4, Math.round(6 * hr));
          const tile = document.createElement("canvas");
          tile.width = w * 2;
          tile.height = w * 2;
          const tc = tile.getContext("2d");
          if (!tc) return;
          // Diagonal stripes that tile seamlessly: two bands per tile, alternating colors.
          const stripe = (rgb: string, offset: number) => {
            tc.fillStyle = `rgba(${rgb}, ${SESSION_STRIPE})`;
            for (const k of [-2, 0, 2]) {
              const o = (k + offset) * w;
              tc.beginPath();
              tc.moveTo(o, 2 * w);
              tc.lineTo(o + w, 2 * w);
              tc.lineTo(o + 3 * w, 0);
              tc.lineTo(o + 2 * w, 0);
              tc.closePath();
              tc.fill();
            }
          };
          stripe(first.rgb, 0);
          stripe(second.rgb, 1);
          const pattern = ctx.createPattern(tile, "repeat");
          if (!pattern) return;
          for (const o of overlaps) {
            pattern.setTransform(new DOMMatrix().translateSelf(Math.round(o.left * hr), 0));
            fill(o.left, o.right, pattern);
          }
        });
      },
    };
    const names: IPrimitivePaneRenderer = {
      draw: (target) => {
        const spans = this.layout();
        if (!spans.length) return;
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
          ctx.font = "600 10px system-ui, sans-serif";
          ctx.textBaseline = "middle";
          ctx.textAlign = "center";
          ctx.lineWidth = 1;
          for (const s of spans) {
            const l = Math.max(0, s.left);
            const r = Math.min(mediaSize.width, s.right);
            if (r - l < 4) continue;
            const y = Math.round(10 + s.band.row * 14) + 0.5;
            const text = s.band.name.toUpperCase();
            const tw = ctx.measureText(text).width;
            const mid = (l + r) / 2;
            const line = `rgba(${s.band.rgb}, 0.75)`;
            ctx.strokeStyle = line;
            ctx.beginPath();
            if (r - l > tw + 24) {
              ctx.moveTo(l, y);
              ctx.lineTo(mid - tw / 2 - 6, y);
              ctx.moveTo(mid + tw / 2 + 6, y);
              ctx.lineTo(r, y);
              ctx.stroke();
              ctx.fillStyle = `rgba(${s.band.rgb}, 1)`;
              ctx.fillText(text, mid, y);
            } else {
              ctx.moveTo(l, y);
              ctx.lineTo(r, y);
              ctx.stroke();
            }
            for (const [x, edge] of [[s.left, l], [s.right, r]] as const) {
              if (x !== edge) continue;
              ctx.beginPath();
              ctx.moveTo(Math.round(x) + 0.5, y - 4);
              ctx.lineTo(Math.round(x) + 0.5, y + 4);
              ctx.stroke();
            }
          }
        });
      },
    };
    this.paneViewsList = [
      { zOrder: () => "bottom", renderer: () => shade },
      { zOrder: () => "top", renderer: () => names },
    ];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.requestUpdate = null;
  }

  setTimes(times: number[], step: number): void {
    this.times = times;
    this.step = step;
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.paneViewsList;
  }
}

const SPIKE_MULT = 2;
const SPIKE_FLOOR = 2;
const SPIKE_HOLD_S = 5 * 60;
const NEWS_WINDOW_S = 45 * 60;

function medianOf(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

type SpikeMark = {
  time: number;
  high: number;
  low: number;
  open: number;
  close: number;
  text: string;
  eventBar: number | null;
  step: number;
  times: number[];
};

// The newest candle, when its range is at least twice a normal one. Names the nearest report, or says none was due.
function explainMove(bars: Candle[], step: number, events: CalendarEvent[]): SpikeMark | null {
  if (bars.length < 12) return null;
  const base = bars.slice(Math.max(0, bars.length - 43), -1);
  const med = medianOf(base.map((c) => c.high - c.low));
  if (med <= 0) return null;
  const now = Math.floor(Date.now() / 1000);
  let candle: Candle | null = null;
  for (let i = bars.length - 1; i >= Math.max(0, bars.length - 8); i--) {
    const c = bars[i];
    const range = c.high - c.low;
    if (range < med * SPIKE_MULT || range < SPIKE_FLOOR) continue;
    const forming = i === bars.length - 1;
    if (forming || now - (c.time + step) <= SPIKE_HOLD_S) candle = c;
    break;
  }
  if (!candle) return null;
  const end = candle.time + step;
  const hits = events
    .filter((e) => e.importance >= 2 && e.time_utc <= end && end - e.time_utc <= NEWS_WINDOW_S)
    .sort((a, b) => Math.abs(a.time_utc - end) - Math.abs(b.time_utc - end) || b.importance - a.importance);
  const names: CalendarEvent[] = [];
  const seen = new Set<string>();
  for (const e of hits) {
    const key = e.plain_name || e.name;
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(e);
  }
  const lead = names[0];
  const net = candle.close - candle.open;
  const range = candle.high - candle.low;
  const move = Math.abs(net) >= range * 0.4
    ? `${net >= 0 ? "+" : "-"}${money(Math.abs(net))}`
    : `${money(range)} range`;
  const title = lead ? (names.length > 1 ? `${shortName(lead)} +${names.length - 1}` : shortName(lead)) : "No report was due";
  return {
    time: candle.time, high: candle.high, low: candle.low, open: candle.open, close: candle.close,
    text: `${title} · ${move}`,
    eventBar: lead ? Math.floor(lead.time_utc / step) * step : null,
    step, times: bars.map((c) => c.time),
  };
}

class SpikeNote implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private mark: SpikeMark | null = null;
  private key = "";
  private box: { l: number; t: number; r: number; b: number } | null = null;
  private readonly paneViewsList: readonly IPrimitivePaneView[];

  constructor() {
    const renderer: IPrimitivePaneRenderer = {
      draw: (target) => {
        const chart = this.chart;
        const series = this.series;
        const mark = this.mark;
        if (!chart || !series || !mark) return;
        const x = chart.timeScale().logicalToCoordinate(logicalOf(mark.times, mark.time, mark.step) as Logical);
        const yHigh = series.priceToCoordinate(mark.high);
        const yLow = series.priceToCoordinate(mark.low);
        const yOpen = series.priceToCoordinate(mark.open);
        const yClose = series.priceToCoordinate(mark.close);
        if (x === null || yHigh === null || yLow === null || yOpen === null || yClose === null) return;
        const half = chart.timeScale().options().barSpacing * 0.42;
        target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
          const cx = x * hr;
          const top = Math.min(yOpen, yClose) * vr;
          const bot = Math.max(yOpen, yClose) * vr;
          const w = Math.max(2 * hr, half * hr);
          ctx.strokeStyle = MARK_COLOR;
          ctx.lineWidth = 1.5 * hr;
          ctx.beginPath();
          ctx.moveTo(cx, yHigh * vr);
          ctx.lineTo(cx, yLow * vr);
          ctx.stroke();
          ctx.strokeRect(cx - w, top, w * 2, Math.max(hr, bot - top));
          ctx.font = `600 ${11 * vr}px ${FONT}`;
          const padX = 6 * hr;
          const padY = 3 * vr;
          const tw = ctx.measureText(mark.text).width;
          const th = 14 * vr;
          let lx = cx - tw / 2;
          let ly = yHigh * vr - th - 8 * vr;
          if (ly < 4 * vr) ly = yLow * vr + 8 * vr;
          lx = Math.max(4 * hr, Math.min(lx, bitmapSize.width - tw - padX * 2 - 4 * hr));
          ctx.fillStyle = "rgba(15, 17, 21, 0.92)";
          ctx.strokeStyle = MARK_COLOR;
          ctx.lineWidth = hr;
          ctx.beginPath();
          ctx.roundRect(lx - padX, ly, tw + padX * 2, th + padY, 4 * hr);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "#f8fafc";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(mark.text, lx, ly + (th + padY) / 2);
          this.box = {
            l: (lx - padX) / hr,
            t: ly / vr,
            r: (lx + tw + padX) / hr,
            b: (ly + th + padY) / vr,
          };
        });
      },
    };
    this.paneViewsList = [{ zOrder: () => "top", renderer: () => renderer }];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
    this.box = null;
  }

  setSpike(mark: SpikeMark | null): void {
    const key = mark ? `${mark.time}|${mark.text}|${mark.high}|${mark.low}|${mark.open}|${mark.close}|${mark.times.length}` : "";
    if (key === this.key) return;
    this.key = key;
    this.mark = mark;
    if (!mark) this.box = null;
    this.requestUpdate?.();
  }

  hitTest(x: number, y: number): PrimitiveHoveredItem | null {
    const b = this.box;
    if (!b || this.mark?.eventBar == null) return null;
    if (x < b.l || x > b.r || y < b.t || y > b.b) return null;
    return { externalId: `spike:${this.mark.eventBar}`, cursorStyle: "pointer", zOrder: "top", hitTestPriority: 2 };
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.paneViewsList;
  }
}

const crosshairTime = (time: Time) =>
  new Date((time as number) * 1000).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });

function signedMoney(n: number) {
  return n >= 0 ? `+${money(n)}` : `-${money(Math.abs(n))}`;
}

// Account profit for a move from one gold price to another. A target calibrates it; otherwise 0.1 lot is $10 per $1.
function moveProfit(trade: AccountTrade, from: number, to: number): number {
  const points = trade.side.startsWith("sell") ? from - to : to - from;
  if (trade.tp > 0 && trade.potential != null) {
    const span = trade.side.startsWith("sell") ? trade.price - trade.tp : trade.tp - trade.price;
    if (span !== 0) return Math.round(trade.potential * (points / span) * 100) / 100;
  }
  return Math.round(points * trade.volume * 100 * 100) / 100;
}

function candleX(chart: IChartApiBase<Time>, times: number[], t: number, step: number): number | null {
  if (t <= 0) return null;
  const exact = chart.timeScale().timeToCoordinate(t as UTCTimestamp);
  if (exact !== null) return exact;
  if (!times.length) return null;
  return chart.timeScale().logicalToCoordinate(logicalOf(times, t, step) as Logical);
}

// Shades the room between an order and its target. The arrow runs from the order's own
// price on the candle that opened it, across to the target on the live candle.
class OrderZone implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private trade: AccountTrade | null = null;
  private closed: { endTime: number; endPrice: number; amount: number } | null = null;
  private times: number[] = [];
  private step = 60;
  private liveTime = 0;
  private livePrice = 0;
  private readonly paneViewsList: readonly IPrimitivePaneView[];

  constructor() {
    const draw = (band: boolean): IPrimitivePaneRenderer["draw"] => (target) => {
      const chart = this.chart;
      const series = this.series;
      const trade = this.trade;
      if (!chart || !series || !trade) return;
      const yEntry = series.priceToCoordinate(trade.price);
      if (yEntry === null) return;
      const closed = this.closed;
      const hasTp = closed != null || trade.tp > 0;
      const headPrice = closed ? closed.endPrice : hasTp ? trade.tp : (this.livePrice || trade.price);
      const yHead = series.priceToCoordinate(headPrice);
      if (yHead === null) return;
      const times = this.times;
      const barTime = trade.time_utc > 0 ? Math.floor(trade.time_utc / this.step) * this.step : 0;
      const closeBar = closed ? Math.floor(closed.endTime / this.step) * this.step : 0;
      const plotted = series.data();
      const last = plotted.length ? plotted[plotted.length - 1] : null;
      const xTail = candleX(chart, times, barTime || trade.time_utc, this.step);
      const xHead = closed
        ? candleX(chart, times, closeBar || closed.endTime, this.step)
        : last
          ? chart.timeScale().timeToCoordinate(last.time as UTCTimestamp)
            ?? chart.timeScale().logicalToCoordinate((plotted.length - 1) as Logical)
          : candleX(chart, times, this.liveTime, this.step);
      const sell = trade.side.startsWith("sell");
      target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
        const rawLeft = xTail === null ? 0 : Math.round(xTail * hr);
        const left = Math.max(0, rawLeft);
        if (hasTp && left < bitmapSize.width) {
          const top = Math.min(yEntry, yHead) * vr;
          const bot = Math.max(yEntry, yHead) * vr;
          const right = closed && xHead !== null ? Math.max(left, Math.round(xHead * hr)) : bitmapSize.width;
          if (band) {
            ctx.fillStyle = "rgba(125, 211, 252, 0.16)";
            ctx.fillRect(left, top, Math.max(hr, right - left), Math.max(hr, bot - top));
            return;
          }
        } else if (band) return;
        if (xTail === null || xHead === null) return;
        const ax0 = xTail * hr;
        const ax1 = xHead * hr;
        const ay0 = yEntry * vr;
        const ay1 = yHead * vr;
        drawWaveArrow(
          ctx,
          { x: ax0, y: ay0 },
          { x: ax1, y: ay1 },
          hasTp ? "rgba(125, 211, 252, 0.45)" : (sell ? "rgba(251, 113, 133, 0.45)" : "rgba(74, 222, 128, 0.45)"),
          hasTp ? "#7dd3fc" : (sell ? "#fb7185" : "#4ade80"),
          hr,
        );
        const amount = closed ? closed.amount : hasTp ? trade.potential : moveProfit(trade, trade.price, headPrice);
        if (amount == null) return;
        const text = signedMoney(amount);
        ctx.font = `600 ${12 * vr}px ${FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const dx = ax1 - ax0;
        const dy = ay1 - ay0;
        const len = Math.hypot(dx, dy) || 1;
        let ox = (-dy / len) * 16 * hr;
        let oy = (dx / len) * 16 * hr;
        if (oy > 0) { ox = -ox; oy = -oy; }
        const tx = (ax0 + ax1) / 2 + ox;
        const ty = (ay0 + ay1) / 2 + oy;
        ctx.lineWidth = 4;
        ctx.strokeStyle = AVG_HALO;
        ctx.strokeText(text, tx, ty);
        ctx.fillStyle = amount >= 0 ? (hasTp ? "#7dd3fc" : "#4ade80") : "#fdba74";
        ctx.fillText(text, tx, ty);
      });
    };
    this.paneViewsList = [
      { zOrder: () => "bottom", renderer: () => ({ draw: draw(true) }) },
      { zOrder: () => "top", renderer: () => ({ draw: draw(false) }) },
    ];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setTrade(trade: AccountTrade | null, times: number[], step: number, live: { time: number; price: number } | null, closed: { endTime: number; endPrice: number; amount: number } | null = null): void {
    this.trade = trade;
    this.closed = closed;
    this.times = times;
    this.step = step;
    if (live && live.time >= this.liveTime) {
      this.liveTime = live.time;
      this.livePrice = live.price;
    }
    this.requestUpdate?.();
  }

  setLive(time: number, price: number): void {
    if (time < this.liveTime) return;
    this.liveTime = time;
    this.livePrice = price;
    if (this.trade) this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.paneViewsList;
  }
}

const lots = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function tradeTitle(side: string, volume: number, profit: number | null) {
  const name = side.replace(/(^|\s)\w/g, (c) => c.toUpperCase());
  const pnl = profit == null ? "" : profit >= 0 ? ` +${money(profit)}` : ` -${money(Math.abs(profit))}`;
  return `${name} ${lots(volume)}${pnl}`;
}

export default function PriceChart({ tf, candles, events, tick, focus, span, highlight, yday, trades, orderFocus, closedFocus, onBarClick, onVisibleRangeChange, onNeedOlder }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const futureRef = useRef<ISeriesApi<"Line"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const futureMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const dropsRef = useRef<NewsDropLines | null>(null);
  const sessionRef = useRef<SessionShade | null>(null);
  const spikeRef = useRef<SpikeNote | null>(null);
  const shadeRef = useRef<DayShade | null>(null);
  const orderZoneRef = useRef<OrderZone | null>(null);
  const highlightRef = useRef<NewsHighlight | null>(null);
  const highlightTimeRef = useRef<number | null>(null);
  const zoomedNews = useRef("");
  const zoomedClose = useRef("");
  const fittedSpan = useRef("");
  const columnsRef = useRef<Column[]>([]);
  const futureColumnsRef = useRef<FutureColumn[]>([]);
  const hadCandlesRef = useRef(false);
  const candlesRef = useRef<Candle[]>([]);
  const layoutRef = useRef<() => void>(() => {});
  const lastBarRef = useRef<Candle | null>(null);
  const orderLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const askLineRef = useRef<IPriceLine | null>(null);
  // Candles the chart has actually drawn, including bars that formed after the page loaded.
  const plottedRef = useRef<Candle[]>([]);
  const upcomingTimesRef = useRef<Set<number>>(new Set());
  // Future-series times that carry a real value. Markers on a whitespace slot throw and blank the chart.
  const futureValuedRef = useRef<Set<number>>(new Set());
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const tfRef = useRef(tf);
  tfRef.current = tf;
  const refreshSpikeRef = useRef(() => {});
  refreshSpikeRef.current = () => {
    spikeRef.current?.setSpike(explainMove(plottedRef.current, TF_SECONDS[tfRef.current], eventsRef.current));
  };
  const callbacks = useRef({ onBarClick, onVisibleRangeChange, onNeedOlder });
  callbacks.current = { onBarClick, onVisibleRangeChange, onNeedOlder };

  useEffect(() => {
    const el = containerRef.current!;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#0f1115" }, textColor: "#c9ced6", attributionLogo: false },
      grid: { vertLines: { color: "#1c2028" }, horzLines: { color: "#1c2028" } },
      rightPriceScale: { borderColor: "#2a2f3a" },
      timeScale: { borderColor: "#2a2f3a", timeVisible: true, secondsVisible: false, rightOffset: 8, tickMarkFormatter: tickMark },
      localization: { timeFormatter: crosshairTime },
      crosshair: { mode: 0 },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e", downColor: "#ef4444", borderVisible: false, wickUpColor: "#22c55e", wickDownColor: "#ef4444",
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    candleSeries.priceScale().applyOptions({ scaleMargins: { top: SCALE_TOP, bottom: SCALE_BOTTOM } });
    const volumeSeries = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, color: "#334155" });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    const sessions = new SessionShade();
    candleSeries.attachPrimitive(sessions);
    sessionRef.current = sessions;
    const spike = new SpikeNote();
    candleSeries.attachPrimitive(spike);
    spikeRef.current = spike;
    const orderZone = new OrderZone();
    candleSeries.attachPrimitive(orderZone);
    orderZoneRef.current = orderZone;
    const shade = new DayShade();
    candleSeries.attachPrimitive(shade);
    shadeRef.current = shade;
    const highlightMark = new NewsHighlight();
    candleSeries.attachPrimitive(highlightMark);
    highlightRef.current = highlightMark;
    const drops = new NewsDropLines();
    candleSeries.attachPrimitive(drops);
    dropsRef.current = drops;
    markersRef.current = createSeriesMarkers(candleSeries, []);
    // Whitespace-only series: extends the time axis past the last candle so scheduled news has a slot.
    // Markers skip whitespace, so release slots carry a dummy value kept out of autoscale.
    const futureSeries = chart.addSeries(LineSeries, {
      lineVisible: false, pointMarkersVisible: false, crosshairMarkerVisible: false,
      lastValueVisible: false, priceLineVisible: false, autoscaleInfoProvider: () => null,
    });
    futureMarkersRef.current = createSeriesMarkers(futureSeries, []);
    futureRef.current = futureSeries;

    chart.subscribeClick((param) => {
      const id = param.hoveredObjectId;
      if (typeof id === "string" && id.startsWith("spike:")) {
        const bar = Number(id.slice(6));
        if (Number.isFinite(bar)) callbacks.current.onBarClick(bar);
        return;
      }
      if (param.time !== undefined) callbacks.current.onBarClick(param.time as number);
    });
    let frame = 0;
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => layoutRef.current());
      const vr = chart.timeScale().getVisibleRange();
      if (vr) callbacks.current.onVisibleRangeChange(vr.from as number, vr.to as number);
      if (range && range.from < 20) callbacks.current.onNeedOlder();
    });

    chartRef.current = chart;
    candleRef.current = candleSeries;
    volumeRef.current = volumeSeries;
    return () => {
      cancelAnimationFrame(frame);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      futureRef.current = null;
      markersRef.current = null;
      futureMarkersRef.current = null;
      dropsRef.current = null;
      sessionRef.current = null;
      spikeRef.current = null;
      shadeRef.current = null;
      orderZoneRef.current = null;
      highlightRef.current = null;
      orderLinesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const series = candleRef.current;
    if (!series || !yday) return;
    const high = series.createPriceLine({
      price: yday.high, color: "#fca5a5", lineWidth: 1, lineStyle: LineStyle.Dashed,
      axisLabelVisible: true, title: "Yday high",
    });
    const low = series.createPriceLine({
      price: yday.low, color: "#86efac", lineWidth: 1, lineStyle: LineStyle.Dashed,
      axisLabelVisible: true, title: "Yday low",
    });
    return () => {
      series.removePriceLine(high);
      series.removePriceLine(low);
    };
  }, [yday]);

  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    const wanted = new Map<string, { price: number; color: string; lineStyle: LineStyle; title: string }>();
    const tpCount = new Map<string, number>();
    const slCount = new Map<string, number>();
    for (const t of trades) {
      const sell = t.side.startsWith("sell");
      wanted.set(`e:${t.kind}:${t.ticket}`, {
        price: t.price,
        color: sell ? "#fb7185" : "#4ade80",
        lineStyle: t.kind === "order" ? LineStyle.Dashed : LineStyle.Solid,
        title: tradeTitle(t.side, t.volume, t.profit),
      });
      if (t.tp > 0) {
        const key = t.tp.toFixed(3);
        tpCount.set(key, (tpCount.get(key) ?? 0) + 1);
      }
      if (t.sl > 0) {
        const key = t.sl.toFixed(3);
        slCount.set(key, (slCount.get(key) ?? 0) + 1);
      }
    }
    const tpPotential = new Map<string, number>();
    for (const t of trades) {
      if (t.tp <= 0 || t.potential == null) continue;
      const key = t.tp.toFixed(3);
      tpPotential.set(key, (tpPotential.get(key) ?? 0) + t.potential);
    }
    for (const [price, n] of tpCount) {
      const gain = tpPotential.get(price);
      const name = n > 1 ? `TP ×${n}` : "TP";
      wanted.set(`tp:${price}`, {
        price: Number(price), color: "#7dd3fc", lineStyle: LineStyle.Dotted,
        title: gain == null ? name : `${name} ${signedMoney(gain)}`,
      });
    }
    for (const [price, n] of slCount) {
      wanted.set(`sl:${price}`, { price: Number(price), color: "#fdba74", lineStyle: LineStyle.Dotted, title: n > 1 ? `SL ×${n}` : "SL" });
    }
    if (closedFocus) {
      const sell = closedFocus.side.startsWith("sell");
      wanted.set("hx:open", {
        price: closedFocus.open_price,
        color: sell ? "#fb7185" : "#4ade80",
        lineStyle: LineStyle.Solid,
        title: tradeTitle(closedFocus.side, closedFocus.volume, null),
      });
      wanted.set("hx:close", {
        price: closedFocus.close_price,
        color: closedFocus.net >= 0 ? "#4ade80" : "#fb7185",
        lineStyle: LineStyle.Dashed,
        title: `Closed ${signedMoney(closedFocus.net)}`,
      });
    }
    const lines = orderLinesRef.current;
    for (const key of [...lines.keys()]) {
      if (wanted.has(key)) continue;
      series.removePriceLine(lines.get(key)!);
      lines.delete(key);
    }
    for (const [key, opt] of wanted) {
      const focused = key.startsWith("hx:") || (orderFocus != null && (key === `e:${orderFocus.kind}:${orderFocus.ticket}` || key === `tp:${orderFocus.tp.toFixed(3)}`));
      const options = { ...opt, lineWidth: (focused ? 2 : 1) as 1 | 2, axisLabelVisible: true };
      const existing = lines.get(key);
      if (existing) existing.applyOptions(options);
      else lines.set(key, series.createPriceLine(options));
    }
  }, [trades, orderFocus, closedFocus]);

  useEffect(() => {
    const saved = candles[candles.length - 1];
    const formed = lastBarRef.current;
    const last = formed && (!saved || formed.time >= saved.time) ? formed : saved;
    const shown: AccountTrade | null = closedFocus
      ? {
          ticket: closedFocus.position,
          symbol: closedFocus.symbol,
          side: closedFocus.side,
          kind: "position",
          volume: closedFocus.volume,
          price: closedFocus.open_price,
          sl: 0,
          tp: 0,
          profit: closedFocus.net,
          potential: closedFocus.net,
          swap: 0,
          time_utc: closedFocus.open_utc,
          comment: "",
        }
      : orderFocus;
    orderZoneRef.current?.setTrade(
      shown,
      candles.map((c) => c.time),
      TF_SECONDS[tf],
      last ? { time: last.time, price: last.close } : null,
      closedFocus ? { endTime: closedFocus.close_utc, endPrice: closedFocus.close_price, amount: closedFocus.net } : null,
    );
  }, [orderFocus, closedFocus, candles, tf]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!closedFocus) {
      zoomedClose.current = "";
      return;
    }
    if (!chart || !candles.length) return;
    const id = `${tf}:${closedFocus.position}:${closedFocus.open_utc}`;
    if (zoomedClose.current === id) return;
    const step = TF_SECONDS[tf];
    const openBar = Math.floor(closedFocus.open_utc / step) * step;
    const closeBar = Math.floor(closedFocus.close_utc / step) * step;
    if (candles[0].time > openBar || candles[candles.length - 1].time < closeBar) return;
    zoomedClose.current = id;
    const span = Math.max(step * 12, closeBar - openBar);
    const pad = Math.max(step * 6, span * 0.2);
    chart.timeScale().setVisibleRange({
      from: (openBar - pad) as UTCTimestamp,
      to: (closeBar + pad) as UTCTimestamp,
    });
  }, [closedFocus, candles, tf]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !candleRef.current || !volumeRef.current || !futureRef.current) return;
    const step = TF_SECONDS[tf];
    const plotted = candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }));
    // The bar still forming opens where the previous one closed, so the two stay joined.
    const forming = Math.floor(Date.now() / 1000 / step) * step;
    if (plotted.length >= 2 && plotted[plotted.length - 1].time >= forming) {
      const prevClose = plotted[plotted.length - 2].close;
      const lastBar = plotted[plotted.length - 1];
      lastBar.high = Math.max(lastBar.high, prevClose);
      lastBar.low = Math.min(lastBar.low, prevClose);
      lastBar.open = prevClose;
    }
    // Drop dots before the series is replaced. A dot left on a whitespace slot crashes the chart.
    markersRef.current?.setMarkers([]);
    futureMarkersRef.current?.setMarkers([]);
    candleRef.current.setData(plotted);
    volumeRef.current.setData(
      candles.map((c, i) => ({ time: c.time as UTCTimestamp, value: c.tick_volume, color: plotted[i].close >= plotted[i].open ? "#14532d" : "#7f1d1d" })),
    );
    const tail = plotted.length ? plotted[plotted.length - 1] : null;
    lastBarRef.current = tail && candles.length ? { ...candles[candles.length - 1], open: tail.open, high: tail.high, low: tail.low, close: tail.close } : null;
    plottedRef.current = plotted.map((c, i) => ({
      time: c.time as number, open: c.open, high: c.high, low: c.low, close: c.close,
      tick_volume: candles[i]?.tick_volume ?? 0,
    }));

    const last = tail ? tail.time : 0;
    const slots = tail ? futurePoints(last, step, upcomingTimesRef.current, tail.close) : [];
    futureValuedRef.current = new Set(slots.flatMap((p) => (p.value == null ? [] : [p.time as number])));
    futureRef.current.setData(slots);

    // The future slots push the axis' right edge out, so a fresh load must re-anchor on the last candle.
    if (candles.length && !hadCandlesRef.current) {
      const end = candles.length - 1;
      chart.timeScale().setVisibleLogicalRange({ from: end - 140, to: end + 30 });
    }
    hadCandlesRef.current = candles.length > 0;
    sessionRef.current?.setTimes(plotted.map((c) => c.time as number), step);
    refreshSpikeRef.current();
  }, [candles, tf]);

  layoutRef.current = () => {
    const chart = chartRef.current;
    const data = candlesRef.current;
    if (!chart || !markersRef.current || !data.length) return;
    const range = chart.timeScale().getVisibleLogicalRange();
    const drawn = plottedRef.current.length >= data.length ? plottedRef.current : data;
    const from = Math.max(0, Math.floor(range?.from ?? 0));
    const to = Math.min(data.length - 1, Math.ceil(range?.to ?? data.length - 1));
    const drawnTo = Math.min(drawn.length - 1, Math.ceil(range?.to ?? drawn.length - 1));
    // Scrolled fully into the future: keep the ground floor where the latest candles left it.
    const hiFrom = from > drawnTo ? Math.max(0, drawn.length - 100) : from;
    const hiTo = from > drawnTo ? drawn.length - 1 : drawnTo;

    let hi = -Infinity;
    let lo = Infinity;
    for (let j = hiFrom; j <= hiTo; j++) {
      hi = Math.max(hi, drawn[j].high);
      lo = Math.min(lo, drawn[j].low);
    }
    const plotHeight = chart.paneSize(0).height * (1 - SCALE_TOP - SCALE_BOTTOM);
    const perPx = plotHeight > 0 && hi > lo ? (hi - lo) / plotHeight : 0.1;
    const ground = hi + GROUND_PX * perPx;

    const drops: DropLine[] = [];
    const labels: NewsLabel[] = [];
    const place = (time: UTCTimestamp, { shown, total }: Stack, future: boolean) =>
      shown.map((e, i): SeriesMarker<Time> => {
        const price = ground + (shown.length - 1 - i) * FLOOR_PX * perPx;
        if (i === 0 && e.importance >= 3) {
          const more = total > 1 ? ` +${total - 1}` : "";
          labels.push({
            time,
            price: price + SUBFLOOR_PX * perPx,
            text: future ? `${shortName(e)}${more} · ${dueLabel(e.time_utc)}` : `${shortName(e)}${more}`,
            color: future ? FUTURE_LABEL_COLOR : LABEL_COLOR,
          });
        }
        return {
          time,
          position: "atPriceMiddle",
          price,
          shape: "circle",
          color: IMPORTANCE_COLOR[e.importance] ?? "#9ca3af",
          size: e.importance >= 3 ? 1 : 0.8,
        };
      });

    const markers: SeriesMarker<Time>[] = [];
    for (const col of columnsRef.current) {
      const time = data[col.idx].time as UTCTimestamp;
      markers.push(...place(time, col, false));
      if (col.idx < from || col.idx > to) continue;
      const live = lastBarRef.current;
      const candle = live && live.time === data[col.idx].time ? live : data[col.idx];
      drops.push({ time, top: ground, bottom: candle.high });
    }

    const future: SeriesMarker<Time>[] = [];
    for (const col of futureColumnsRef.current) {
      if (!futureValuedRef.current.has(col.time)) continue;
      const time = col.time as UTCTimestamp;
      future.push(...place(time, col, true));
      drops.push({ time, top: ground, bottom: null });
    }

    markersRef.current.setMarkers(markers);
    futureMarkersRef.current?.setMarkers(future);
    const latest = Math.max(data[data.length - 1].time, lastBarRef.current?.time ?? 0);
    const next = (latest + TF_SECONDS[tf]) as UTCTimestamp;
    // Crowded names are dropped in this order: the nearest upcoming release wins, then the most recent past one.
    const rank = (t: number) => (t > latest ? t - latest : latest - t + FUTURE_SPAN_S * 10);
    labels.sort((a, b) => rank(a.time) - rank(b.time));
    dropsRef.current?.setOverlay(drops, labels, next);

    const picked = highlightTimeRef.current;
    if (picked == null) {
      highlightRef.current?.setMark(null);
    } else {
      const times = data.map((c) => c.time);
      const i = lowerBound(times, picked);
      const found = i < times.length && times[i] === picked ? data[i] : null;
      const live = lastBarRef.current;
      const candle = found && live && live.time === found.time ? live : found;
      const dots = [...markers, ...future].flatMap((m) => (m.time === picked && m.price != null ? [m.price] : []));
      const seriesBars = plottedRef.current.length >= data.length ? plottedRef.current : data;
      const move = hourMove(seriesBars, picked, TF_SECONDS[tf]);
      highlightRef.current?.setMark(dots.length || candle || move ? {
        time: picked as UTCTimestamp, candle, dots, move, times: seriesBars.map((c) => c.time), step: TF_SECONDS[tf],
      } : null);
    }
  };

  useEffect(() => {
    candlesRef.current = candles;
    if (!candles.length) return;
    const step = TF_SECONDS[tf];
    const times = candles.map((c) => c.time);
    const last = times[times.length - 1];
    const horizon = last + Math.min(FUTURE_MAX_BARS, Math.ceil(FUTURE_SPAN_S / step)) * step;

    const columns = new Map<number, CalendarEvent[]>();
    const upcoming = new Map<number, CalendarEvent[]>();
    for (const e of events) {
      if (e.importance < 2) continue;
      const bar = Math.floor(e.time_utc / step) * step;
      if (bar < times[0] || bar > horizon) continue;
      if (bar > last) {
        upcoming.set(bar, [...(upcoming.get(bar) ?? []), e]);
        continue;
      }
      const idx = lowerBound(times, bar);
      columns.set(idx, [...(columns.get(idx) ?? []), e]);
    }

    columnsRef.current = [...columns.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, evs]) => ({ idx, ...stackOf(evs) }));
    futureColumnsRef.current = [...upcoming.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([time, evs]) => ({ time, ...stackOf(evs) }));
    const close = candles[candles.length - 1].close;
    upcomingTimesRef.current = new Set(upcoming.keys());
    // Start after the live bar when it has already moved past the last saved candle, so no empty minute sits between them.
    const liveTime = lastBarRef.current?.time ?? last;
    const from = Math.max(last, liveTime);
    const slots = futurePoints(from, step, upcomingTimesRef.current, close);
    futureValuedRef.current = new Set(slots.flatMap((p) => (p.value == null ? [] : [p.time as number])));
    futureMarkersRef.current?.setMarkers([]);
    futureRef.current?.setData(slots);
    requestAnimationFrame(() => layoutRef.current());
    refreshSpikeRef.current();
  }, [events, candles, tf]);

  useEffect(() => {
    const bar = lastBarRef.current;
    if (!tick || !bar || !candleRef.current) return;
    const step = TF_SECONDS[tf];
    const barTime = Math.floor(tick.time_utc / step) * step;
    const price = tick.bid;
    if (barTime < bar.time) return;
    const next =
      barTime === bar.time
        ? { ...bar, high: Math.max(bar.high, price), low: Math.min(bar.low, price), close: price }
        : { time: barTime, open: bar.close, high: Math.max(bar.close, price), low: Math.min(bar.close, price), close: price, tick_volume: 0 };
    lastBarRef.current = next;
    const drawn = plottedRef.current;
    if (drawn.length && next.time === drawn[drawn.length - 1].time) drawn[drawn.length - 1] = next;
    else if (!drawn.length || next.time > drawn[drawn.length - 1].time) drawn.push(next);
    // A skipped minute leaves empty future slots between the two candles. Drop those so the new bar sits against the last one.
    if (next.time > bar.time + step) {
      const slots = futurePoints(next.time, step, upcomingTimesRef.current, next.close);
      futureValuedRef.current = new Set(slots.flatMap((p) => (p.value == null ? [] : [p.time as number])));
      futureMarkersRef.current?.setMarkers([]);
      futureRef.current?.setData(slots);
    }
    // The news arrow reads these bars. A close-only tick still has to move it; high and low are not enough.
    if (highlightTimeRef.current != null || next.high > bar.high || next.low < bar.low || next.time !== bar.time) layoutRef.current();
    candleRef.current.update({ time: next.time as UTCTimestamp, open: next.open, high: next.high, low: next.low, close: next.close });
    orderZoneRef.current?.setLive(next.time, next.close);
    refreshSpikeRef.current();
  }, [tick, tf]);

  useEffect(() => {
    const series = candleRef.current;
    if (!series || !tick) return;
    if (askLineRef.current) askLineRef.current.applyOptions({ price: tick.ask });
    else {
      askLineRef.current = series.createPriceLine({
        price: tick.ask, color: "#34d399", lineWidth: 1, lineStyle: LineStyle.Dotted,
        axisLabelVisible: true, title: "Buy (ask)",
      });
    }
  }, [tick]);

  useEffect(() => () => {
    if (askLineRef.current) candleRef.current?.removePriceLine(askLineRef.current);
    askLineRef.current = null;
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const shade = shadeRef.current;
    if (!shade) return;
    const step = TF_SECONDS[tf];
    const times = candles.map((c) => c.time);
    shade.setSpan(span, times, step, span ? fitDay(candles, span, step, tick) : null);
    if (!span) {
      fittedSpan.current = "";
      return;
    }
    const id = `${tf}:${span.key}`;
    if (!chart || !times.length || fittedSpan.current === id) return;
    const now = Math.floor(Date.now() / 1000);
    const covered = times[0] <= span.start + step && times[times.length - 1] >= Math.min(span.end, now) - step;
    if (!covered) return;
    fittedSpan.current = id;
    const pad = Math.max(step * 4, (span.end - span.start) * 0.06);
    chart.timeScale().setVisibleLogicalRange({
      from: logicalOf(times, span.start - pad, step) as Logical,
      to: logicalOf(times, span.end + pad, step) as Logical,
    });
  }, [span, candles, tf, tick]);

  useEffect(() => {
    highlightTimeRef.current = highlight;
    requestAnimationFrame(() => layoutRef.current());
    const chart = chartRef.current;
    if (highlight == null) {
      zoomedNews.current = "";
      return;
    }
    const id = `${tf}:${highlight}`;
    if (!chart || !candles.length || zoomedNews.current === id) return;
    zoomedNews.current = id;
    // 4 hours before the release and 8 hours after. On a 15-minute chart that is 16 candles, then 32.
    const before = 4 * 3600;
    const after = 8 * 3600;
    chart.timeScale().setVisibleRange({
      from: (highlight - before) as UTCTimestamp,
      to: (highlight + after) as UTCTimestamp,
    });
  }, [highlight, candles, tf]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !focus || !candles.length) return;
    const step = TF_SECONDS[tf];
    const picked = highlightTimeRef.current;
    if (picked != null && Math.abs(focus.time - picked) < step) return;
    const span = step * 60;
    chart.timeScale().setVisibleRange({ from: (focus.time - span) as UTCTimestamp, to: (focus.time + span) as UTCTimestamp });
  }, [focus, tf]);

  return <div className="chart" ref={containerRef} />;
}

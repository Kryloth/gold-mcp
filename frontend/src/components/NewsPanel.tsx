import { useMemo, useState } from "react";
import { fmtNum, fmtTime, IMPORTANCE_COLOR, type CalendarEvent, type Headline } from "../api";

type Item =
  | { kind: "event"; time: number; event: CalendarEvent }
  | { kind: "headline"; time: number; headline: Headline };

interface Props {
  events: CalendarEvent[];
  headlines: Headline[];
  visibleRange: { from: number; to: number } | null;
  onSelectEvent: (e: CalendarEvent) => void;
  onFocusTime: (t: number) => void;
}

function toneClass(t: number | null) {
  if (t === null || t === 0) return "tone-flat";
  return t > 0 ? "tone-up" : "tone-down";
}

const RESULT_CLASS: Record<string, string> = {
  "higher than expected": "res-hi",
  "lower than expected": "res-lo",
  "as expected": "res-eq",
};

export default function NewsPanel({ events, headlines, visibleRange, onSelectEvent, onFocusTime }: Props) {
  const [kind, setKind] = useState<"all" | "event" | "headline">("all");
  const [minImp, setMinImp] = useState(2);
  const [syncRange, setSyncRange] = useState(true);
  const [search, setSearch] = useState("");

  const items = useMemo(() => {
    const now = Date.now() / 1000;
    const q = search.trim().toLowerCase();
    const list: Item[] = [];
    if (kind !== "headline")
      for (const e of events)
        if (e.importance >= minImp && e.time_utc <= now && (!q || `${e.name} ${e.plain_name}`.toLowerCase().includes(q)))
          list.push({ kind: "event", time: e.time_utc, event: e });
    if (kind !== "event")
      for (const h of headlines)
        if (!q || h.title.toLowerCase().includes(q)) list.push({ kind: "headline", time: h.time_utc, headline: h });
    const inRange = syncRange && visibleRange ? list.filter((i) => i.time >= visibleRange.from && i.time <= visibleRange.to) : list;
    return inRange.sort((a, b) => b.time - a.time).slice(0, 400);
  }, [events, headlines, kind, minImp, syncRange, visibleRange, search]);

  return (
    <div className="news">
      <div className="controls">
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="all">Everything</option>
          <option value="event">Economic reports only</option>
          <option value="headline">Headlines only</option>
        </select>
        <select value={minImp} onChange={(e) => setMinImp(Number(e.target.value))}>
          <option value={1}>All reports</option>
          <option value={2}>Medium + big reports</option>
          <option value={3}>Big reports only</option>
        </select>
        <label title="Only show news from the part of the chart you are looking at">
          <input type="checkbox" checked={syncRange} onChange={(e) => setSyncRange(e.target.checked)} /> match chart
        </label>
      </div>
      <input className="search" placeholder="Search news, e.g. inflation, jobs, Fed..." value={search} onChange={(e) => setSearch(e.target.value)} />
      <ul className="items">
        {items.length === 0 && <li className="empty">No news in this part of the chart. Scroll the chart or untick "match chart".</li>}
        {items.map((i) =>
          i.kind === "event" ? (
            <li key={`e${i.event.value_id}`} className="item event" onClick={() => { onSelectEvent(i.event); onFocusTime(i.time); }}>
              <span className="dot" style={{ background: IMPORTANCE_COLOR[i.event.importance] }} />
              <div>
                <div className="title">
                  {i.event.plain_name}
                  {i.event.result_label && <span className={`res ${RESULT_CLASS[i.event.result_label] ?? ""}`}>{i.event.result_label}</span>}
                </div>
                <div className="meta">
                  {fmtTime(i.time)}
                  {i.event.actual_text && <> · published {i.event.actual_text}</>}
                  {i.event.forecast_text && <> · forecast was {i.event.forecast_text}</>}
                </div>
                {i.event.ret_1h != null && (
                  <div className={`meta ${i.event.ret_1h >= 0 ? "tone-up" : "tone-down"}`}>
                    Gold {i.event.ret_1h >= 0 ? "rose" : "fell"} ${fmtNum(Math.abs(i.event.ret_1h))} in the next hour
                  </div>
                )}
              </div>
            </li>
          ) : (
            <li key={i.headline.url} className="item headline" onClick={() => onFocusTime(i.time)}>
              <span className={`dot ${toneClass(i.headline.tone)}`} title="Green = sounds good for gold, red = sounds bad, grey = neutral" />
              <div>
                <a className="title" href={i.headline.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                  {i.headline.title}
                </a>
                <div className="meta">{fmtTime(i.time)} | {i.headline.source.replace(/_/g, " ")}</div>
              </div>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

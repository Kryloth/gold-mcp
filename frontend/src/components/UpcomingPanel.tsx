import { useEffect, useState } from "react";
import { fmtTime, IMPORTANCE_COLOR, type CalendarEvent } from "../api";

function countdown(secs: number): string {
  if (secs <= 0) return "any moment";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (d) return `in ${d}d ${h}h`;
  if (h) return `in ${h}h ${m}m`;
  return `in ${m}m ${s.toString().padStart(2, "0")}s`;
}

export default function UpcomingPanel({ events, onSelect }: { events: CalendarEvent[]; onSelect: (e: CalendarEvent) => void }) {
  const [now, setNow] = useState(Date.now() / 1000);
  const [bigOnly, setBigOnly] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);

  const shown = events.filter((e) => !bigOnly || e.importance >= 3);
  return (
    <div className="upcoming">
      <div className="hint">
        Scheduled news that can move gold. Click one to learn what it is.
        <label><input type="checkbox" checked={bigOnly} onChange={(e) => setBigOnly(e.target.checked)} /> big news only</label>
      </div>
      <ul className="items">
        {shown.length === 0 && <li className="empty">No upcoming events. Is the GoldCalendarExport service running in MT5?</li>}
        {shown.map((e) => (
          <li key={e.value_id} className="item event" onClick={() => onSelect(e)}>
            <span className="dot" style={{ background: IMPORTANCE_COLOR[e.importance] }} />
            <div>
              <div className="title">{e.plain_name}</div>
              <div className="meta">
                {fmtTime(e.time_utc)}
                {e.forecast_text && <> | expected {e.forecast_text}</>}
                {e.previous_text && <> (last time {e.previous_text})</>}
              </div>
              {e.history?.typical_move_1h != null && (
                <div className="meta">Usually moves gold about ${Math.round(e.history.typical_move_1h)} within an hour</div>
              )}
            </div>
            <span className={`countdown ${e.time_utc - now < 3600 ? "soon" : ""}`}>{countdown(e.time_utc - now)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

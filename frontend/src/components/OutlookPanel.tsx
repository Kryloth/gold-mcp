import { useEffect, useState } from "react";
import { api, money, type Outlook } from "../api";

const HORIZONS = [
  { h: 1, label: "Next hour" },
  { h: 4, label: "Next 4 hours" },
  { h: 12, label: "Next 12 hours" },
];

function RangeBar({ o }: { o: Outlook }) {
  const pad = (o.likely_high - o.likely_low) * 0.25;
  const min = o.likely_low - pad;
  const max = o.likely_high + pad;
  const pos = (v: number) => `${Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100))}%`;
  return (
    <div className="rangebar">
      <div className="band" style={{ left: pos(o.likely_low), width: `calc(${pos(o.likely_high)} - ${pos(o.likely_low)})` }} />
      <div className="now" style={{ left: pos(o.price) }} title="Price now" />
      <div className="labels">
        <span style={{ left: pos(o.likely_low) }}>{money(o.likely_low)}</span>
        <span className="now-label" style={{ left: pos(o.price) }}>now {money(o.price)}</span>
        <span style={{ left: pos(o.likely_high) }}>{money(o.likely_high)}</span>
      </div>
    </div>
  );
}

export default function OutlookPanel({ onFocusTime, refreshKey }: { onFocusTime: (t: number) => void; refreshKey: number }) {
  const [hours, setHours] = useState(4);
  const [o, setO] = useState<Outlook | null>(null);

  useEffect(() => {
    api.outlook(hours).then(setO).catch(() => setO(null));
  }, [hours, refreshKey]);

  return (
    <div className="outlook">
      <div className="seg">
        {HORIZONS.map((x) => (
          <button key={x.h} className={x.h === hours ? "active" : ""} onClick={() => setHours(x.h)}>{x.label}</button>
        ))}
      </div>
      {!o && <p className="muted">Loading...</p>}
      {o?.error && <p className="muted">{o.error}</p>}
      {o && !o.error && (
        <>
          <p className="big">{o.headline}</p>
          <RangeBar o={o} />
          <p>{o.explain_range}</p>
          <h4>How much will it move?</h4>
          <p>{o.explain_swing}</p>
          <h4>Which way?</h4>
          <p>
            <span className={`lean lean-${o.lean.replace(/\s/g, "-")}`}>{o.lean}</span> {o.explain_lean.replace(/^Leaning [^:]+: /, "Why: ")}
          </p>
          <h4>Scheduled news</h4>
          <p>{o.events_note}</p>
          {o.watch_out.length > 0 && (
            <ul className="watch">
              {o.watch_out.map((w) => (
                <li key={w.time_utc} onClick={() => onFocusTime(w.time_utc)}>
                  <span className={`imp imp${w.importance === "high" ? 3 : 2}`}>{w.time_local}</span> {w.text}
                </li>
              ))}
            </ul>
          )}
          <p className="disclaimer">Based on past price behaviour only. Not financial advice.</p>
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { api, money, type ChartSpan, type DayDigest } from "../api";

interface Props {
  activeDay: string | null;
  activeIds: number[];
  onFocusTime: (t: number) => void;
  onSelectDay: (span: ChartSpan | null) => void;
  onSelectRelease: (valueId: number) => void;
  refreshKey: number;
}

function dayTitle(d: DayDigest) {
  if (d.is_today) return "Today";
  const date = new Date(`${d.date}T12:00:00`);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function Day({ d, activeDay, activeIds, onFocusTime, onSelectDay, onSelectRelease }: { d: DayDigest } & Omit<Props, "refreshKey">) {
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const ch = d.price?.change ?? 0;
  const active = activeDay === d.date;
  return (
    <article className={`day ${active ? "active" : ""}`}>
      <header>
        <h3 onClick={() => onFocusTime(d.start_utc + 43200)}>{dayTitle(d)}</h3>
        {d.price && (
          <button
            type="button"
            className={`chg ${ch >= 0 ? "up" : "down"} ${active ? "on" : ""}`}
            title="Shade this day on the chart"
            onClick={() => onSelectDay(active ? null : {
              key: d.date,
              label: dayTitle(d),
              start: d.start_utc,
              end: d.start_utc + 86400,
              up: ch >= 0,
              today: d.is_today,
            })}
          >
            {ch >= 0 ? "+" : "-"}{money(Math.abs(ch))} ({ch >= 0 ? "+" : ""}{d.price.change_pct}%)
          </button>
        )}
      </header>
      <p>{d.summary}</p>
      {d.key_releases.length > 0 && (
        <>
          <h4>Key news</h4>
          <ul className="releases">
            {d.key_releases.map((r) => (
              <li key={r.time_utc} className={activeIds.includes(r.value_id) ? "on" : ""} onClick={() => { onFocusTime(r.time_utc); onSelectRelease(r.value_id); }}>
                <span className={`imp imp${r.importance}`}>{r.time_local}</span>
                <div>
                  <div>{r.text}</div>
                  {r.also_released.length > 0 && <div className="muted small">Released together with: {r.also_released.join(", ")}</div>}
                  {r.gold_reaction_text && (
                    <div className={(r.gold_reaction ?? 0) >= 0 ? "tone-up small" : "tone-down small"}>{r.gold_reaction_text}</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {d.topics.length > 0 && (
        <>
          <h4>What the news talked about ({d.headline_count} headlines)</h4>
          <div className="topics">
            {d.topics.map((t) => (
              <button key={t.topic} className={openTopic === t.topic ? "active" : ""} onClick={() => setOpenTopic(openTopic === t.topic ? null : t.topic)}>
                {t.topic} <span className="muted">{t.count}</span>
              </button>
            ))}
          </div>
          {openTopic && (
            <ul className="examples">
              {d.topics.find((t) => t.topic === openTopic)?.examples.map((ex) => (
                <li key={ex.url}><a href={ex.url} target="_blank" rel="noreferrer">{ex.title}</a></li>
              ))}
            </ul>
          )}
        </>
      )}
    </article>
  );
}

export default function DigestPanel({ activeDay, activeIds, onFocusTime, onSelectDay, onSelectRelease, refreshKey }: Props) {
  const [days, setDays] = useState<DayDigest[] | null>(null);
  useEffect(() => {
    api.digest(7).then(setDays).catch(() => setDays([]));
  }, [refreshKey]);

  if (!days) return <p className="muted pad">Loading summaries...</p>;
  return (
    <div className="digest">
      {days.map((d) => (
        <Day key={d.date} d={d} activeDay={activeDay} activeIds={activeIds} onFocusTime={onFocusTime} onSelectDay={onSelectDay} onSelectRelease={onSelectRelease} />
      ))}
      <p className="disclaimer pad">Headline history starts from when the app was first run, so older days show calendar news only.</p>
    </div>
  );
}

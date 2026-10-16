import { useEffect, useState } from "react";
import {
  api, fmtNum, fmtTime,
  type CalendarEvent, type Dist, type DistBlock, type EventStats,
} from "../api";

const HORIZONS: [keyof DistBlock, string][] = [
  ["ret_5m", "after 5 min"], ["ret_15m", "after 15 min"], ["ret_1h", "after 1 hour"], ["ret_4h", "after 4 hours"],
];

function Row({ label, d }: { label: string; d: Dist | null }) {
  if (!d) return <tr><td>{label}</td><td colSpan={3} className="muted">no data</td></tr>;
  return (
    <tr>
      <td>{label}</td>
      <td>${fmtNum(d.median_abs, 0)}</td>
      <td>{d.pct_up}%</td>
      <td>{fmtNum(d.p10, 0)} to {fmtNum(d.p90, 0)}</td>
    </tr>
  );
}

function StatsTable({ title, block }: { title: string; block?: DistBlock }) {
  if (!block) return null;
  return (
    <div className="stats-block">
      <h4>{title}</h4>
      <table>
        <thead>
          <tr><th /><th title="Typical size of the move, up or down">typical move</th><th title="How often gold went up">went up</th><th title="8 out of 10 moves were inside this range (USD)">usual range</th></tr>
        </thead>
        <tbody>{HORIZONS.map(([k, l]) => <Row key={k} label={l} d={block[k]} />)}</tbody>
      </table>
    </div>
  );
}

type Lean = "down" | "up" | "either";
type Side = "higher" | "lower";

const ARROW: Record<Lean, string> = { up: "▲", down: "▼", either: "◆" };

function sideOf(e: CalendarEvent): Side | null {
  if (e.result_label === "higher than expected") return "higher";
  if (e.result_label === "lower than expected") return "lower";
  return null;
}

function publishedDir(e: CalendarEvent): "hi" | "lo" | "eq" | null {
  if (e.actual == null || e.forecast == null) return null;
  if (Math.abs(e.actual - e.forecast) < 1e-9) return "eq";
  return e.actual > e.forecast ? "hi" : "lo";
}

function sideDist(stats: EventStats | null, side: Side): Dist | null {
  if (!stats || stats.error) return null;
  const block = side === "higher" ? stats.beat_forecast : stats.missed_forecast;
  return block?.ret_1h ?? null;
}

function leanOfDist(d: Dist | null): Lean | null {
  if (!d || d.n < 3) return null;
  if (d.pct_up >= 65) return "up";
  if (d.pct_up <= 35) return "down";
  return "either";
}

const upsOf = (d: Dist) => Math.round((d.pct_up * d.n) / 100);

function scenarioText(d: Dist | null): string {
  if (!d || d.n === 0) return "No past cases yet.";
  if (d.n < 3) return `Only ${d.n} past case${d.n === 1 ? "" : "s"}, too few to call.`;
  const up = upsOf(d);
  const down = d.n - up;
  const typical = `typically about $${fmtNum(d.median_abs, 0)} within an hour`;
  const few = d.n < 6 ? " Few cases, so treat it lightly." : "";
  const lean = leanOfDist(d);
  if (lean === "down") return `Gold fell ${down} of ${d.n} times, ${typical}.${few}`;
  if (lean === "up") return `Gold rose ${up} of ${d.n} times, ${typical}.${few}`;
  return `Gold rose ${up} and fell ${down} of ${d.n} times. No clear lean.${few}`;
}

function rowLean(e: CalendarEvent, stats: EventStats | null, failed: boolean, past: boolean) {
  if (!past) return { lean: null, label: e.forecast_text ? "Waiting for the number" : "Scheduled", d: null };
  const side = sideOf(e);
  if (!side) {
    return { lean: null, label: e.result_label === "as expected" ? "Matched forecast" : "No forecast to compare", d: null };
  }
  if (!stats) return { lean: null, label: failed ? "No track record" : "Checking history...", d: null };
  const d = sideDist(stats, side);
  const lean = leanOfDist(d);
  if (!lean) return { lean: null, label: "Not enough history", d: d && d.n > 0 ? d : null };
  const label = lean === "up" ? "Gold usually rises" : lean === "down" ? "Gold usually falls" : "Mixed record";
  return { lean, label, d };
}

function Dots({ d }: { d: Dist }) {
  const shown = Math.min(d.n, 10);
  const up = Math.round((upsOf(d) * shown) / d.n);
  return (
    <span className="dots" title={`Up ${upsOf(d)} of ${d.n} times, down ${d.n - upsOf(d)} times, in the hour after`}>
      {Array.from({ length: shown }, (_, i) => <i key={i} className={i < up ? "up" : "down"} />)}
    </span>
  );
}

function SplitBar({ d }: { d: Dist }) {
  const up = Math.round(d.pct_up);
  return (
    <div className="split">
      <div className="split-bar">
        <span className="up" style={{ width: `${up}%` }} />
        <span className="down" style={{ width: `${100 - up}%` }} />
      </div>
      <div className="split-legend">
        <span className="tone-up">Up {up}%</span>
        <span className="tone-down">Down {100 - up}%</span>
      </div>
    </div>
  );
}

function MoveBars({ block }: { block: DistBlock }) {
  const rows = HORIZONS.map(([k, label]) => ({ label, v: block[k]?.median_abs ?? null }));
  const max = Math.max(...rows.map((r) => r.v ?? 0), 1);
  return (
    <div className="move-bars">
      {rows.map((r) => (
        <div key={r.label} className="move-bar">
          <span>{r.label}</span>
          <span className="track"><span style={{ width: `${((r.v ?? 0) / max) * 100}%` }} /></span>
          <b>{r.v == null ? "—" : `$${fmtNum(r.v, 0)}`}</b>
        </div>
      ))}
    </div>
  );
}

type Shared = { amount: string; up: boolean; count: number };

function ReleaseRow({ e, shared }: { e: CalendarEvent; shared: Shared | null }) {
  const [open, setOpen] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [stats, setStats] = useState<EventStats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancel = false;
    api.eventStats(e.event_id)
      .then((s) => { if (!cancel) setStats(s); })
      .catch(() => { if (!cancel) setFailed(true); });
    return () => { cancel = true; };
  }, [e.event_id]);

  const past = e.time_utc <= Date.now() / 1000;
  const side = sideOf(e);
  const printed = publishedDir(e);
  const summary = rowLean(e, stats, failed, past);
  const size = e.importance >= 3 ? "Big" : e.importance === 2 ? "Medium" : "Small";
  const all = stats && !stats.error ? stats.all : undefined;
  const allHour = all?.ret_1h ?? null;
  const noHistory = failed || !!stats?.error;

  return (
    <article className={`release size-${e.importance} ${open ? "open" : ""}`}>
      <button className="release-summary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="release-about">
          <span className={`release-mark imp${e.importance}`} title={`${size} news`} />
          <span className="release-name">{e.plain_name}</span>
          <span className={`imp imp${e.importance}`}>{size}</span>
          <span className="release-official">{e.name}</span>
        </span>
        <span className="release-explainer">{e.what_it_is ?? "Economic report or official announcement."}</span>
        <span className="release-number" title="What economists expected before publication">
          <small>Forecast</small><b>{e.forecast_text ?? "—"}</b>
        </span>
        <span className={`release-number print-${printed ?? "none"}`} title="The number that was published">
          <small>Published</small>
          <b>
            {e.actual_text ?? "—"}
            {printed === "hi" && <em>▲</em>}
            {printed === "lo" && <em>▼</em>}
          </b>
        </span>
        <span className="release-number" title="The previous release of this same report">
          <small>Previous</small><b>{e.previous_text ?? "—"}</b>
        </span>
        <span className={`release-lean ${summary.lean ?? "none"}`}>
          <span className="arrow">{summary.lean ? ARROW[summary.lean] : "·"}</span>
          <span className="label">{summary.label}</span>
          {summary.d && (
            <span className="cases">
              <Dots d={summary.d} />
              <small>{summary.d.n} cases</small>
            </span>
          )}
        </span>
        <span className="release-chevron" aria-hidden="true">{open ? "⌄" : "›"}</span>
      </button>

      {open && (
        <div className="release-detail">
          <section className="sec">
            <h4>The news</h4>
            <p>{e.what_it_is ?? `The report officially called ${e.name}.`}</p>
            {e.why_it_matters && <p>{e.why_it_matters}</p>}
            {(e.forecast_text || e.actual_text || e.previous_text) && (
              <div className="compare">
                <div><small>Forecast</small><b>{e.forecast_text ?? "—"}</b></div>
                <div className={`pub ${printed ?? ""}`}><small>Published</small><b>{e.actual_text ?? "—"}</b></div>
                <div><small>Previous</small><b>{e.previous_text ?? "—"}</b></div>
              </div>
            )}
            {e.result_text && <p>{e.result_text}</p>}
          </section>

          <section className="sec">
            <h4>What it may mean for gold</h4>
            {e.forecast != null ? (
              (["higher", "lower"] as Side[]).map((s) => {
                const d = sideDist(stats, s);
                const lean = leanOfDist(d);
                const dim = past && side !== null && side !== s;
                return (
                  <div key={s} className={`scenario ${lean ?? "none"} ${dim ? "dim" : ""} ${past && side === s ? "active" : ""}`}>
                    <span className="arrow">{lean ? ARROW[lean] : "·"}</span>
                    <div>
                      <b>If it comes in {s} than forecast</b>
                      {past && side === s && <em className="this-time">This time</em>}
                      <p>{stats || noHistory ? scenarioText(d) : "Checking history..."}</p>
                    </div>
                    {d && d.n > 0 && <Dots d={d} />}
                  </div>
                );
              })
            ) : (
              <p>
                There is no number to beat or miss, so there is no directional call.
                {allHour && ` Gold usually moves about $${fmtNum(allHour.median_abs, 0)} in the hour after.`}
              </p>
            )}
            {shared && (
              <div className={`happened ${shared.up ? "up" : "down"}`}>
                This time gold {shared.up ? "rose" : "fell"} <b>{shared.amount}</b> in the next hour
                {shared.count > 1 ? `, shared by all ${shared.count} reports released together.` : "."}
              </div>
            )}
            <p className="caveat">A historical tendency, not a promise.</p>
          </section>

          <section className="sec">
            <h4>Track record</h4>
            {allHour ? (
              <>
                <p>Over the last <b>{allHour.n}</b> releases, in the hour after, gold went:</p>
                <SplitBar d={allHour} />
                <p>Typical size of the move afterwards:</p>
                <MoveBars block={all!} />
                <button className="linkish" onClick={() => setShowTable((v) => !v)}>
                  {showTable ? "Hide the full table" : "Show the full table"}
                </button>
                {showTable && (
                  <div className="release-stats">
                    <StatsTable title="All past releases" block={stats?.all} />
                    <StatsTable title="Higher than forecast" block={stats?.beat_forecast} />
                    <StatsTable title="Lower than forecast" block={stats?.missed_forecast} />
                  </div>
                )}
              </>
            ) : (
              <p>{noHistory ? "No track record yet for this report." : "Loading..."}</p>
            )}
          </section>
        </div>
      )}
    </article>
  );
}

function useExplained(valueIds: number[]) {
  const [byId, setById] = useState<Record<number, CalendarEvent | "error">>({});
  const key = valueIds.join(",");
  useEffect(() => {
    let cancel = false;
    setById({});
    for (const id of valueIds) {
      api.explainEvent(id).then((event) => {
        if (!cancel) setById((m) => ({ ...m, [id]: event }));
      }).catch(() => {
        if (!cancel) setById((m) => ({ ...m, [id]: "error" }));
      });
    }
    return () => { cancel = true; };
  }, [key]);
  return byId;
}

function countdown(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export default function EventDetail({ valueIds, onClose }: { valueIds: number[]; onClose: () => void }) {
  const byId = useExplained(valueIds);

  const loaded = valueIds
    .map((id) => byId[id])
    .filter((e): e is CalendarEvent => !!e && e !== "error")
    .sort((a, b) => b.importance - a.importance || a.name.localeCompare(b.name));
  const pending = valueIds.some((id) => !byId[id]);
  const lead = loaded[0];
  const allTogether = !!lead && loaded.every((event) => event.time_utc === lead.time_utc);
  const move = allTogether && lead?.ret_1h != null ? lead.ret_1h : null;
  const shared: Shared | null = move == null ? null : { amount: `$${Math.abs(move).toFixed(2)}`, up: move >= 0, count: loaded.length };
  const total = loaded.length || valueIds.length;
  const countLabel = `${total} ${total === 1 ? "report" : "reports"}`;
  const wait = lead ? lead.time_utc - Date.now() / 1000 : 0;
  const upcoming = wait > 0;
  const subtitle = !lead
    ? "Loading reports..."
    : upcoming
      ? `${fmtTime(lead.time_utc)} · ${countLabel} ${allTogether ? "due together" : "due in this candle"} · in ${countdown(wait)}`
      : `${fmtTime(lead.time_utc, false)} · ${countLabel} ${allTogether ? "released together" : "in this candle"}`;

  if (!valueIds.length) return null;

  return (
    <section className="panel detail release-desk">
      <header className="desk-header">
        <div>
          <h2>Release desk</h2>
          <p>{subtitle}</p>
        </div>
        {shared && (
          <div className={`desk-move ${shared.up ? "up" : "down"}`}>
            <b>Gold {shared.up ? "+" : "-"}{shared.amount}</b>
            <small>in the next hour · shared reaction</small>
          </div>
        )}
        <button className="desk-close" onClick={onClose} title="Close">x</button>
      </header>
      {!lead && pending && <div className="desk-message">Loading...</div>}
      {!lead && !pending && <div className="desk-message">These releases could not be loaded.</div>}
      {lead && (
        <div className="desk-body">
          <div className="desk-columns" aria-hidden="true">
            <span>Report</span><span>What it measures</span><span>Forecast</span>
            <span>Published</span><span>Previous</span><span>Gold lean</span><span />
          </div>
          <div className="desk-releases">
            {loaded.map((e) => <ReleaseRow key={e.value_id} e={e} shared={shared} />)}
          </div>
          {pending && <div className="desk-message">Loading the other reports...</div>}
          {loaded.length > 1 && (
            <p className="desk-note">
              {allTogether && upcoming
                ? "These reports are due at the same moment, so gold will react to all of them at once."
                : allTogether
                ? "These reports arrived together, so the shared gold move cannot be assigned to one report alone."
                : "These reports fall inside the same chart candle but were not necessarily published at exactly the same time."}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

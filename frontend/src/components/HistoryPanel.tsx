import { useEffect, useState } from "react";
import { api, fmtNum, fmtTime, money, placedTitle, type ClosedTrade, type TradeHistory } from "../api";

const RANGES = [
  { id: "today", label: "Today", days: 0 },
  { id: "7", label: "7 days", days: 6 },
  { id: "30", label: "30 days", days: 29 },
] as const;

const REASON: Record<ClosedTrade["reason"], string> = {
  target: "Target",
  stop: "Stop",
  "stop out": "Stop out",
  closed: "Closed",
  "closed here": "Closed here",
};

function signed(n: number) {
  return n >= 0 ? `+${money(n)}` : `-${money(Math.abs(n))}`;
}

function held(open: number, close: number) {
  const s = Math.max(0, close - open);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.round((s % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

function dayKey(ts: number) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts: number) {
  const d = new Date(ts * 1000);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function groups(trades: ClosedTrade[]) {
  const out: { key: string; label: string; net: number; trades: ClosedTrade[] }[] = [];
  for (const t of trades) {
    const key = dayKey(t.close_utc);
    const last = out[out.length - 1];
    if (!last || last.key !== key) out.push({ key, label: dayLabel(t.close_utc), net: t.net, trades: [t] });
    else {
      last.net += t.net;
      last.trades.push(t);
    }
  }
  return out;
}

export default function HistoryPanel({ dayStart, selected, onPick }: { dayStart: number; selected: number | null; onPick: (trade: ClosedTrade | null) => void }) {
  const [range, setRange] = useState<(typeof RANGES)[number]["id"]>("today");
  const [data, setData] = useState<TradeHistory | null>(null);
  const [failed, setFailed] = useState(false);
  const from = dayStart - (RANGES.find((r) => r.id === range)?.days ?? 0) * 86400;

  useEffect(() => {
    let cancel = false;
    setData(null);
    setFailed(false);
    const load = () => {
      api.history(from).then((h) => {
        if (!cancel) { setData(h); setFailed(false); }
      }).catch(() => { if (!cancel) setFailed(true); });
    };
    load();
    const id = setInterval(load, 15000);
    return () => { cancel = true; clearInterval(id); };
  }, [from]);

  const decided = (data?.wins ?? 0) + (data?.losses ?? 0);
  const rate = decided ? `${Math.round(100 * (data?.wins ?? 0) / decided)}%` : "-";

  return (
    <div className="history">
      <div className="seg">
        {RANGES.map((r) => (
          <button key={r.id} type="button" className={r.id === range ? "active" : ""} onClick={() => setRange(r.id)}>{r.label}</button>
        ))}
      </div>
      {failed && <p className="empty">Could not load the trade history.</p>}
      {!failed && data == null && <p className="empty">Loading...</p>}
      {data && !data.connected && <p className="empty">MetaTrader 5 is not connected.</p>}
      {data?.connected && (
        <>
          <div className="book-stats">
            <div className={`stat ${data.net >= 0 ? "good" : "sell"}`}><small>Net</small><b>{data.count ? signed(data.net) : "-"}</b></div>
            <div className="stat buy"><small>Wins</small><b>{data.wins}</b></div>
            <div className="stat sell"><small>Losses</small><b>{data.losses}</b></div>
            <div className="stat price" title="Wins divided by wins and losses. Trades that finished flat are left out."><small>Win rate</small><b>{rate}</b></div>
            <div className="stat buy"><small>Best win</small><b>{data.best != null ? signed(data.best) : "-"}</b></div>
            <div className="stat sell"><small>Worst loss</small><b>{data.worst != null ? signed(data.worst) : "-"}</b></div>
            <div className="stat buy"><small>Avg win</small><b>{data.avg_win != null ? signed(data.avg_win) : "-"}</b></div>
            <div className="stat sell"><small>Avg loss</small><b>{data.avg_loss != null ? signed(data.avg_loss) : "-"}</b></div>
          </div>
          {!data.trades.length && <p className="empty">No closed trades in this period.</p>}
          {data.trades.length > 0 && (
            <div className="hist-list">
              {groups(data.trades).map((g) => (
                <section key={g.key}>
                  <div className="hist-day">
                    <span>{g.label} · {g.trades.length}</span>
                    <b className={g.net >= 0 ? "tone-up" : "tone-down"}>{signed(g.net)}</b>
                  </div>
                  <ul className="trades">
                    {g.trades.map((t) => {
                      const sell = t.side.startsWith("sell");
                      const extra = [
                        !t.symbol.startsWith("XAU") ? t.symbol : "",
                        t.closes > 1 ? `${t.closes} closes` : "",
                        t.costs !== 0 ? `costs ${signed(t.costs)}` : "",
                      ].filter(Boolean).join(" · ");
                      return (
                        <li
                          key={t.position}
                          className={`trade hist ${sell ? "sell" : "buy"}${selected === t.position ? " on" : ""}`}
                          title="Show this trade on the chart"
                          onClick={() => onPick(selected === t.position ? null : t)}
                        >
                          <span className="badge">{sell ? "SELL" : "BUY"}</span>
                          <span className="lots">{t.volume.toFixed(2)}</span>
                          <span className="hist-px">{fmtNum(t.open_price, 3)} <i>→</i> {fmtNum(t.close_price, 3)}</span>
                          <span className={`waiting reason-${t.reason.replace(/ /g, "-")}`}>{REASON[t.reason]}</span>
                          <span className={`hist-who who who-${t.source ?? "manual"}`} title={placedTitle(t.source, t.magic)}>{t.source_name ?? "Manual"}</span>
                          <span className="hist-when">{fmtTime(t.close_utc, false)} · {held(t.open_utc, t.close_utc)}</span>
                          <span className={`pl ${t.net >= 0 ? "tone-up" : "tone-down"}`}>{signed(t.net)}</span>
                          {extra && <span className="hist-extra">{extra}</span>}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
              {data.truncated && <p className="hist-span">Showing the latest {data.trades.length} of {data.count}.</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

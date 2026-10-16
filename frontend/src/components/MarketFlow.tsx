import { useEffect, useState } from "react";
import { api, fmtNum, fmtTime, type MarketFlow as Flow } from "../api";
import Pop, { Rows } from "./Pop";

function Split({ left, right, leftLabel, rightLabel }: { left: number; right: number; leftLabel: string; rightLabel: string }) {
  return (
    <span className="flow-split">
      <b className="tone-up">{leftLabel} {Math.round(left)}%</b>
      <span className="flow-bar"><i style={{ width: `${left}%` }} /></span>
      <b className="tone-down">{Math.round(right)}% {rightLabel}</b>
    </span>
  );
}

function pace(activity: number | null) {
  if (activity == null) return "";
  if (activity >= 1.5) return "busy";
  if (activity <= 0.6) return "quiet";
  return "normal";
}

function pressureRead(buy: number, mood: string) {
  const lean = Math.abs(buy - 50);
  if (lean < 6) return "Buyers and sellers are about even. Price is more likely to drift sideways than run.";
  const who = buy > 50 ? "Buyers" : "Sellers";
  const strong = lean >= 12 ? "clearly" : "slightly";
  const busy = mood === "busy" ? " Activity is high, so the push has weight behind it." : mood === "quiet" ? " Activity is low, so the push is light." : "";
  return `${who} are ${strong} in control of the last 5 minutes.${busy}`;
}

function crowdRead(long: number) {
  if (long >= 70) return "Most traders are long. Crowded longs often get shaken out, so watch for drops.";
  if (long <= 30) return "Most traders are short. Crowded shorts often get squeezed, so watch for spikes up.";
  if (long >= 58) return "The crowd leans long, but not to an extreme.";
  if (long <= 42) return "The crowd leans short, but not to an extreme.";
  return "The crowd is split. This says little about direction right now.";
}

export default function MarketFlow() {
  const [flow, setFlow] = useState<Flow | null>(null);

  useEffect(() => {
    let cancel = false;
    const load = () => api.marketFlow().then((f) => { if (!cancel) setFlow(f); }).catch(() => {});
    load();
    const id = setInterval(load, 5_000);
    return () => { cancel = true; clearInterval(id); };
  }, []);

  if (!flow || (!flow.ticks && !flow.retail)) return null;
  const { ticks, retail } = flow;
  const mood = pace(ticks?.activity ?? null);
  return (
    <div className="flow">
      {ticks && (
        <Pop
          className="flow-item"
          chip={<>
            <small>Pressure 5m</small>
            <Split left={ticks.buy_pct} right={100 - ticks.buy_pct} leftLabel="Buy" rightLabel="Sell" />
            {ticks.activity != null && <em className={`pace ${mood}`}>{mood} {ticks.activity.toFixed(1)}×</em>}
          </>}
        >
          <h5>Buy vs sell pressure</h5>
          <p className="pop-read">{pressureRead(ticks.buy_pct, mood)}</p>
          <Rows rows={[
            ["Price moved up", `${ticks.up} times`],
            ["Price moved down", `${ticks.down} times`],
            ["Net move", `${ticks.moved >= 0 ? "+" : "-"}$${fmtNum(Math.abs(ticks.moved), 2)}`],
            ["Ticks a minute now", fmtNum(ticks.per_min, 1)],
            ["Ticks a minute, last hour", fmtNum(ticks.typical_per_min, 1)],
          ]} />
          <p className="pop-note">
            Counted from every price tick in the last 5 minutes from MetaTrader 5. A tick up means buyers paid more; a tick down means sellers accepted less.
            Your broker shares price changes only, so this shows who is pushing, and the order sizes stay hidden.
          </p>
          <p className="pop-tip"><b>Tip</b> Strong pressure (60% or more one way) during a busy market often means a move is underway. Near 50% the price usually chops. Confirm it on the chart before acting.</p>
        </Pop>
      )}
      {retail && (
        <Pop
          className="flow-item"
          chip={<>
            <small>Traders</small>
            <Split left={retail.long_pct} right={retail.short_pct} leftLabel="Long" rightLabel="Short" />
          </>}
        >
          <h5>Retail traders on gold</h5>
          <p className="pop-read">{crowdRead(retail.long_pct)}</p>
          <Rows rows={Object.entries(retail.brokers).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, `${Math.round(v)}% long`])} />
          <p className="pop-note">
            Share of retail traders holding gold long (betting up) vs short (betting down), averaged by {retail.source} across {Object.keys(retail.brokers).length} brokers.
            {retail.formed_utc ? ` Updated ${fmtTime(retail.formed_utc, false)}.` : ""}
          </p>
          <p className="pop-tip"><b>Tip</b> The crowd is often wrong at extremes. Above 70% long, price tends to fall and shake them out. Above 70% short, it tends to rise. Treat it as a warning sign, and keep it out of the entry signal.</p>
        </Pop>
      )}
    </div>
  );
}

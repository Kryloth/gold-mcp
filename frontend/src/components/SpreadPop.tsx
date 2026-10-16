import { useEffect, useRef, useState } from "react";
import { fmtNum, money, type Tick } from "../api";
import Pop, { Rows } from "./Pop";

const KEEP = 600;

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export default function SpreadPop({ tick }: { tick: Tick }) {
  const seen = useRef<number[]>([]);
  const [usual, setUsual] = useState<number | null>(null);
  const spread = tick.ask - tick.bid;

  useEffect(() => {
    seen.current.push(spread);
    if (seen.current.length > KEEP) seen.current.shift();
    setUsual(median(seen.current));
  }, [tick, spread]);

  const ratio = usual ? spread / usual : 1;
  const state = ratio >= 2 ? "wide" : ratio >= 1.3 ? "wider" : "normal";

  return (
    <Pop
      className={`spread-pop ${state}`}
      chip={<><small>Spread</small><b>{fmtNum(spread, 3)}</b>{state !== "normal" && <em>{state}</em>}</>}
    >
      <h5>Spread</h5>
      <p className="pop-read">
        {state === "wide"
          ? "The spread is much wider than usual. Expect worse fills and targets that need extra room."
          : state === "wider"
            ? "The spread is a bit wider than usual."
            : "The spread is normal right now."}
      </p>
      <Rows rows={[
        ["Sell price (bid)", fmtNum(tick.bid, 3)],
        ["Buy price (ask)", fmtNum(tick.ask, 3)],
        ["Spread now", `$${fmtNum(spread, 3)}`],
        ["Usual since this page opened", usual != null ? `$${fmtNum(usual, 3)}` : "-"],
        ["Cost on 0.01 lot", money(spread)],
        ["Cost on 0.10 lot", money(spread * 10)],
      ]} />
      <p className="pop-note">
        The gap between the buy price and the sell price. Every trade starts this much in the loss.
        The chart draws the bid. A buy opens at the ask and closes at the bid. A sell opens at the bid and closes at the ask, so its target needs the ask to get there.
      </p>
      <p className="pop-tip">
        <b>Tip</b> On a sell, set the target at least one spread past the level you expect, because the candle can touch it while the ask is still short.
        The spread widens around big news and at the daily rollover (about 7 AM your time). Avoid opening trades then.
      </p>
    </Pop>
  );
}

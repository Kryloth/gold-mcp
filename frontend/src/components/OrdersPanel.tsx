import { useEffect, useState } from "react";
import { api, fmtNum, fmtTime, money, type AccountBook, type AccountSummary, type AccountTrade, type OrderPlan, type Tick } from "../api";
import { cash, marginTone } from "./AccountBar";

const OZ_PER_LOT = 100;
const MAX_ORDERS = 20;

function fixed(v: number, digits = 2) {
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function ago(ts: number) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function signed(n: number) {
  return n >= 0 ? `+${money(n)}` : `-${money(Math.abs(n))}`;
}

function label(side: string) {
  return side.replace(/(^|\s)\w/g, (c) => c.toUpperCase());
}

function Switch({ on, onToggle, what }: { on: boolean; onToggle: () => void; what: string }) {
  return (
    <button
      type="button"
      className={`switch${on ? " on" : ""}`}
      aria-pressed={on}
      title={on ? `Lock ${what}` : `Unlock ${what}`}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
    >
      <span className="switch-text">{on ? "Live" : "Locked"}</span>
      <i />
    </button>
  );
}

function Row({ t, tick, showSymbol, on, onSelect, canClose, onClosed }: {
  t: AccountTrade;
  tick: Tick | null;
  showSymbol: boolean;
  on: boolean;
  onSelect: () => void;
  canClose: boolean;
  onClosed: (message: string, failed: boolean) => void;
}) {
  const sell = t.side.startsWith("sell");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!confirm) return;
    const id = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(id);
  }, [confirm]);

  useEffect(() => {
    if (!canClose) setConfirm(false);
  }, [canClose]);

  const close = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canClose || busy) return;
    if (!confirm) { setConfirm(true); return; }
    setBusy(true);
    api.closeOrder(t.ticket).then((done) => {
      onClosed(done.kind === "order"
        ? `Cancelled ${label(t.side)} ${t.volume.toFixed(2)}.`
        : `Closed ${label(t.side)} ${t.volume.toFixed(2)} at ${fmtNum(done.price, 3)}.`, false);
    }).catch((err: Error) => onClosed(err.message, true)).finally(() => { setBusy(false); setConfirm(false); });
  };

  const reach = t.tp > 0 && t.potential && t.potential > 0 && t.profit != null
    ? Math.max(0, Math.min(1, t.profit / t.potential))
    : null;
  const live = tick && t.kind === "position";
  const closeAt = live ? (sell ? tick.ask : tick.bid) : null;
  const toTarget = closeAt != null && t.tp > 0 ? (sell ? closeAt - t.tp : t.tp - closeAt) : null;
  const toStop = closeAt != null && t.sl > 0 ? (sell ? t.sl - closeAt : closeAt - t.sl) : null;
  const perDollar = t.volume * OZ_PER_LOT;

  return (
    <li className={`trade ${sell ? "sell" : "buy"}${on ? " on" : ""}`} onClick={onSelect}>
      <div className="trade-top">
        <span className="badge">{sell ? "SELL" : "BUY"}</span>
        <span className="lots">{t.volume.toFixed(2)}</span>
        {t.kind === "order" && <span className="waiting">{label(t.side.replace(/^(buy|sell)\s*/, "")) || "Waiting"}</span>}
        {showSymbol && <span className="sym">{t.symbol}</span>}
        <span className={`pl ${t.profit == null ? "" : t.profit >= 0 ? "tone-up" : "tone-down"}`}>
          {t.profit != null ? signed(t.profit) : "-"}
        </span>
      </div>
      <div className="trade-path">
        <div>
          <small>{t.kind === "order" ? "Waits at" : "Entry"}</small>
          <b>{fmtNum(t.price, 3)}</b>
        </div>
        <span className="arrow">→</span>
        <div>
          <small>Target</small>
          <b>{t.tp > 0 ? fmtNum(t.tp, 3) : "None"}</b>
        </div>
        <div className="gain">
          <small>If stopped</small>
          {t.sl > 0 && t.risk != null
            ? <b className={t.risk < 0 ? "tone-down" : "tone-up"} title={t.risk < 0 ? "Estimated loss if the stop triggers. A fast market can fill it a little worse." : "This stop is past the entry, so it locks in a profit."}>{signed(t.risk)}</b>
            : <b className="tone-warn" title="No stop is set, so the loss has no limit.">No stop</b>}
        </div>
        <div className="gain">
          <small>If hit</small>
          <b className="tone-up">{t.potential != null ? signed(t.potential) : "-"}</b>
        </div>
      </div>
      {reach != null && (
        <div className="reach-row">
          <div className="reach"><span style={{ width: `${reach * 100}%` }} /></div>
          <span>{Math.round(reach * 100)}%</span>
        </div>
      )}
      <div className="trade-facts">
        {closeAt != null && <span><small>Closes at</small>{fmtNum(closeAt, 3)} <i>{sell ? "ask" : "bid"}</i></span>}
        {toTarget != null && (
          <span><small>To target</small>{toTarget <= 0 ? <b className="tone-up">reached</b> : `$${fmtNum(toTarget, 2)}`}</span>
        )}
        {toStop != null && (
          <span><small>To stop</small><b className={toStop <= 1 ? "tone-down" : ""}>{toStop <= 0 ? "reached" : `$${fmtNum(toStop, 2)}`}</b></span>
        )}
        <span><small>Per $1</small>{money(perDollar)}</span>
        {tick && <span><small>Spread cost</small>{money((tick.ask - tick.bid) * perDollar)}</span>}
      </div>
      <div className="trade-foot">
        <span>
          {t.time_utc > 0 && <>{fmtTime(t.time_utc, false)} · {ago(t.time_utc)}</>}
          {" · "}{t.sl > 0 ? `Stop ${fmtNum(t.sl, 3)}` : "No stop"}
          {t.swap !== 0 && <> · Swap {signed(t.swap)}</>}
        </span>
        <button
          type="button"
          className={`close${confirm ? " confirm" : ""}`}
          disabled={!canClose || busy}
          title={canClose ? undefined : "Unlock the list to close orders"}
          onClick={close}
        >
          {busy ? "…" : confirm ? "Confirm?" : t.kind === "order" ? "Cancel" : "Close"}
        </button>
      </div>
    </li>
  );
}

function OrderTicket({ tick, onPlaced }: { tick: Tick | null; onPlaced: () => void }) {
  const [side, setSide] = useState<"buy" | "sell">("sell");
  const [lots, setLots] = useState("0.01");
  const [profit, setProfit] = useState("1");
  const [plan, setPlan] = useState<OrderPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [armed, setArmed] = useState(false);
  const [pick, setPick] = useState<number | "any">(1);
  const [progress, setProgress] = useState<string | null>(null);
  const [anyCount, setAnyCount] = useState("5");

  const volume = Number(lots);
  const target = Number(profit);
  const count = pick === "any" ? Math.floor(Number(anyCount)) : pick;
  const countOk = Number.isFinite(count) && count >= 1 && count <= MAX_ORDERS;
  const ready = Number.isFinite(volume) && volume > 0 && Number.isFinite(target) && target > 0 && countOk;

  useEffect(() => {
    if (!armed || !ready) {
      setPlan(null);
      return;
    }
    let cancel = false;
    const id = setTimeout(() => {
      api.planOrder(side, volume, target).then((next) => {
        if (!cancel) { setPlan(next); setFailed(false); setNote(null); }
      }).catch((err: Error) => {
        if (!cancel) { setPlan(null); setFailed(true); setNote(err.message); }
      });
    }, 350);
    return () => { cancel = true; clearTimeout(id); };
  }, [armed, side, volume, target, ready]);

  const place = async () => {
    if (!armed || !ready || busy) return;
    const want = count;
    setPick(1);
    setBusy(true);
    setNote(null);
    const filled: OrderPlan[] = [];
    let error: string | null = null;
    for (let k = 0; k < want; k++) {
      setProgress(`${k + 1} of ${want}`);
      try {
        filled.push(await api.placeOrder(side, volume, target));
      } catch (err) {
        error = (err as Error).message;
        break;
      }
    }
    setProgress(null);
    setBusy(false);
    if (filled.length) onPlaced();
    const last = filled[filled.length - 1];
    const each = last ? `${label(last.side)} ${last.volume.toFixed(2)}` : label(side);
    if (filled.length === 1 && !error) {
      setFailed(false);
      setNote(`${each} filled at ${fmtNum(last.price, 3)}. Target ${fmtNum(last.tp, 3)} · ${signed(last.profit)} if hit.`);
    } else if (!error) {
      setFailed(false);
      const total = filled.reduce((s, p) => s + p.profit, 0);
      setNote(`${filled.length} × ${each} filled, from ${fmtNum(filled[0].price, 3)} to ${fmtNum(last.price, 3)}. ${signed(total)} if every target is hit.`);
    } else {
      setFailed(true);
      setNote(filled.length ? `${filled.length} of ${want} filled, then stopped: ${error}` : error);
    }
  };

  return (
    <form className={`ticket ${side}${armed ? "" : " locked"}`} onSubmit={(e) => { e.preventDefault(); place(); }}>
      <div className="card-head">
        <span>New order</span>
        <Switch on={armed} onToggle={() => setArmed((v) => !v)} what="new orders" />
      </div>
      <div className="seg-side">
        <button type="button" className={side === "sell" ? "on" : ""} data-side="sell" disabled={!armed} onClick={() => setSide("sell")}>Sell</button>
        <button type="button" className={side === "buy" ? "on" : ""} data-side="buy" disabled={!armed} onClick={() => setSide("buy")}>Buy</button>
      </div>
      <div className="fields">
        <label>
          <small>Lots</small>
          <div className="input"><input value={lots} inputMode="decimal" disabled={!armed} onChange={(e) => setLots(e.target.value)} /><em>lot</em></div>
        </label>
        <label>
          <small>Profit at target</small>
          <div className="input"><em>$</em><input value={profit} inputMode="decimal" placeholder="1" disabled={!armed} onChange={(e) => setProfit(e.target.value)} /></div>
        </label>
      </div>
      <div className="count-pick">
        <small>Orders</small>
        <div className="count-opts" role="radiogroup" aria-label="How many orders">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={pick === n} className={pick === n ? "on" : ""} disabled={!armed} onClick={() => setPick(n)}>{n}</button>
          ))}
          <div className={`any${pick === "any" ? " on" : ""}`}>
            <button type="button" role="radio" aria-checked={pick === "any"} disabled={!armed} onClick={() => setPick("any")}>Any</button>
            {pick === "any" && (
              <input
                value={anyCount}
                inputMode="numeric"
                aria-label="Number of orders"
                disabled={!armed}
                autoFocus
                onChange={(e) => setAnyCount(e.target.value.replace(/\D/g, ""))}
              />
            )}
          </div>
        </div>
      </div>
      <div className="summary">
        <div><small>Entry now</small><b>{plan ? fmtNum(plan.price, 3) : "-"}</b></div>
        <div><small>Target</small><b>{plan ? fmtNum(plan.tp, 3) : "-"}</b></div>
        <div><small>Distance</small><b>{plan ? `$${fmtNum(Math.abs(plan.tp - plan.price), 3)}` : "-"}</b></div>
        <div><small>Spread cost</small><b>{tick && ready ? money((tick.ask - tick.bid) * volume * OZ_PER_LOT * count) : "-"}</b></div>
      </div>
      <button type="submit" className="go" disabled={!armed || !ready || !plan || busy}>
        {!armed
          ? "Locked"
          : busy
            ? `Sending ${progress ?? "…"}`
            : !countOk
              ? `Choose 1 to ${MAX_ORDERS} orders`
              : count > 1
                ? `${label(side)} ${count} × ${plan ? plan.volume.toFixed(2) : lots} for ${plan ? signed(plan.profit * count) : "…"}`
                : `${label(side)} ${plan ? plan.volume.toFixed(2) : lots} for ${plan ? signed(plan.profit) : "…"}`}
      </button>
      <div className={`note${failed ? " bad" : ""}`}>
        {note ?? (!armed ? "Turn the switch on to place orders." : plan ? "Fills at the market price. The target is set from the fill. No stop." : "Enter lots and the profit you want at the target.")}
      </div>
    </form>
  );
}

function AccountStats({ acct }: { acct: AccountSummary }) {
  const cur = acct.currency;
  const risk = marginTone(acct.margin_level);
  const level = risk === "tone-down" ? "sell" : risk === "tone-warn" ? "cost" : "good";
  const below = (acct.equity ?? 0) - (acct.balance ?? 0);
  return (
    <>
      <div className={`stat ${below < 0 ? "sell" : "price"}`}><small>Equity</small><b>{cash(acct.equity, cur)}</b></div>
      <div className={`stat ${level}`}><small>Free margin</small><b>{cash(acct.margin_free, cur)}</b></div>
      <div className={`stat ${acct.margin_level == null ? "dim" : level}`}>
        <small>Margin level</small>
        <b>{acct.margin_level != null ? `${fmtNum(acct.margin_level, 0)}%` : "-"}</b>
      </div>
      <div className="stat dim"><small>Used margin</small><b>{cash(acct.margin_used, cur)}</b></div>
    </>
  );
}

function BookStats({ positions, tick, acct }: { positions: AccountTrade[]; tick: Tick | null; acct: AccountSummary | null }) {
  const sells = positions.filter((t) => t.side.startsWith("sell"));
  const buys = positions.filter((t) => t.side.startsWith("buy"));
  const lots = (list: AccountTrade[]) => list.reduce((s, t) => s + t.volume, 0);
  const net = lots(buys) - lots(sells);
  const perDollar = Math.abs(net) * OZ_PER_LOT;
  const total = lots(positions);
  const spread = tick ? tick.ask - tick.bid : null;
  const targets = positions.filter((t) => t.potential != null);
  const allHit = targets.reduce((s, t) => s + (t.potential ?? 0), 0);
  const stopped = positions.filter((t) => t.sl > 0 && t.risk != null);
  const allStopped = stopped.reduce((s, t) => s + (t.risk ?? 0), 0);
  const unstopped = positions.length - stopped.length;
  const flat = Math.abs(net) < 1e-9;
  return (
    <div className="book-stats">
      {acct?.connected && <AccountStats acct={acct} />}
      <div className={`stat ${sells.length ? "sell" : "dim"}`}><small>Sells</small><b>{sells.length} · {lots(sells).toFixed(2)} lot</b></div>
      <div className={`stat ${buys.length ? "buy" : "dim"}`}><small>Buys</small><b>{buys.length} · {lots(buys).toFixed(2)} lot</b></div>
      <div className={`stat ${flat ? "dim" : net > 0 ? "buy" : "sell"}`}>
        <small>Net</small>
        <b>{flat ? "Flat" : `${Math.abs(net).toFixed(2)} lot ${net > 0 ? "long" : "short"}`}</b>
      </div>
      <div className={`stat ${flat ? "dim" : "good"}`}>
        <small>Per $1 {flat ? "move" : net > 0 ? "up" : "down"}</small>
        <b>{flat ? money(0) : `+${money(perDollar)}`}</b>
      </div>
      <div className="stat cost">
        <small>Spread</small>
        <b>{spread != null ? `$${fmtNum(spread, 3)}` : "-"}</b>
      </div>
      <div className="stat cost">
        <small>Spread total</small>
        <b>{spread != null ? `-${money(spread * total * OZ_PER_LOT)}` : "-"}</b>
      </div>
      {tick && (
        <div className="stat price wide">
          <small>Bid / Ask</small>
          <b><span className="bid">{fixed(tick.bid)}</span> <i>/</i> <span className="ask">{fixed(tick.ask)}</span></b>
        </div>
      )}
      {targets.length > 0 && (
        <div className="stat good half"><small>All targets hit</small><b>{signed(allHit)}</b></div>
      )}
      {positions.length > 0 && (
        <div className={`stat ${stopped.length ? (allStopped < 0 ? "sell" : "good") : "cost"} half`}>
          <small>All stops hit</small>
          <b>
            {stopped.length ? signed(allStopped) : "No stops set"}
            {stopped.length > 0 && unstopped > 0 && <span className="stat-extra"> · {unstopped} with no stop</span>}
          </b>
        </div>
      )}
    </div>
  );
}

function CloseAll({ trades, floating, canClose, onDone }: {
  trades: AccountTrade[];
  floating: number;
  canClose: boolean;
  onDone: (message: string, failed: boolean) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => {
    if (!confirm) return;
    const id = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(id);
  }, [confirm]);

  useEffect(() => {
    if (!canClose) setConfirm(false);
  }, [canClose]);

  const run = async () => {
    if (!canClose || progress || !trades.length) return;
    if (!confirm) { setConfirm(true); return; }
    setConfirm(false);
    let closed = 0;
    const errors: string[] = [];
    for (let k = 0; k < trades.length; k++) {
      setProgress(`${k + 1} of ${trades.length}`);
      try {
        await api.closeOrder(trades[k].ticket);
        closed++;
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    setProgress(null);
    if (!errors.length) onDone(`Closed all ${closed}.`, false);
    else onDone(`Closed ${closed} of ${trades.length}. ${errors[0]}`, true);
  };

  const n = trades.length;
  return (
    <button
      type="button"
      className={`close-all${confirm ? " confirm" : ""}`}
      disabled={!canClose || !n || !!progress}
      title={canClose ? (confirm ? `Click again to close ${n} at ${signed(floating)}` : undefined) : "Unlock the list to close orders"}
      onClick={run}
    >
      {progress ? progress.replace(" of ", "/") : confirm ? "Confirm?" : `Close all ${n}`}
    </button>
  );
}

export default function OrdersPanel({ book, tick, acct, selected, onSelect, onPlaced }: { book: AccountBook | null; tick: Tick | null; acct: AccountSummary | null; selected: number | null; onSelect: (ticket: number) => void; onPlaced: () => void }) {
  const [canClose, setCanClose] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad: boolean } | null>(null);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(id);
  }, [notice]);

  if (!book) return <div className="empty">Reading orders from MetaTrader 5…</div>;
  if (!book.connected) return <div className="empty">MetaTrader 5 is not connected, so orders cannot be read.</div>;
  const { positions, orders } = book;
  const floating = positions.reduce((sum, p) => sum + (p.profit ?? 0) + p.swap, 0);
  const showSymbol = [...positions, ...orders].some((t) => t.symbol !== book.symbol);
  const onClosed = (text: string, bad: boolean) => {
    setNotice({ text, bad });
    if (!bad) onPlaced();
  };
  const row = (t: AccountTrade, key: string) => (
    <Row key={key} t={t} tick={t.symbol === book.symbol ? tick : null} showSymbol={showSymbol} on={t.ticket === selected} onSelect={() => onSelect(t.ticket)} canClose={canClose} onClosed={onClosed} />
  );
  return (
    <div className="orders">
      <OrderTicket tick={tick} onPlaced={onPlaced} />
      <div className={`book-head${canClose ? "" : " locked"}`}>
        <div>
          <span className="count">{positions.length} open{orders.length > 0 && <> · {orders.length} waiting</>}</span>
          {positions.length > 0 && <span className={`float ${floating >= 0 ? "tone-up" : "tone-down"}`}>{signed(floating)}</span>}
        </div>
        <CloseAll trades={[...positions, ...orders]} floating={floating} canClose={canClose} onDone={onClosed} />
        <div className="book-actions">
          <Switch on={canClose} onToggle={() => setCanClose((v) => !v)} what="closing" />
        </div>
      </div>
      {(positions.length > 0 || acct?.connected) && <BookStats positions={positions.filter((t) => t.symbol === book.symbol)} tick={tick} acct={acct} />}
      {notice && <div className={`book-note${notice.bad ? " bad" : ""}`}>{notice.text}</div>}
      <ul className="trades">
        {positions.length === 0 && orders.length === 0 && <li className="empty">No open orders on this account.</li>}
        {positions.map((t) => row(t, `p${t.ticket}`))}
        {orders.map((t) => row(t, `o${t.ticket}`))}
      </ul>
    </div>
  );
}

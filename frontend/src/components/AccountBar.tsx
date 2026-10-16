import { useEffect, useState } from "react";
import { api, fmtNum, type AccountBook, type AccountSummary } from "../api";
import Pop, { Rows } from "./Pop";

function cash(v: number | undefined, currency = "USD") {
  if (v == null) return "-";
  const sign = v < 0 ? "-" : "";
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${sign}${symbol}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedCash(v: number | undefined, currency?: string) {
  if (v == null) return "-";
  return v >= 0 ? `+${cash(v, currency)}` : cash(v, currency);
}

function tone(v: number | undefined | null) {
  return v == null || v === 0 ? "" : v > 0 ? "tone-up" : "tone-down";
}

export function useAccount(dayStart: number) {
  const [acct, setAcct] = useState<AccountSummary | null>(null);
  useEffect(() => {
    let cancel = false;
    const load = () => api.account(dayStart).then((a) => { if (!cancel) setAcct(a); }).catch(() => {});
    load();
    const id = setInterval(load, 5_000);
    return () => { cancel = true; clearInterval(id); };
  }, [dayStart]);
  return acct;
}

export function marginTone(level: number | null | undefined) {
  if (level == null) return "";
  if (level < 150) return "tone-down";
  if (level < 300) return "tone-warn";
  return "";
}

export { cash };

function stopText(acct: AccountSummary) {
  if (!acct.stop_mode_pct || acct.margin_call == null || acct.stop_out == null) {
    return "If the margin level falls to your broker's stop-out level, it starts closing trades automatically.";
  }
  const out = acct.stop_out > 0
    ? `at ${fmtNum(acct.stop_out, 0)}% it starts closing your trades automatically`
    : "at 0% it closes your trades automatically, which means equity is used up";
  return `Your broker warns at ${fmtNum(acct.margin_call, 0)}% margin level (margin call), and ${out}.`;
}

export default function AccountBar({ acct, book, onShowOrders }: { acct: AccountSummary | null; book: AccountBook | null; onShowOrders: () => void }) {
  if (!acct?.connected) return null;
  const cur = acct.currency;
  const positions = book?.connected ? book.positions : [];
  const pending = book?.connected ? book.orders : [];
  const sells = positions.filter((t) => t.side.startsWith("sell"));
  const buys = positions.filter((t) => t.side.startsWith("buy"));
  const lots = (list: typeof positions) => list.reduce((s, t) => s + t.volume, 0).toFixed(2);
  const pct = acct.today_pct;

  return (
    <div className="acct">
      <Pop
        chip={<><small>Balance</small><b>{cash(acct.balance, cur)}</b></>}
      >
        <h5>Account</h5>
        <Rows rows={[
          ["Balance", cash(acct.balance, cur)],
          ["Equity", cash(acct.equity, cur)],
          ["Open trades", <span className={tone(acct.floating)}>{signedCash(acct.floating, cur)}</span>],
          ["Free margin", cash(acct.margin_free, cur)],
          ["Margin level", acct.margin_level != null ? `${fmtNum(acct.margin_level, 0)}%` : "No trades open"],
        ]} />
        <p className="pop-note">Balance is the cash in the account from closed trades. Equity is the balance plus whatever your open trades are worth right now.</p>
        <p className="pop-tip"><b>Tip</b> Watch equity more than balance while trades are open. {stopText(acct)}</p>
      </Pop>
      <Pop
        chip={<><small>Equity</small><b className={tone((acct.equity ?? 0) - (acct.balance ?? 0))}>{cash(acct.equity, cur)}</b></>}
      >
        <h5>Equity</h5>
        <Rows rows={[
          ["Balance", cash(acct.balance, cur)],
          ["Open trades", <span className={tone(acct.floating)}>{signedCash(acct.floating, cur)}</span>],
          ["Equity", cash(acct.equity, cur)],
        ]} />
        <p className="pop-note">Equity is what the account is worth if you closed every trade right now: balance plus the open trades. It turns red while open trades are losing.</p>
        <p className="pop-tip"><b>Tip</b> Equity is the number that matters for margin. A big gap below balance means your open trades carry real risk.</p>
      </Pop>
      <Pop
        chip={<>
          <small>Free margin</small>
          <b className={marginTone(acct.margin_level)}>{cash(acct.margin_free, cur)}</b>
          {acct.margin_level != null && <em className={marginTone(acct.margin_level)}>{fmtNum(acct.margin_level, 0)}%</em>}
        </>}
      >
        <h5>Free margin</h5>
        <Rows rows={[
          ["Equity", cash(acct.equity, cur)],
          ["Used margin", cash(acct.margin_used, cur)],
          ["Free margin", cash(acct.margin_free, cur)],
          ["Margin level", acct.margin_level != null ? `${fmtNum(acct.margin_level, 0)}%` : "No trades open"],
          ...(acct.stop_mode_pct && acct.margin_call != null ? [["Broker margin call", `${fmtNum(acct.margin_call, 0)}%`] as [string, string]] : []),
          ...(acct.stop_mode_pct && acct.stop_out != null ? [["Broker stop out", `${fmtNum(acct.stop_out, 0)}%`] as [string, string]] : []),
        ]} />
        <p className="pop-note">
          Free margin is the money still available to open new trades. Margin level is equity divided by the margin your trades use.
          Here it turns amber below 300% and red below 150% as an early warning.
        </p>
        <p className="pop-tip"><b>Tip</b> {stopText(acct)} Keep free margin comfortable so one bad move can't force a close.</p>
      </Pop>
      <Pop
        chip={<>
          <small>Today P/L</small>
          <b className={tone(acct.today)}>{signedCash(acct.today, cur)}</b>
          {pct != null && <em className={tone(pct)}>{pct >= 0 ? "+" : ""}{fmtNum(pct, 2)}%</em>}
        </>}
      >
        <h5>Today since midnight</h5>
        <Rows rows={[
          ["Closed trades", <span className={tone(acct.realized_today)}>{signedCash(acct.realized_today, cur)}</span>],
          ["Open trades since midnight", <span className={tone((acct.floating ?? 0) - (acct.floating_at_start ?? 0))}>{signedCash((acct.floating ?? 0) - (acct.floating_at_start ?? 0), cur)}</span>],
          ["Total today", <span className={tone(acct.today)}>{signedCash(acct.today, cur)}</span>],
          ["Account at midnight", cash(acct.start_equity, cur)],
          ...((acct.moved_cash_today ?? 0) !== 0 ? [["Deposits / withdrawals", signedCash(acct.moved_cash_today, cur)] as [string, string]] : []),
        ]} />
        <p className="pop-note">
          How much the account value changed since your local midnight. Closed trades count in full. Trades still open count only the part they moved today.
          Deposits and withdrawals stay out. The percent is against the account value at midnight.
        </p>
        <p className="pop-tip"><b>Tip</b> Set a daily loss limit, for example 2% to 3%. When Today reaches it, stop for the day.</p>
      </Pop>
      <Pop
        chip={<>
          <small>Open</small>
          <b>{positions.length}</b>
          {positions.length > 0 && <em className={tone(acct.floating)}>{signedCash(acct.floating, cur)}</em>}
        </>}
      >
        <h5>Open trades</h5>
        <Rows rows={[
          ["Sells", `${sells.length} · ${lots(sells)} lots`],
          ["Buys", `${buys.length} · ${lots(buys)} lots`],
          ["Waiting orders", String(pending.length)],
          ["Worth now", <span className={tone(acct.floating)}>{signedCash(acct.floating, cur)}</span>],
        ]} />
        <p className="pop-tip"><b>Tip</b> Positions on the same side add up. Five 0.10 sells move like one 0.50 sell, so size each new trade with the total in mind.</p>
        <button type="button" className="pop-link" onClick={onShowOrders}>Show in Orders</button>
      </Pop>
    </div>
  );
}

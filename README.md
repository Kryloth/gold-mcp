# gold-mcp

Local XAUUSD monitor and MCP server backed by MetaTrader 5.

- **Chart app**: live candles (M1 to D1) from your MT5 terminal, with economic news marked on the chart. Written for beginners. The sidebar has six tabs:
  - *Orders*: the open book on the logged-in account, plus a ticket that sends a market order and sets the target from the filled price. Close one trade or all of them. A lock makes the close buttons unclickable.
  - *History*: closed trades for today, 7 days, or 30 days, with net, win rate, best win, worst loss, and average win and loss. Click a row to show that close on the chart.
  - *Outlook*: where gold will likely be in 1, 4, or 12 hours, in plain sentences with a range bar.
  - *Daily summary*: per day, what gold did, which news moved it and by how much, and what headlines were about.
  - *Coming up*: scheduled news with countdowns and how much each usually moves gold.
  - *All news*: every report and headline, filterable and synced to the chart.

  The top bar shows the account (balance, equity, free margin, today's result), the spread, tick pressure, and retail positioning. London and New York are shaded on the chart. Clicking a marked candle explains the news: what it is, why it matters for gold, what happened this time, and what usually happens. Summaries are generated from the data by rules (no AI key needed).
- **MCP server**: gives an AI (Cursor, Claude Desktop, and others) price history, news history, upcoming events, per-event gold reaction statistics, and a baseline swing estimate, so it can reason about short-term moves.

```
MT5 terminal --(MetaTrader5 Python API)--> collector --> data/gold.db <-- MCP server (stdio)
MT5 service GoldCalendarExport --> Common\Files\gold_calendar.json --> collector
RSS / GDELT headlines --> collector
data/gold.db --> FastAPI (:8000) --> browser
```

Only the collector talks to MT5. The MCP server reads the database, so it keeps working on the last synced data when MT5 or the web app is closed.

The Orders tab sends real orders on the account that is logged in to MT5. Closing the app does not close those trades.

## One-time setup

1. **Python** (3.11+):

   ```powershell
   cd backend
   python -m venv .venv
   .\.venv\Scripts\pip install -e .
   ```

2. **Frontend** (Node 20+):

   ```powershell
   cd frontend
   npm install
   ```

   `start.bat` runs `npm install` and `npm run build` the first time if these are missing.

3. **MT5 history depth** (recommended): *Tools > Options > Charts > Max bars in chart = Unlimited*, then restart MT5. With the default 100,000 bars, M1 history covers only about 70 days. After raising it, stop the API and re-run the backfill once (Ctrl+C when it reports the backfill finished):

   ```powershell
   cd backend
   .\.venv\Scripts\python -m goldcore.collector --rebackfill
   ```

4. **Placing orders**: in MT5, turn on *Algo Trading*. The app attaches to the terminal that is already open. It does not ask for the account password.

5. **MCP in Cursor**: add this to `%USERPROFILE%\.cursor\mcp.json`, with the path to your clone:

   ```json
   "gold-mcp": {
     "command": "C:\\path\\to\\gold-mcp\\backend\\.venv\\Scripts\\python.exe",
     "args": ["C:\\path\\to\\gold-mcp\\backend\\mcp_server\\server.py"]
   }
   ```

   The same command and args work for Claude Desktop's `claude_desktop_config.json`.

The default symbol is `XAUUSD247m`. Set `GOLD_SYMBOL` to your broker's gold symbol before starting the API if it differs.

## Running

**Double-click `start.bat`** in this folder. It installs the economic calendar into MetaTrader, starts the API, builds the page if needed, and opens http://127.0.0.1:8000.

The calendar is the same MetaTrader list as before: about 2 years of past releases and 14 days ahead, for the US dollar, euro, yuan, pound, and yen, rewritten every 5 minutes. You do not copy the file or click **Add service**. MetaTrader only reads that list when it opens. The first time, if MetaTrader is already open, close it, double-click `start.bat`, then open MetaTrader again. After that the calendar starts with MetaTrader. Keep MetaTrader open and logged in whenever you use the app.

Two windows appear:

- The start window closes itself after a few seconds.
- The **Gold monitor** window keeps the app running. Press Ctrl+C in that window to stop it.

**Double-click `stop.bat`** to quit without finding that window. Either way, trades stay open in MetaTrader.

If the app is already running, `start.bat` only opens the page.

To run it by hand instead:

```powershell
# Terminal 1: API and collectors (MT5 sync every 60 s, calendar every 5 min, headlines every 15 min)
cd backend
.\.venv\Scripts\python -m uvicorn api.main:app --host 127.0.0.1 --port 8000

# Terminal 2, only while changing the page: chart app at http://localhost:5173
cd frontend
npm run dev
```

After `npm run build`, the API serves the built app at http://127.0.0.1:8000, so only Terminal 1 is needed. That is what `start.bat` does.

To keep the database fresh for the MCP without the web app, run only the collectors:
`.\.venv\Scripts\python -m goldcore.collector` from `backend`.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `build_prediction_context(horizon_hours)` | One-call bundle: snapshot, recent candles, last 24h news, upcoming events with reactions, volatility, baseline estimate |
| `get_market_snapshot()` | Price, changes, ATR(14), 24h/7d ranges, EMA trend, data freshness |
| `get_price_history(timeframe, start, end, limit)` | OHLC candles (compact rows) |
| `get_news_history(start, end, min_importance, include_headlines, search)` | Past releases with measured gold reaction, and headlines |
| `get_upcoming_events(hours_ahead, min_importance, usd_only)` | Scheduled events with forecasts and historical gold reaction |
| `get_event_reaction_stats(event, surprise_sign)` | Gold move distribution 5m/15m/1h/4h after an event, split by beat/miss |
| `get_news_digest(days, utc_offset_minutes)` | Plain-English daily summaries: price move, key releases and their impact, headline topics |
| `get_volatility_profile(days)` | Typical H1 range by UTC hour and weekday |
| `estimate_swing_range(horizon_hours)` | Empirical range/band for the horizon, widened for scheduled events |

Prompt: `short_term_gold_outlook(horizon_hours)` walks the AI through the analysis.

Test without an AI client: `.\.venv\Scripts\python -m mcp_server.smoke_test` from `backend`.

## Notes and limits

- All stored times are UTC (the MT5 server offset is detected and removed). The chart displays local time.
- `XAUUSD247m` trades 24/7 with much lower weekend volatility; the swing estimate compares weekdays with weekdays and weekends with weekends.
- On this broker the symbol's history starts in December 2025, and M1 history is limited by *Max bars*. Event reactions fall back to M5 bars when M1 is not available.
- Several releases often share a timestamp (for example Retail Sales and PPI at 12:30 UTC), so their per-event reaction stats include each other's impact. Sample sizes are small (about 10-20 per monthly event); check `n`.
- Headlines: RSS (FXStreet, Investing.com, Mining.com) builds history from first run onward. GDELT is polled as a best-effort extra source; it rate-limits aggressively and may return nothing. Headline `tone` is a crude keyword score.
- A target is set from the filled price, not the quote you clicked. Buys fill at the ask and close at the bid; sells do the opposite. Candles are drawn from the bid, so a buy sits above the candle by about the spread.
- A stop is an estimate. In a fast move the fill can be worse than the stop price.
- The MCP supplies data and statistics; it does not make guaranteed predictions. Not financial advice.

## Layout

```
start.bat             start the app and open it in the browser
stop.bat              stop the app; trades in MT5 stay open
backend/goldcore/     config, SQLite schema, MT5 feed, calendar ingest, headlines, analytics, collector loops
backend/api/          FastAPI app (REST + /ws/ticks) that also runs the collectors
backend/mcp_server/   MCP server (stdio) and smoke test
mql5/                 GoldCalendarExport service source
frontend/             Vite + React + lightweight-charts app
data/gold.db          SQLite database (created on first run, not committed)
```

# gold-mcp

A local gold (XAUUSD) monitor for MetaTrader 5, plus an MCP server that lets an AI read the same prices and news.

Everything runs on your own PC. The app reads live prices, your account, and the economic calendar from the MetaTrader terminal you already have open, and shows them in your browser.

> **Real money.** The Orders tab sends real orders on whichever account is logged in to MetaTrader. Closing the app does not close those trades. Nothing here is financial advice.

## What it does

**Chart**: live candles from 1 minute to 1 day, drawn from your broker's prices. News releases are marked on the candles. Click a marked candle to see what the release was, why it matters for gold, what happened this time, and what usually happens. London and New York trading hours are shaded, and a dotted line shows the buy price (ask).

**Top bar**: balance, equity, free margin, today's result in dollars and percent, open trades, the spread, short-term buy and sell pressure, and how retail traders are positioned. Click any item for an explanation.

**Sidebar tabs**:

- **Orders**: your open trades, with entry, target, the profit if the target is hit, and the estimated loss if the stop is hit. A ticket places 1 to 20 market orders at once, with the target worked out from the price you actually got. Close one trade or all of them. A lock switch disables the close buttons.
- **History**: closed trades for today, 7 days, or 30 days, with net result, win rate, best win, worst loss, and average win and loss. Click a row to jump the chart to that close.
- **Outlook**: where gold is likely to be in 1, 4, or 12 hours, in plain sentences with a range bar.
- **Daily summary**: what gold did each day and which news moved it.
- **Coming up**: scheduled news with countdowns and how much each release usually moves gold.
- **All news**: every release and headline, searchable and synced to the chart.

All explanations are written by rules from the data. No AI key is needed for the app.

**MCP server**: gives an AI client such as Cursor or Claude Desktop the price history, news history, upcoming events, how gold reacted to past releases, and a baseline range estimate.

## Setup

Do these once, before you start the app.

1. **Install MetaTrader 5** and log in to your broker account.
2. **Turn on Algo Trading** in the MetaTrader toolbar. Without it the app can still show prices, but it cannot place or close orders. The app uses the terminal that is already open and logged in. It never asks for your password.
3. **Allow more history** (recommended). In MetaTrader, open *Tools > Options > Charts* and set *Max bars in chart* to *Unlimited*, then restart MetaTrader. With the default 100,000 bars, 1-minute history only reaches back about 70 days.
4. **Install Python 3.11 or newer** from [python.org/downloads](https://www.python.org/downloads/). On the first screen of the installer, tick **Add python.exe to PATH**.
5. **Install Node.js 20 or newer** from [nodejs.org](https://nodejs.org/). It is used to build the page.
6. **Check the gold name.** Open `settings.txt` in this folder:

   ```
   symbol = XAUUSD247m
   ```

   Change `XAUUSD247m` to the gold name in your broker's Market Watch if it is different, for example `XAUUSD` or `XAUUSDm`.

## Starting and stopping

**Start**: double-click `start.bat`.

The first start takes a few minutes. It creates the Python environment, installs the packages, builds the page, and installs the news calendar into MetaTrader. Later starts take a few seconds.

When it is ready, the app opens in your browser at http://127.0.0.1:8000. Two windows appear:

- The first window closes itself after a few seconds.
- The **Gold monitor** window stays open while the app runs. Leave it open.

If the app is already running, `start.bat` just opens the page again.

**Stop**: press Ctrl+C in the **Gold monitor** window, or double-click `stop.bat`. Your trades stay open in MetaTrader either way.

### The news calendar

News comes from MetaTrader's own economic calendar: about 2 years of past releases and 14 days ahead, for the US dollar, euro, yuan, pound, and yen. A small MetaTrader service called `GoldCalendarExport` copies it out every 5 minutes. `start.bat` installs that service for you.

MetaTrader only loads services when it opens. On the first start, if MetaTrader is already open, `start.bat` asks you to close it. Close MetaTrader, double-click `start.bat` again, then open MetaTrader. From then on the calendar starts with MetaTrader.

Prices and trading work without the calendar. Only the news marks and news tabs stay empty.

### Changing settings

Edit `settings.txt`, save it, then stop and start the app.

## Using it with an AI (MCP)

After the first start, add this to `%USERPROFILE%\.cursor\mcp.json` for Cursor, or to `claude_desktop_config.json` for Claude Desktop. Replace `C:\\path\\to\\gold-mcp` with the folder this README is in.

```json
"gold-mcp": {
  "command": "C:\\path\\to\\gold-mcp\\backend\\.venv\\Scripts\\python.exe",
  "args": ["C:\\path\\to\\gold-mcp\\backend\\mcp_server\\server.py"]
}
```

The MCP server reads the local database, so it keeps answering with the last saved data even when the app or MetaTrader is closed. Keep the app running to keep that data fresh.

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
| `estimate_swing_range(horizon_hours)` | Empirical range for the horizon, widened for scheduled events |

The prompt `short_term_gold_outlook(horizon_hours)` walks the AI through the analysis.

To test the MCP server without an AI client, run this from `backend`:

```powershell
.\.venv\Scripts\python -m mcp_server.smoke_test
```

## Reloading price history

If you raise *Max bars in chart* after the first start, stop the app and run this once from `backend`. Press Ctrl+C when it says the backfill finished, then start the app again.

```powershell
.\.venv\Scripts\python -m goldcore.collector --rebackfill
```

## Running without start.bat

For working on the code, run the two parts in separate PowerShell windows:

```powershell
# API and data collection on http://127.0.0.1:8000
cd backend
.\.venv\Scripts\python -m uvicorn api.main:app --host 127.0.0.1 --port 8000

# Page with live reload on http://localhost:5173
cd frontend
npm run dev
```

The API serves the built page itself after `npm run build`, so only the first window is needed for normal use.

To keep the database fresh for the MCP without the web app, run only the collectors from `backend`:

```powershell
.\.venv\Scripts\python -m goldcore.collector
```

## How it works

```
MetaTrader 5 --(Python API)--> collector --> data/gold.db <-- MCP server
GoldCalendarExport service --> gold_calendar.json --> collector
RSS / GDELT headlines --> collector
data/gold.db --> API (:8000) --> browser
```

Only the collector and the API talk to MetaTrader. Prices sync every 60 seconds, the calendar every 5 minutes, and headlines every 15 minutes.

## Notes and limits

- Buys open at the ask and close at the bid. Sells do the opposite. Candles are drawn from the bid, so a buy fills above the candle by about the spread.
- A target is set from the price the order actually filled at, so it cannot end up on the losing side.
- The loss shown for a stop is an estimate. In a fast market the fill can be worse than the stop price.
- Stored times are UTC. The page shows your local time.
- `XAUUSD247m` trades 24/7 with much quieter weekends, so range estimates compare weekdays with weekdays and weekends with weekends.
- Several releases often come out at the same minute, so each one's reaction stats include the others. Sample sizes are small, about 10 to 20 per monthly release.
- Headlines come from FXStreet, Investing.com, and Mining.com RSS from the first run onward. GDELT is an extra source that often rate-limits and may return nothing.
- Retail positioning comes from FXSSI and can lag by a few minutes.

## Folder layout

```
start.bat             start the app and open it in the browser
stop.bat              stop the app; trades in MetaTrader stay open
settings.txt          gold symbol name
backend/goldcore/     settings, database, MetaTrader feed, calendar, headlines, analytics, collectors
backend/api/          API and live price stream; also runs the collectors
backend/mcp_server/   MCP server and smoke test
mql5/                 GoldCalendarExport service source
frontend/             page (Vite, React, lightweight-charts)
data/gold.db          local database, created on first start and not committed
```

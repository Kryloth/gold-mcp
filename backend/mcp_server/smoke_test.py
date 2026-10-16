"""Spawns the MCP server over stdio, lists tools/prompts and calls each tool once. Run: python -m mcp_server.smoke_test"""
import asyncio
import json
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters, stdio_client

SERVER = Path(__file__).resolve().with_name("server.py")

CALLS = [
    ("get_market_snapshot", {}),
    ("get_price_history", {"timeframe": "H1", "limit": 3}),
    ("get_news_history", {"min_importance": 2, "limit": 5}),
    ("get_upcoming_events", {"hours_ahead": 48}),
    ("get_event_reaction_stats", {"event": "CPI"}),
    ("get_news_digest", {"days": 2, "utc_offset_minutes": 420}),
    ("get_volatility_profile", {"days": 30}),
    ("estimate_swing_range", {"horizon_hours": 4}),
    ("build_prediction_context", {"horizon_hours": 4}),
]


async def main() -> None:
    params = StdioServerParameters(command=sys.executable, args=[str(SERVER)])
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            print("tools:", [t.name for t in tools.tools])
            prompts = await session.list_prompts()
            print("prompts:", [p.name for p in prompts.prompts])
            for name, args in CALLS:
                res = await session.call_tool(name, args)
                text = res.content[0].text if res.content else ""
                status = "ERROR" if res.is_error else "ok"
                print(f"\n== {name} [{status}] {len(text)} chars")
                try:
                    print(json.dumps(json.loads(text), indent=1)[:700])
                except ValueError:
                    print(text[:700])


if __name__ == "__main__":
    asyncio.run(main())

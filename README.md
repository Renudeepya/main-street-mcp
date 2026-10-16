# Main Street MCP

**Put any local business on Alexa+ in five minutes, with one JSON file.**

Big brands are building Alexa+ experiences. The corner pizzeria, the barbershop and the family clinic can't afford to, so voice assistants send their customers to the chains. Main Street MCP is an open-source, self-hosted [MCP](https://modelcontextprotocol.io) server (spec **2025-11-25**, **Streamable HTTP**). It turns a business's menu, hours and booking rules into tools Alexa+ can call.

> "Alexa, order a large margherita and two garlic knots from Tony's for pickup."
> → *"That's 1 Margherita Pizza (Large), 2 Garlic Knots for Renu, $31.00, ready at 7:20. Should I place it?"*
> → "Yes." → The order appears on Tony's live order board.

## Features

| Tool | What it does |
|---|---|
| `get_business_info` | Address, phone, hours, and whether the business is open right now |
| `search_menu` | Search by keyword such as "vegan", "large margherita" or "dessert" |
| `place_order` | Pickup order in **two steps**: first a quote, then confirm |
| `get_order_status` / `cancel_order` | Status shown live from the owner's board |
| `check_availability` / `book_appointment` | Table, haircut or appointment slots, with capacity limits |

**Built for voice:**
- Every result includes a short `speech` line the assistant reads aloud as written.
- Orders and bookings always ask the customer to confirm first, so a misheard request never turns into a real order.
- If a request is ambiguous ("margherita" when there's a large and a small), the server returns a question for the customer instead of guessing.
- Order IDs are short and easy to say ("A-M-X-T"), with no letters that sound alike.
- Tool annotations (`readOnlyHint`, `destructiveHint`) tell the assistant which actions are safe.

**Works for any business:** Restaurants use the menu and orders. Barbers, salons and clinics use appointments. See `config/barbershop.example.json`. Tools register automatically based on what the config enables.

## Quick start

```bash
npm install
npm start                       # MCP at http://localhost:3000/mcp, dashboard at /dashboard
npm run smoke                   # end-to-end test using the official MCP client
```

Use your own business:
```bash
BUSINESS_CONFIG=config/barbershop.example.json npm start
```

| Env var | Purpose |
|---|---|
| `PORT` | Default 3000 |
| `BUSINESS_CONFIG` | Path to the business JSON |
| `DATA_FILE` | Where orders and bookings are stored (default `data/store.json`) |
| `MCP_API_KEY` | If set, `/mcp` requires `Authorization: Bearer <key>` |
| `OWNER_TOKEN` | If set, the dashboard needs `?token=<token>` |

## Architecture

```
Alexa+ / any MCP client ──Streamable HTTP──▶ /mcp  (McpServer, one per session)
                                               │
                                     tools.js (voice-first rules)
                                               │
                              business.js (hours, menu matching, slots)
                                               │
                                store.js ──change events──▶ /api/events (SSE) ──▶ Owner dashboard
```

## Roadmap
- [ ] Simulated Alexa+ voice web app (Amazon Bedrock agent calling this server)
- [ ] Deploy to AWS (AgentCore Runtime or Lambda) with DynamoDB storage
- [ ] Google Sheet as the menu source, so owners edit a spreadsheet instead of JSON
- [ ] Square/Toast connectors and SMS "order ready" notifications

## License
MIT

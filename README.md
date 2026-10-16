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

## Voice demo (simulated Alexa+)

Open **http://localhost:3000/voice**, tap the mic (Chrome, Edge or Safari) or type, and talk to Tony's. The right-hand panel shows every **MCP tool call** the assistant makes. Open `/dashboard` next to it and orders appear live.

The assistant connects to this server **as an MCP client over Streamable HTTP**, the same way Alexa+ does. It has two brains:

| Mode | How to enable | What it does |
|---|---|---|
| **Demo** (default) | nothing | Built-in intent parser for hours, menu, orders, "which size?" follow-ups, confirmations and bookings. Needs no cloud account. |
| **Amazon Bedrock** | `ASSISTANT_MODE=bedrock` + AWS credentials | Bedrock **Converse API with tool use**. Tools are discovered from the MCP server (`listTools`) and passed to the model, and each tool call it makes is run with MCP `callTool`. Default model `amazon.nova-lite-v1:0` (override with `BEDROCK_MODEL_ID`). |

```bash
cp .env.example .env      # add your AWS keys (.env is git-ignored)
npm run start:bedrock
```

## Quick start

```bash
npm install
npm start                       # MCP at /mcp · dashboard at /dashboard · voice demo at /voice
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
Voice web app (/voice) ──▶ /api/assistant ──(MCP client)──┐
Alexa+ / any MCP client ──Streamable HTTP──────────────────▶ /mcp  (McpServer, one per session)
                                               │
                                     tools.js (voice-first rules)
                                               │
                              business.js (hours, menu matching, slots)
                                               │
                                store.js ──change events──▶ /api/events (SSE) ──▶ Owner dashboard
```

## Roadmap
- [x] Simulated Alexa+ voice web app (demo brain + Amazon Bedrock Converse tool use)
- [ ] Deploy to AWS (AgentCore Runtime or Lambda) with DynamoDB storage
- [ ] Google Sheet as the menu source, so owners edit a spreadsheet instead of JSON
- [ ] Square/Toast connectors and SMS "order ready" notifications

## License
MIT

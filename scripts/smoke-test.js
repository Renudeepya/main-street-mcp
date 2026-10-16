// End-to-end check using the official MCP client over Streamable HTTP.
// Usage: npm start (in another terminal), then: npm run smoke
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MCP_URL || "http://localhost:3000/mcp");
const headers = process.env.MCP_API_KEY ? { Authorization: `Bearer ${process.env.MCP_API_KEY}` } : {};
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));

const say = (label, r) => console.log(`\n▶ ${label}\n  ${r.structuredContent?.speech ?? r.content[0].text}`);
const call = (name, args = {}) => client.callTool({ name, arguments: args });

console.log("Protocol:", client.transport.protocolVersion ?? "(negotiated)");
console.log("Tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));

say("info", await call("get_business_info"));
say("menu: vegan", await call("search_menu", { query: "vegan" }));
say("ambiguous item", await call("place_order", { items: [{ item: "margherita" }], customer_name: "Renu" }));
const order = [{ item: "large margherita", quantity: 1 }, { item: "garlic knots", quantity: 2, notes: "extra marinara" }];
say("quote", await call("place_order", { items: order, customer_name: "Renu" }));
const placed = await call("place_order", { items: order, customer_name: "Renu", confirm: true });
say("place", placed);
const id = placed.structuredContent?.order?.id;
if (id) say("status", await call("get_order_status", { order_id: id }));

const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const tomorrow = new Date(Date.now() + 864e5).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
say("availability", await call("check_availability", { service: "table for 2", date: tomorrow }));
say("book (quote)", await call("book_appointment", { service: "table-2", date: tomorrow, time: "19:00", customer_name: "Renu" }));
say("book (confirm)", await call("book_appointment", { service: "table-2", date: tomorrow, time: "19:00", customer_name: "Renu", confirm: true }));
void today;
await client.close();

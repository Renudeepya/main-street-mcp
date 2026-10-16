// Main Street MCP — a self-hosted MCP server (spec 2025-11-25, Streamable HTTP) that lets any
// small business plug into Alexa+ and other MCP-capable assistants from a single JSON config.
import express from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadBusiness } from "./business.js";
import { Store } from "./store.js";
import { registerTools } from "./tools.js";
import { createAssistant } from "./assistant.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 3000);
const biz = loadBusiness(process.env.BUSINESS_CONFIG || join(root, "config/business.json"));
const store = new Store(process.env.DATA_FILE || join(root, "data/store.json"));
const MCP_API_KEY = process.env.MCP_API_KEY;     // optional: require Bearer token on /mcp
const OWNER_TOKEN = process.env.OWNER_TOKEN;     // optional: protect the owner dashboard API

const INSTRUCTIONS = `You are taking requests for ${biz.name}, a local ${biz.type}. Be brief: replies are spoken aloud. ` +
  `Read the 'speech' field of tool results to the customer. Never place an order or booking without an explicit yes.`;

function buildServer() {
  const server = new McpServer(
    { name: "main-street-mcp", title: `${biz.name} (Main Street MCP)`, version: "0.1.0" },
    { instructions: INSTRUCTIONS }
  );
  registerTools(server, { biz, store });
  return server;
}

const app = express();
app.use(express.json({ limit: "256kb" }));

// ---- MCP endpoint (Streamable HTTP, stateful sessions) ----
const sessions = new Map(); // sessionId -> transport

function checkKey(req, res) {
  if (!MCP_API_KEY) return true;
  if (req.headers.authorization === `Bearer ${MCP_API_KEY}`) return true;
  res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  return false;
}

app.post("/mcp", async (req, res) => {
  if (!checkKey(req, res)) return;
  const sid = req.headers["mcp-session-id"];
  let transport = sid && sessions.get(sid);
  if (!transport) {
    if (sid || !isInitializeRequest(req.body)) {
      return res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session. Send initialize first." }, id: null });
    }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, transport),
    });
    transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
    await buildServer().connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});

const sessionRequest = async (req, res) => {
  if (!checkKey(req, res)) return;
  const transport = sessions.get(req.headers["mcp-session-id"]);
  if (!transport) return res.status(400).send("Invalid or missing session ID");
  await transport.handleRequest(req, res);
};
app.get("/mcp", sessionRequest);    // server-to-client SSE stream
app.delete("/mcp", sessionRequest); // session termination

// ---- Owner dashboard + API ----
const ownerAuth = (req, res, next) =>
  !OWNER_TOKEN || req.headers.authorization === `Bearer ${OWNER_TOKEN}` || req.query.token === OWNER_TOKEN
    ? next() : res.status(401).json({ error: "Unauthorized" });

app.get("/", (_req, res) => res.redirect("/dashboard"));
app.get("/dashboard", (_req, res) => res.sendFile(join(root, "public/dashboard.html")));
app.get("/api/business", (_req, res) => res.json({ name: biz.name, address: biz.address, type: biz.type }));
app.get("/api/orders", ownerAuth, (_req, res) => res.json({ orders: store.data.orders, bookings: store.data.bookings }));

const ORDER_FLOW = ["received", "preparing", "ready", "picked_up", "cancelled"];
app.post("/api/orders/:id/status", ownerAuth, (req, res) => {
  if (!ORDER_FLOW.includes(req.body?.status)) return res.status(400).json({ error: `status must be one of ${ORDER_FLOW}` });
  const o = store.updateOrder(req.params.id, { status: req.body.status });
  return o ? res.json(o) : res.status(404).json({ error: "not found" });
});
app.post("/api/bookings/:id/status", ownerAuth, (req, res) => {
  const b = store.updateBooking(req.params.id, { status: req.body?.status });
  return b ? res.json(b) : res.status(404).json({ error: "not found" });
});

// Live updates for the dashboard (Server-Sent Events)
app.get("/api/events", ownerAuth, (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const send = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  store.on("change", send);
  req.on("close", () => { clearInterval(ping); store.off("change", send); });
});

// ---- Simulated Alexa+ (voice web app) ----
const assistant = createAssistant({ mcpUrl: `http://127.0.0.1:${PORT}/mcp`, apiKey: MCP_API_KEY, biz, instructions: INSTRUCTIONS });
app.get("/voice", (_req, res) => res.sendFile(join(root, "public/voice.html")));
app.get("/api/assistant/info", (_req, res) => res.json({ mode: assistant.mode(), business: biz.name }));
app.post("/api/assistant", async (req, res) => {
  const { text, sessionId, customerName } = req.body || {};
  if (!text || typeof text !== "string" || text.length > 500) return res.status(400).json({ error: "text (1-500 chars) required" });
  res.json(await assistant.handle({ text, sessionId, customerName: String(customerName || "").slice(0, 60) }));
});
app.post("/api/assistant/reset", (req, res) => { assistant.reset(req.body?.sessionId); res.json({ ok: true }); });

app.get("/healthz", (_req, res) => res.json({ ok: true, business: biz.id, sessions: sessions.size }));

app.listen(PORT, () => {
  console.log(`Main Street MCP for "${biz.name}"`);
  console.log(`  MCP endpoint:   http://localhost:${PORT}/mcp`);
  console.log(`  Owner dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`  Voice demo:      http://localhost:${PORT}/voice  (assistant: ${assistant.mode()})`);
});

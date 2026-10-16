// Simulated Alexa+ assistant. It talks to Main Street MCP the same way Alexa+ does:
// as an MCP client over Streamable HTTP. Two "brains":
//   • bedrock: Amazon Bedrock Converse API with tool use (when AWS credentials are configured)
//   • demo:    a deterministic intent parser, so the demo works with zero cloud setup
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { localNow } from "./business.js";

const MAX_TURNS = 20;

export function createAssistant({ mcpUrl, apiKey, biz, instructions }) {
  let mcp, tools;
  const sessions = new Map();
  // Bedrock is opt-in so the demo never breaks on a machine with stray AWS settings.
  const useBedrock = process.env.ASSISTANT_MODE === "bedrock";
  const modelId = process.env.BEDROCK_MODEL_ID || "amazon.nova-lite-v1:0";
  let bedrock;

  async function connect() {
    if (mcp) return;
    mcp = new Client({ name: "simulated-alexa-plus", version: "0.1.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} },
    }));
    tools = (await mcp.listTools()).tools;
  }

  async function callTool(name, args, trace) {
    const r = await mcp.callTool({ name, arguments: args });
    const data = r.structuredContent ?? { speech: r.content?.[0]?.text };
    trace.push({ tool: name, args, result: data });
    return data;
  }

  function session(id) {
    if (!sessions.has(id)) sessions.set(id, { messages: [], pending: null, draft: null });
    return sessions.get(id);
  }

  // ---------------- Bedrock brain ----------------
  async function bedrockTurn(s, text, ctx, trace) {
    if (!bedrock) {
      const { BedrockRuntimeClient } = await import("@aws-sdk/client-bedrock-runtime");
      bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });
    }
    const { ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const n = localNow(biz.timezone);
    const system = [{ text:
      `${instructions}\nToday is ${n.date} (${n.day}), local time ${n.time} in ${biz.timezone}. ` +
      `The customer's name is ${ctx.customerName || "unknown (ask if needed)"}. ` +
      `Reply in one or two short spoken sentences. Prefer reading the tool's 'speech' field.` }];
    const toolConfig = { tools: tools.map((t) => {
      const { $schema, ...schema } = t.inputSchema || { type: "object", properties: {} };
      return { toolSpec: { name: t.name, description: t.description || t.name, inputSchema: { json: schema } } };
    }) };

    s.messages.push({ role: "user", content: [{ text }] });
    for (let i = 0; i < 6; i++) {
      const resp = await bedrock.send(new ConverseCommand({
        modelId, system, messages: s.messages, toolConfig,
        inferenceConfig: { maxTokens: 400, temperature: 0.2 },
      }));
      const msg = resp.output.message;
      s.messages.push(msg);
      if (resp.stopReason !== "tool_use") {
        s.messages = s.messages.slice(-MAX_TURNS);
        return msg.content.filter((c) => c.text).map((c) => c.text).join(" ").trim();
      }
      const results = [];
      for (const block of msg.content) {
        if (!block.toolUse) continue;
        const data = await callTool(block.toolUse.name, block.toolUse.input || {}, trace);
        results.push({ toolResult: { toolUseId: block.toolUse.toolUseId, content: [{ json: data }] } });
      }
      s.messages.push({ role: "user", content: results });
    }
    return "Sorry, I got a bit lost there. Could you say that again?";
  }

  // ---------------- Demo brain (no cloud needed) ----------------
  const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const YES = /^(yes|yeah|yep|yup|sure|ok|okay|correct|confirm|place it|book it|do it|go ahead|sounds good|please do)\b/;
  const NO = /^(no|nope|cancel|never ?mind|stop|don'?t)\b/;
  const FILLER = /\b(please|from tony'?s|from the pizzeria|for pickup|for pick up|to go|thanks|thank you|alexa|order|i'?d like|i want|can i get|could i get|get me|i'?ll have|let me get)\b/g;

  function parseTime(t) {
    const m = t.match(/\b(?:at|around|for)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/);
    if (!m) return null;
    let h = Number(m[1]); const min = m[2] || "00"; const ap = m[3]?.[0];
    if (ap === "p" && h < 12) h += 12;
    if (ap === "a" && h === 12) h = 0;
    if (!ap && h < 11) h += 12; // "at 7" at a restaurant means 7 PM
    return `${String(h).padStart(2, "0")}:${min}`;
  }

  function parseDate(t) {
    const today = localNow(biz.timezone);
    const base = new Date(`${today.date}T12:00:00Z`);
    const add = (d) => new Date(base.getTime() + d * 864e5).toISOString().slice(0, 10);
    if (/\btomorrow\b/.test(t)) return add(1);
    const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const idx = days.findIndex((d) => t.includes(d));
    if (idx >= 0) { const diff = (idx - base.getUTCDay() + 7) % 7 || 7; return add(diff); }
    return today.date;
  }

  function parseItems(t) {
    const body = t.replace(FILLER, " ").replace(/\b(at|around)\s+\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)?/g, " ")
      .replace(/\basap\b|\bas soon as possible\b|\bfor [a-z]+$/g, " ");
    return body.split(/,|\band\b|\bplus\b|\balso\b/).map((seg) => seg.trim()).filter(Boolean).map((seg) => {
      const words = seg.split(/\s+/);
      let quantity = 1;
      if (NUM[words[0]] || /^\d+$/.test(words[0])) { quantity = NUM[words[0]] || Number(words[0]); words.shift(); }
      return { item: words.join(" ").replace(/\b(pizzas?|pies?)\b/, "pizza").trim(), quantity };
    }).filter((i) => i.item.length > 1);
  }

  async function demoTurn(s, raw, ctx, trace) {
    const t = raw.toLowerCase().replace(/[?!.]/g, "").trim();
    const name = ctx.customerName || "Guest";

    // Confirmation of a pending quote
    if (s.pending && YES.test(t)) {
      const { tool, args } = s.pending; s.pending = null; s.draft = null;
      return (await callTool(tool, { ...args, confirm: true }, trace)).speech;
    }
    if (s.pending && NO.test(t)) { s.pending = null; s.draft = null; return "No problem, I've cancelled that. Anything else?"; }

    // Resolving an ambiguous item ("which margherita?" -> "large")
    if (s.draft?.candidates) {
      const pick = s.draft.candidates.find((c) => t.split(/\s+/).some((w) => w.length > 2 && c.toLowerCase().includes(w)));
      if (pick) {
        s.draft.items[s.draft.index].item = pick;
        return orderQuote(s, s.draft.items, s.draft.pickup, name, trace);
      }
    }

    if (/\b(status|where is|ready yet|is my order)\b/.test(t)) {
      const id = raw.match(/\b([AR])\s*-?\s*([A-Z0-9])\s*([A-Z0-9])\s*([A-Z0-9])\b/i);
      const last = s.lastOrderId;
      if (!id && !last) return "What's your order number? It starts with A.";
      return (await callTool("get_order_status", { order_id: id ? `${id[1]}-${id[2]}${id[3]}${id[4]}`.toUpperCase() : last }, trace)).speech;
    }
    if (/\b(book|reserve|reservation|table for)\b/.test(t)) {
      const party = Number((t.match(/\b(?:for|party of)\s+(\d+|two|four|three|five|six)\b/) || [])[1]?.replace(/two|three/, "2").replace(/four|five|six/, "4") || 2) > 2 ? "table-4" : "table-2";
      const date = parseDate(t); const time = parseTime(t.replace(/\b(?:for|party of)\s+(\d+|two|three|four|five|six)\b/, ""));
      if (!time) return (await callTool("check_availability", { service: party, date }, trace)).speech;
      const args = { service: party, date, time, customer_name: name };
      const r = await callTool("book_appointment", { ...args, confirm: false }, trace);
      if (r.stage === "quote") s.pending = { tool: "book_appointment", args };
      return r.speech;
    }
    if (/\b(cancel)\b.*\b(order)\b/.test(t) && s.lastOrderId) {
      return (await callTool("cancel_order", { order_id: s.lastOrderId }, trace)).speech;
    }
    if (/\b(open|hours|close|closing|address|where are you|located|phone)\b/.test(t)) {
      return (await callTool("get_business_info", {}, trace)).speech;
    }
    if (/\b(menu|vegan|vegetarian|desserts?|drinks?|what do you have|options|sides|what pizzas)\b/.test(t)) {
      const kw = (t.match(/\b(vegan|vegetarian|desserts?|drinks?|sides|pizzas?)\b/) || [])[1];
      const CATEGORY = { dessert: "dessert", desserts: "dessert", drink: "drinks", drinks: "drinks", sides: "sides", pizza: "pizza", pizzas: "pizza" };
      const args = !kw ? {} : CATEGORY[kw] ? { category: CATEGORY[kw] } : { query: kw };
      return (await callTool("search_menu", args, trace)).speech;
    }
    if (/\b(order|get|like|want|have|need)\b/.test(t)) {
      const items = parseItems(t);
      if (!items.length) return "What would you like to order?";
      const pickup = /\b(at|around)\s+\d/.test(t) ? parseTime(t.replace(/\baround\b/, "at")) : "asap";
      return orderQuote(s, items, pickup, name, trace);
    }
    return `I can check ${biz.name}'s hours, read the menu, place a pickup order, or book a table. What would you like?`;
  }

  async function orderQuote(s, items, pickup, name, trace) {
    const args = { items, customer_name: name, pickup_time: pickup || "asap" };
    const r = await callTool("place_order", { ...args, confirm: false }, trace);
    if (r.candidates) {
      const index = items.findIndex((i) => r.speech.toLowerCase().includes(`"${i.item.toLowerCase()}"`));
      s.draft = { items, pickup, candidates: r.candidates, index: Math.max(index, 0) };
      return `${r.candidates.join(" or ")}?`;
    }
    s.draft = null;
    if (r.stage === "quote") s.pending = { tool: "place_order", args };
    return r.speech;
  }

  return {
    mode: () => (useBedrock ? `bedrock:${modelId}` : "demo"),
    async handle({ sessionId, text, customerName }) {
      await connect();
      const s = session(sessionId || "default");
      const trace = [];
      let reply;
      try {
        reply = useBedrock ? await bedrockTurn(s, text, { customerName }, trace) : await demoTurn(s, text, { customerName }, trace);
      } catch (err) {
        console.error("assistant error:", err);
        reply = useBedrock ? `Bedrock error: ${err.name || "unknown"}. Check AWS credentials, region and model access.` : "Sorry, something went wrong.";
      }
      for (const step of trace) if (step.result?.order?.id) s.lastOrderId = step.result.order.id;
      return { reply, trace, mode: this.mode() };
    },
    reset(sessionId) { sessions.delete(sessionId); },
  };
}

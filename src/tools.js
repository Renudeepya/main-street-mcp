// MCP tool definitions. Design rules for voice (Alexa+):
//  1. Every result carries a short `speech` line the assistant can read aloud verbatim.
//  2. Anything that spends money or holds a table is two-step: confirm=false returns a quote,
//     confirm=true commits. This prevents "Alexa misheard me" orders.
//  3. Ambiguity is returned as a question for the customer, never guessed.
import { z } from "zod";
import { localNow, isOpenAt, hoursFor, formatHours, searchMenu, resolveItem, slotsFor, toMin, fromMin } from "./business.js";

const money = (n) => `$${n.toFixed(2)}`;
// Speech-friendly formatting: "19:30" -> "7:30 PM", "2026-10-17" -> "Saturday, October 17"
const t12 = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`; };
const sayDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const reply = (speech, data = {}) => ({
  content: [{ type: "text", text: speech }],
  structuredContent: { speech, ...data },
});
const fail = (speech, data = {}) => ({ ...reply(speech, { ok: false, ...data }), isError: false });

export function registerTools(server, { biz, store, clock = () => new Date() }) {
  const now = () => localNow(biz.timezone, clock());

  server.registerTool(
    "get_business_info",
    {
      title: "Business info",
      description: `Get ${biz.name}'s address, phone, opening hours and whether it is open right now.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const n = now();
      const open = isOpenAt(biz, n.date, n.time);
      const today = hoursFor(biz, n.date);
      const speech = open
        ? `${biz.name} is open now until ${t12(today[1])}. It's at ${biz.address}.`
        : `${biz.name} is closed right now.${today ? ` Today's hours are ${t12(today[0])} to ${t12(today[1])}.` : ""} It's at ${biz.address}.`;
      return reply(speech, { ok: true, name: biz.name, address: biz.address, phone: biz.phone, openNow: open, hours: formatHours(biz) });
    }
  );

  if (biz.menu?.length) {
    server.registerTool(
      "search_menu",
      {
        title: "Search menu",
        description: `Search ${biz.name}'s menu by keyword (e.g. "vegan", "pepperoni", "dessert") or category. Leave both empty to list everything.`,
        inputSchema: {
          query: z.string().optional().describe("Free-text keyword, e.g. 'vegetarian' or 'large margherita'"),
          category: z.string().optional().describe(`One of: ${[...new Set(biz.menu.map((i) => i.category))].join(", ")}`),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ query, category }) => {
        const items = searchMenu(biz, query, category);
        if (!items.length) return fail(`I couldn't find anything matching "${query ?? category}" on the menu.`, { items: [] });
        const top = items.slice(0, 5).map((i) => `${i.name} for ${money(i.price)}`).join("; ");
        return reply(`${items.length > 5 ? "Top matches" : "Here's what I found"}: ${top}.`, {
          ok: true, items: items.map(({ id, name, category, price, tags, description }) => ({ id, name, category, price, tags, description })),
        });
      }
    );
  }

  if (biz.ordering?.enabled) {
    server.registerTool(
      "place_order",
      {
        title: "Place pickup order",
        description:
          `Place a pickup order at ${biz.name}. ALWAYS call first with confirm=false to get a quote, read it back to the customer, ` +
          `and only call again with confirm=true after they say yes.`,
        inputSchema: {
          items: z.array(z.object({
            item: z.string().describe("Menu item name or id, as the customer said it"),
            quantity: z.number().int().min(1).max(10).default(1),
            notes: z.string().max(200).optional().describe("e.g. 'well done', 'no onions'"),
          })).min(1).max(biz.ordering.maxItemsPerOrder || 20),
          customer_name: z.string().min(1).max(60),
          pickup_time: z.string().regex(/^(asap|\d{2}:\d{2})$/).default("asap").describe("'asap' or HH:MM (24h, business local time, today)"),
          confirm: z.boolean().default(false).describe("false = quote only, true = place the order"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ items, customer_name, pickup_time, confirm }) => {
        const n = now();
        const lead = biz.ordering.pickupLeadMinutes || 20;
        const earliest = toMin(n.time) + lead;
        const pickup = pickup_time === "asap" ? fromMin(earliest) : pickup_time;
        if (toMin(pickup) < earliest) return fail(`The earliest pickup is ${t12(fromMin(earliest))}. Would that work?`, { earliest: fromMin(earliest) });
        if (!isOpenAt(biz, n.date, pickup)) {
          const h = hoursFor(biz, n.date);
          return fail(h ? `We're not open at ${t12(pickup)}. Today's hours are ${t12(h[0])} to ${t12(h[1])}.` : `${biz.name} is closed today.`);
        }

        const lines = [];
        for (const req of items) {
          const r = resolveItem(biz, req.item);
          if (r.error) return fail(r.error, { candidates: r.candidates?.map((c) => c.name) });
          lines.push({ id: r.item.id, name: r.item.name, unitPrice: r.item.price, quantity: req.quantity, notes: req.notes, lineTotal: r.item.price * req.quantity });
        }
        const total = Math.round(lines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100;
        const summary = lines.map((l) => `${l.quantity} ${l.name}`).join(", ");

        if (!confirm) {
          return reply(`That's ${summary} for ${customer_name}, total ${money(total)}, ready for pickup at ${t12(pickup)}. Should I place it?`,
            { ok: true, stage: "quote", lines, total, pickupTime: pickup });
        }
        const order = store.addOrder({ customerName: customer_name, lines, total, currency: biz.currency, pickupTime: pickup, date: n.date, channel: "alexa+" });
        return reply(`Done! Order ${order.id.split("").join(" ")} is in: ${summary}, ${money(total)}, ready at ${t12(pickup)}. Pay at pickup.`,
          { ok: true, stage: "placed", order });
      }
    );

    server.registerTool(
      "get_order_status",
      {
        title: "Order status",
        description: "Check the status of a pickup order by its order ID (e.g. A-7K3).",
        inputSchema: { order_id: z.string().describe("Order ID, e.g. A-7K3") },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ order_id }) => {
        const o = store.getOrder(order_id);
        if (!o) return fail(`I couldn't find order ${order_id}.`);
        const phrase = { received: "has been received", preparing: "is being made now", ready: "is ready for pickup", picked_up: "was picked up", cancelled: "was cancelled" }[o.status];
        return reply(`Order ${o.id} ${phrase}.${o.status === "received" || o.status === "preparing" ? ` Pickup time is ${t12(o.pickupTime)}.` : ""}`, { ok: true, order: o });
      }
    );

    server.registerTool(
      "cancel_order",
      {
        title: "Cancel order",
        description: "Cancel a pickup order that the kitchen has not started yet.",
        inputSchema: { order_id: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ order_id }) => {
        const o = store.getOrder(order_id);
        if (!o) return fail(`I couldn't find order ${order_id}.`);
        if (o.status !== "received") return fail(`Sorry, order ${o.id} is already ${o.status.replace("_", " ")}, so it can't be cancelled. You can call ${biz.phone}.`);
        store.updateOrder(o.id, { status: "cancelled" });
        return reply(`Order ${o.id} is cancelled.`, { ok: true });
      }
    );
  }

  if (biz.appointments?.enabled) {
    const services = biz.appointments.services;
    const findService = (s) => services.find((x) => x.id === s || x.name.toLowerCase() === s.toLowerCase()) ||
      services.find((x) => x.name.toLowerCase().includes(s.toLowerCase()));
    const label = biz.appointments.label || "appointment";

    server.registerTool(
      "check_availability",
      {
        title: `Check ${label} availability`,
        description: `List open ${label} times at ${biz.name} for a date. Services: ${services.map((s) => `${s.name} (${s.id})`).join(", ")}.`,
        inputSchema: {
          service: z.string().describe("Service name or id"),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD; defaults to today"),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ service, date }) => {
        const svc = findService(service);
        if (!svc) return fail(`We offer ${services.map((s) => s.name).join(" or ")}. Which one?`);
        const n = now();
        const d = date || n.date;
        let slots = slotsFor(biz, svc, d, store.data.bookings);
        if (d === n.date) slots = slots.filter((t) => toMin(t) > toMin(n.time));
        if (!slots.length) return fail(`No ${svc.name} times are left on ${d}.`, { slots: [] });
        const spoken = slots.length > 4 ? `${slots.slice(0, 4).map(t12).join(", ")} and ${slots.length - 4} more` : slots.map(t12).join(", ");
        return reply(`For ${svc.name} on ${sayDate(d)}, I have ${spoken}.`, { ok: true, service: svc, date: d, slots });
      }
    );

    server.registerTool(
      "book_appointment",
      {
        title: `Book ${label}`,
        description: `Book a ${label}. Call with confirm=false first, read back the details, then confirm=true after the customer agrees.`,
        inputSchema: {
          service: z.string(),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          time: z.string().regex(/^\d{2}:\d{2}$/),
          customer_name: z.string().min(1).max(60),
          confirm: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ service, date, time, customer_name, confirm }) => {
        const svc = findService(service);
        if (!svc) return fail(`We offer ${services.map((s) => s.name).join(" or ")}. Which one?`);
        const slots = slotsFor(biz, svc, date, store.data.bookings);
        if (!slots.includes(time)) {
          return fail(`${time} isn't available for ${svc.name} on ${date}.${slots.length ? ` Closest options: ${slots.slice(0, 3).map(t12).join(", ")}.` : ""}`, { slots });
        }
        if (!confirm) return reply(`${svc.name} on ${sayDate(date)} at ${t12(time)} for ${customer_name}. Shall I book it?`, { ok: true, stage: "quote" });
        const b = store.addBooking({ serviceId: svc.id, serviceName: svc.name, date, time, durationMinutes: svc.durationMinutes, customerName: customer_name, channel: "alexa+" });
        return reply(`You're booked: ${svc.name} on ${sayDate(date)} at ${t12(time)}. Your confirmation is ${b.id.split("").join(" ")}.`, { ok: true, stage: "booked", booking: b });
      }
    );
  }
}

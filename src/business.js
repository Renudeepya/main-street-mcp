// Business rules: hours, menu matching, slot availability.
// Everything is computed in the business's own timezone using "YYYY-MM-DD" and "HH:MM" strings,
// so no UTC conversion bugs can creep in.
import { readFileSync } from "node:fs";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function loadBusiness(path) {
  const biz = JSON.parse(readFileSync(path, "utf8"));
  if (!biz.name || !biz.hours || !biz.timezone) {
    throw new Error(`Invalid business config at ${path}: name, hours and timezone are required`);
  }
  return biz;
}

/** Current local date/time parts in the business timezone. `now` is injectable for tests/demos. */
export function localNow(tz, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    day: parts.weekday.toLowerCase().slice(0, 3),
  };
}

export const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
export const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function dayOf(dateStr) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
}

export function hoursFor(biz, dateStr) {
  return biz.hours[dayOf(dateStr)] || null; // null = closed that day
}

export function isOpenAt(biz, dateStr, hhmm) {
  const h = hoursFor(biz, dateStr);
  if (!h) return false;
  const t = toMin(hhmm);
  return t >= toMin(h[0]) && t < toMin(h[1]);
}

export function formatHours(biz) {
  const label = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
  return ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => {
    const h = biz.hours[d];
    return `${label[d]}: ${h ? `${h[0]}–${h[1]}` : "closed"}`;
  });
}

// ---------- Menu matching (voice requests are messy: "a large marg", "two pepperoni") ----------
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const tokens = (s) => norm(s).split(" ").filter((t) => t && !["a", "an", "the", "of", "pizza", "please"].includes(t));

function score(query, item) {
  const q = tokens(query);
  if (!q.length) return 0;
  const hay = tokens(`${item.name} ${item.id} ${item.category} ${(item.tags || []).join(" ")}`);
  let hit = 0;
  for (const t of q) if (hay.some((h) => h === t || h.startsWith(t) || (t.length > 3 && t.startsWith(h)))) hit++;
  return hit / q.length;
}

export function searchMenu(biz, query, category) {
  let items = biz.menu || [];
  if (category) items = items.filter((i) => i.category === category.toLowerCase());
  if (!query) return items;
  return items
    .map((i) => ({ i, s: score(query, i) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.i);
}

/** Resolve one spoken item to exactly one menu entry, or explain why not. */
export function resolveItem(biz, query) {
  const exact = (biz.menu || []).find((i) => i.id === query || norm(i.name) === norm(query));
  if (exact) return { item: exact };
  const ranked = (biz.menu || []).map((i) => ({ i, s: score(query, i) })).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s);
  if (!ranked.length) return { error: `"${query}" is not on the menu.` };
  const top = ranked.filter((x) => x.s === ranked[0].s);
  if (top.length > 1) {
    return { error: `"${query}" could mean: ${top.map((x) => x.i.name).join(", ")}. Ask the customer which one.`, candidates: top.map((x) => x.i) };
  }
  return { item: ranked[0].i };
}

// ---------- Reservations / appointments ----------
export function slotsFor(biz, service, dateStr, bookings) {
  const cfg = biz.appointments;
  const h = hoursFor(biz, dateStr);
  if (!cfg?.enabled || !h) return [];
  const step = cfg.slotMinutes || 30;
  const open = toMin(h[0]);
  const lastStart = toMin(h[1]) - service.durationMinutes;
  const out = [];
  for (let t = open; t <= lastStart; t += step) {
    const taken = bookings.filter((b) => b.date === dateStr && b.status !== "cancelled" &&
      toMin(b.time) < t + service.durationMinutes && t < toMin(b.time) + b.durationMinutes).length;
    if (taken < (cfg.capacityPerSlot || 1)) out.push(fromMin(t));
  }
  return out;
}

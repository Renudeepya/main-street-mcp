// Tiny JSON-file store with change events (powers the live owner dashboard).
// Swap for DynamoDB in production — the interface is intentionally small.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export class Store extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.data = { orders: [], bookings: [] };
    if (file && existsSync(file)) this.data = JSON.parse(readFileSync(file, "utf8"));
  }

  #save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  #id(prefix) {
    // Short, speakable IDs: "A-7K3" is easy to say out loud; "f3a9c..." is not.
    const alphabet = "ACDEFGHJKMNPQRTUVWXY3479";
    const b = randomBytes(3);
    return `${prefix}-${[...b].map((x) => alphabet[x % alphabet.length]).join("")}`;
  }

  addOrder(order) {
    const o = { id: this.#id("A"), status: "received", createdAt: new Date().toISOString(), ...order };
    this.data.orders.unshift(o);
    this.#save();
    this.emit("change", { type: "order.created", order: o });
    return o;
  }

  getOrder(id) {
    return this.data.orders.find((o) => o.id.toUpperCase() === String(id).toUpperCase().replace(/\s/g, ""));
  }

  updateOrder(id, patch) {
    const o = this.getOrder(id);
    if (!o) return null;
    Object.assign(o, patch, { updatedAt: new Date().toISOString() });
    this.#save();
    this.emit("change", { type: "order.updated", order: o });
    return o;
  }

  addBooking(booking) {
    const b = { id: this.#id("R"), status: "confirmed", createdAt: new Date().toISOString(), ...booking };
    this.data.bookings.unshift(b);
    this.#save();
    this.emit("change", { type: "booking.created", booking: b });
    return b;
  }

  updateBooking(id, patch) {
    const b = this.data.bookings.find((x) => x.id.toUpperCase() === String(id).toUpperCase());
    if (!b) return null;
    Object.assign(b, patch, { updatedAt: new Date().toISOString() });
    this.#save();
    this.emit("change", { type: "booking.updated", booking: b });
    return b;
  }
}

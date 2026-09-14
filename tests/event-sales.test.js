import test from "node:test";
import assert from "node:assert/strict";
import Event from "../models/Event.js";
import { createEventSalesHandler } from "../controllers/Events/event-sales-controller.js";

const id = "507f1f77bcf86cd799439011";
async function run({ data = {}, user = { userId: "editor", roles: ["board_member"], region: "groningen" }, closed = true, missing = false, failSave = false } = {}) {
  const event = Event.hydrate({ _id: id, status: "opened", region: "groningen", date: new Date("2099-12-01"), ticketTimer: new Date("2099-11-01"), isSaleClosed: false, metadata: { createdBy: "creator", createdAt: new Date("2026-01-01") }, product: { guest: { price: 12 } }, ...data });
  let saved = false, error, response, refreshed = false;
  event.save = async () => { if (failSave) throw new Error("offline"); saved = true; return event; };
  const handler = createEventSalesHandler({ EventModel: { findById: async () => missing ? null : event }, refresh: () => { refreshed = true; } });
  await handler({ params: { eventId: id }, body: { isSaleClosed: closed }, user }, { status: () => ({ json: (body) => { response = body; } }) }, (err) => { error = err; });
  return { event, saved, error, response, refreshed };
}
test("closing sales preserves deadline/pricing and stamps the editor", async () => {
  const r = await run();
  assert.equal(r.error, undefined); assert.equal(r.saved, true); assert.equal(r.refreshed, true);
  assert.equal(r.response.event.isSaleClosed, true);
  assert.equal(r.event.product.guest.price, 12);
  assert.equal(r.event.ticketTimer.toISOString(), "2099-11-01T00:00:00.000Z");
  assert.equal(r.event.metadata.createdBy, "creator"); assert.equal(r.event.metadata.updatedBy, "editor");
});
test("reopening an expired sale extends its deadline to the event start", async () => {
  const r = await run({ closed: false, data: { ticketTimer: new Date("2020-01-01"), isSaleClosed: true, status: "closed" } });
  assert.equal(r.error, undefined); assert.equal(r.response.event.isSaleClosed, false);
  assert.equal(r.event.status, "opened"); assert.deepEqual(r.event.ticketTimer, r.event.date);
});
test("reopening keeps an unexpired deadline", async () => {
  const r = await run({ closed: false, data: { isSaleClosed: true } });
  assert.equal(r.error, undefined); assert.equal(r.event.ticketTimer.toISOString(), "2099-11-01T00:00:00.000Z");
});
for (const [label, args, code] of [
  ["past events cannot reopen", { closed: false, data: { date: new Date("2020-01-01") } }, 409],
  ["regional accounts cannot edit another region", { data: { region: "amsterdam" } }, 403],
  ["regional accounts cannot edit national events", { data: { region: "netherlands" } }, 403],
  ["ordinary members cannot toggle sales", { user: { userId: "member", roles: ["member"], region: "groningen" } }, 403],
  ["archived events cannot reopen", { closed: false, data: { status: "archived" } }, 409],
  ["invalid values are rejected", { closed: "false" }, 400],
  ["missing event returns 404", { missing: true }, 404],
  ["failed saves cannot report success or refresh public data", { failSave: true }, 500],
]) test(label, async () => {
  const r = await run(args); assert.equal(r.error?.code, code); assert.equal(r.saved, false); assert.equal(r.response, undefined); assert.equal(r.refreshed, false);
});
test("admins can manage events across regions", async () => {
  const r = await run({ data: { region: "amsterdam" }, user: { userId: "admin", roles: ["admin"], region: "groningen" } });
  assert.equal(r.error, undefined); assert.equal(r.saved, true);
});

import assert from "node:assert/strict";
import test from "node:test";
import Event from "../models/Event.js";
import EventDraft from "../models/EventDraft.js";
import { stampEventMetadata } from "../services/events/event-metadata.js";
import { serializePublicEvent } from "../services/public-content/event-publication.js";
import { addEvent, editEvent } from "../controllers/Events/future-events-action-controller.js";

const createdAt = new Date("2026-09-01T10:00:00Z");
const updatedAt = new Date("2026-09-14T12:00:00Z");
const request = (id) => ({ account: { id }, user: { userId: id, roles: ["admin"], region: "amsterdam" },
  body: { metadata: { createdBy: "forged", updatedBy: "forged", createdAt: "1900-01-01", updatedAt: "1900-01-01" } } });
const metadata = (doc) => doc.metadata.toObject();

for (const Model of [EventDraft, Event]) {
  test(`${Model.modelName} creation stores authenticated attribution and Date timestamps`, () => {
    const event = new Model({ createdAt });
    const req = request("creator"); req.user.userId = "stale-claim";
    stampEventMetadata(event, req, { now: createdAt });
    assert.deepEqual(metadata(event), { createdBy: "creator", createdAt, updatedBy: "creator", updatedAt: createdAt });
    assert.equal(event.metadata._id, undefined);
    assert.equal(event.toObject().lastUpdate, undefined);
    assert.equal(Model.schema.path("lastUpdate"), undefined);
  });
}

test("edits preserve creation fields and replace the latest editor and time", () => {
  const event = Event.hydrate({ createdAt, metadata: { createdBy: "creator", createdAt, updatedBy: "creator", updatedAt: createdAt } });
  stampEventMetadata(event, request("editor"), { now: updatedAt });
  assert.deepEqual(metadata(event), { createdBy: "creator", createdAt, updatedBy: "editor", updatedAt });
  event.metadata.createdBy = "replacement";
  event.metadata.createdAt = updatedAt;
  assert.equal(event.metadata.createdBy, "creator");
  assert.deepEqual(event.metadata.createdAt, createdAt);
});

test("publishing preserves draft provenance even when another account publishes", () => {
  const draft = new EventDraft({ createdAt });
  stampEventMetadata(draft, request("draft-author"), { now: createdAt });
  const event = new Event({ _id: draft._id, createdAt: draft.createdAt });
  stampEventMetadata(event, request("publisher"), { source: draft, now: updatedAt });
  assert.deepEqual(metadata(event), { createdBy: "draft-author", createdAt, updatedBy: "publisher", updatedAt });
});

test("legacy drafts retain their original owner when edited or published", () => {
  const draft = EventDraft.hydrate({ createdAt, draftOwner: { userId: "original-owner" } });
  const event = new Event({ createdAt });
  stampEventMetadata(event, request("publisher"), { source: draft, now: updatedAt });
  stampEventMetadata(draft, request("editor"), { now: updatedAt });
  for (const record of [draft, event]) {
    assert.equal(record.metadata.createdBy, "original-owner");
    assert.deepEqual(record.metadata.createdAt, createdAt);
  }
});

test("a legacy event's latest editor is never invented as its original creator", () => {
  const event = Event.hydrate({ createdAt, lastUpdate: { id: "previous-editor", timestamp: createdAt } });
  stampEventMetadata(event, request("new-editor"), { now: updatedAt });
  assert.deepEqual(metadata(event), { createdBy: null, createdAt, updatedBy: "new-editor", updatedAt });
});

test("missing authentication cannot stamp metadata from a request body", () => {
  const event = new EventDraft();
  assert.throws(() => stampEventMetadata(event, { body: { userId: "forged" } }), { code: 401 });
  assert.equal(event.metadata, undefined);
});

test("public event responses do not expose editor or creator IDs", () => {
  const event = new Event({ createdAt });
  stampEventMetadata(event, request("private-actor"), { now: updatedAt });
  const publicEvent = serializePublicEvent(event);
  assert.deepEqual(publicEvent.metadata, { updatedAt });
  assert.equal(publicEvent.lastUpdate, undefined);
  assert.doesNotMatch(JSON.stringify(publicEvent), /private-actor/);
});

test("draft create and edit handlers persist trusted metadata without database or external calls", async (t) => {
  let saved;
  t.mock.method(EventDraft.prototype, "save", async function () { await this.validate(); saved = this.toObject(); return this; });
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  const req = request("creator"); req.body.status = "draft"; req.body.region = "amsterdam";
  req.body.draftData = JSON.stringify({ title: "Draft metadata test", region: "amsterdam" });
  const fail = (error) => { throw error; };
  await addEvent(req, res, fail);
  assert.equal(res.code, 201);
  assert.equal(saved.metadata.createdBy, "creator");
  const originalCreatedAt = saved.metadata.createdAt;
  const existing = EventDraft.hydrate(saved);
  t.mock.method(Event, "findById", async () => null);
  t.mock.method(EventDraft, "findById", async () => existing);
  const edit = request("editor"); edit.params = { eventId: String(existing._id) };
  edit.body.status = "draft"; edit.body.region = req.body.region; edit.body.draftData = req.body.draftData;
  await editEvent(edit, res, fail);
  assert.equal(res.code, 200);
  assert.equal(saved.metadata.createdBy, "creator");
  assert.deepEqual(saved.metadata.createdAt, originalCreatedAt);
  assert.equal(saved.metadata.updatedBy, "editor");
  assert.ok(saved.metadata.updatedAt instanceof Date);
});

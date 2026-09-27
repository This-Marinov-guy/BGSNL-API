import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { supportLiveScopes, streamSupport } from "../services/support/live.js";
import { createSupportService } from "../services/support/conversations.js";
import { memorySupportStore } from "./fixtures/support-store.js";

function setup() {
  const changes = [];
  const service = createSupportService({ records: memorySupportStore(), notifyChanged: record => changes.push(record._id) });
  const guest = { secret: "a".repeat(64) };
  const input = { id: randomUUID(), subject: "Test", text: "Details", contact: { name: "Guest", email: "guest@example.test" }, pagePath: "/" };
  return { service, changes, guest, input };
}

test("successful writes invalidate support streams, idempotent retries do not", async () => {
  const { service, changes, guest, input } = setup();
  await service.create(input, guest);
  await service.create(input, guest);
  const reply = { id: randomUUID(), text: "More detail" };
  const record = await service.reply(input.id, reply, guest);
  await service.reply(input.id, reply, guest);
  await service.changeStatus(input.id, { status: "resolved", revision: record.revision }, guest);
  assert.deepEqual(changes, [input.id, input.id, input.id]);
});

test("subscriptions authorize staff, owner aliases, and every guest ticket", async () => {
  const { service, guest, input } = setup();
  await service.create(input, guest);
  assert.deepEqual(await supportLiveScopes({ guests: [{ id: input.id, secret: guest.secret }] }, {}, service), [`support:thread:${input.id}`]);
  assert.deepEqual(await supportLiveScopes({ conversationId: input.id }, guest, service), [`support:thread:${input.id}`]);
  await assert.rejects(supportLiveScopes({ conversationId: input.id }, { secret: "b".repeat(64) }, service));
  await assert.rejects(supportLiveScopes({ guests: [{ id: input.id, secret: "b".repeat(64) }] }, {}, service));
  await assert.rejects(supportLiveScopes({ staff: true }, guest, service));
  await assert.rejects(supportLiveScopes({ guests: Array(21).fill({ id: input.id, secret: guest.secret }) }, {}, service));
  assert.deepEqual(await supportLiveScopes({}, { account: { id: "member", accountAliases: ["old-member"] } }, service), ["support:owner:member", "support:owner:old-member"]);
  assert.deepEqual(await supportLiveScopes({ staff: true }, { account: { id: "staff", status: "active", roles: ["support"] } }, service), ["support:inbox"]);
});

test("multi-scope subscriptions send no ticket data and clean up all listeners", async () => {
  const res = new EventEmitter(); const frames = []; let notify; let removed = 0;
  res.set = () => {}; res.flushHeaders = () => {};
  res.write = frame => { frames.push(frame); return true; };
  res.end = () => { res.writableEnded = true; res.emit("close"); };
  await streamSupport({}, res, ["support:owner:a", "support:owner:b"], async (_key, callback) => {
    notify = callback; return () => { removed++; };
  });
  notify(true);
  assert.equal(frames[1], 'event: changed\ndata: {}\n\n');
  res.end(); assert.equal(removed, 2);
});

test("failed multi-scope subscription cleans up previously registered listeners", async () => {
  const res = new EventEmitter(); let removed = 0;
  await assert.rejects(streamSupport({}, res, ["one", "two"], async key => {
    if (key === "two") throw new Error("offline");
    return () => { removed++; };
  }), /offline/);
  assert.equal(removed, 1);
});

test("activity summaries expose only owned ticket versions and status changes track their author", async () => {
  const { service, guest, input } = setup();
  const account = { id: "member", name: "Test", surname: "Member", email: "member@example.test" };
  await service.create(input, guest);
  const own = await service.create({ ...input, id: randomUUID() }, { account });
  assert.deepEqual(await service.activity({ account }), { conversations: [{ id: own.id, revision: 0, lastAuthor: "requester" }] });
  await assert.rejects(service.activity(guest));
  const staff = { account: { id: "staff", roles: ["support"], status: "active" }, staff: true };
  const resolved = await service.changeStatus(own.id, { revision: 0, status: "resolved" }, staff);
  assert.equal(resolved.lastAuthor, "staff");
  assert.deepEqual(await service.activity({ account }), { conversations: [{ id: own.id, revision: 1, lastAuthor: "staff" }] });
});

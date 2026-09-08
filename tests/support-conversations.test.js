import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSupportService } from "../services/support/conversations.js";
import { authorizeConversation, GUEST_ACCESS_MS, MAX_MESSAGES, normalizeContact, safePagePath, isSupportStaff, supportAttachments, supportEnvironment } from "../services/support/policy.js";
import { consumeSupportLimit } from "../services/support/rate-limit.js";
import { uploadSupportImages } from "../services/support/attachments.js";
import SupportConversation from "../models/SupportConversation.js";
import { memorySupportStore } from "./fixtures/support-store.js";

const member = { _id: "member_test", id: "member_test", name: "Test", surname: "Member", email: "member@example.test", phone: "+31612345678", status: "active", roles: ["member"] };
const admin = { ...member, _id: "staff_test", id: "staff_test", roles: ["admin"] };
const guest = { secret: "a".repeat(64) };
const photo = (name = "one") => ({ type: "image", url: `https://res.cloudinary.com/bgsnl/image/upload/support/report/${name}.webp` });
const createInput = () => ({ id: randomUUID(), subject: "Ticket page problem", text: "The booking button does not respond.", contact: { name: "Test Guest", email: "guest@example.test" }, pagePath: "/events?private=secret#fragment" });
const setup = (options = {}) => { const records = memorySupportStore(); return { records, service: createSupportService({ records, ...options }) }; };

test("guest reports require a name and either valid email or phone", () => {
  assert.deepEqual(normalizeContact({ name: " Guest ", email: " TEST@EXAMPLE.TEST " }), { name: "Guest", email: "test@example.test", phone: "", source: "guest" });
  assert.equal(normalizeContact({ name: "Guest", phone: "+31 6 12345678" }).phone, "+31 6 12345678");
  for (const contact of [{ name: "Guest" }, { name: "", email: "test@example.test" }, { name: "Guest", email: "wrong" }, { name: "Guest", phone: "123" }, { name: "Guest", phone: { $ne: null } }]) assert.throws(() => normalizeContact(contact));
});

test("signed-in reports use server account details and ignore forged identity/status", async () => {
  const { records, service } = setup(); const input = createInput();
  input.ownerAccountId = "victim"; input.status = "closed"; input.roles = ["admin"];
  const report = await service.create(input, { account: member });
  assert.equal(report.status, "open");
  assert.equal(records.data.get(report.id).ownerAccountId, member.id);
  assert.equal(records.data.get(report.id).contact.email, member.email);
  assert.equal(report.contact, undefined);
  assert.equal(report.pagePath, "/events");
});

test("guest secret is hashed at rest and never appears in public/staff responses", async () => {
  const { records, service } = setup(); const report = await service.create(createInput(), guest);
  const stored = records.data.get(report.id);
  assert.equal(stored.guestSecretHash.length, 64); assert.notEqual(stored.guestSecretHash, guest.secret);
  assert.equal(new Date(stored.guestAccessExpiresAt) - new Date(stored.createdAt), GUEST_ACCESS_MS);
  for (const response of [report, await service.get(report.id, { account: admin, staff: true })]) {
    assert.equal(response.guestSecretHash, undefined); assert.equal(response.requestHash, undefined);
    assert.equal(JSON.stringify(response).includes(guest.secret), false);
  }
});

test("ID possession or matching contact email cannot read/reply to another report", async () => {
  const { service } = setup(); const report = await service.create(createInput(), guest);
  for (const actor of [{}, { secret: "b".repeat(64) }, { account: { ...member, email: "guest@example.test" } }, { account: member, staff: true }]) {
    await assert.rejects(service.get(report.id, actor), { statusCode: 404 });
    await assert.rejects(service.reply(report.id, { id: randomUUID(), text: "Unauthorized" }, actor), { statusCode: 404 });
  }
});

test("expired guest access fails, while authorized staff can still follow up", async () => {
  const { records, service } = setup(); const report = await service.create(createInput(), guest);
  records.data.get(report.id).guestAccessExpiresAt = new Date(0);
  await assert.rejects(service.get(report.id, guest), { statusCode: 404 });
  assert.equal((await service.get(report.id, { account: admin, staff: true })).id, report.id);
});

test("membership migration preserves ownership through server account aliases", async () => {
  const { service } = setup(); const report = await service.create(createInput(), { account: member });
  const migrated = { ...member, _id: "alumni_test", id: "alumni_test", accountAliases: [member.id], roles: ["alumni"] };
  assert.equal((await service.get(report.id, { account: migrated })).id, report.id);
  assert.equal((await service.list({ account: migrated })).conversations.length, 1);
});

test("locked members can seek help; inactive staff cannot access the support inbox", async () => {
  const { service } = setup(); const locked = { ...member, status: "locked" };
  const report = await service.create(createInput(), { account: locked });
  assert.equal((await service.get(report.id, { account: locked })).id, report.id);
  assert.equal(isSupportStaff({ ...admin, status: "locked" }), false);
  await assert.rejects(service.list({ account: { ...admin, status: "locked" }, staff: true }), { statusCode: 403 });
});

test("the support role grants support-staff authorization while inactive support users remain denied", () => {
  assert.equal(isSupportStaff({ ...member, roles: ["support"] }), true);
  assert.equal(isSupportStaff({ ...member, status: "locked", roles: ["support"] }), false);
});

test("ticket environment is bounded, stored once, and only exposed to staff", async () => {
  const { records, service } = setup(); const input = createInput();
  input.environment = { browser: "Chrome", platform: "macOS", deviceType: "Desktop", language: "en-GB", timezone: "Europe/Amsterdam",
    viewport: { width: 1440, height: 900 }, screen: { width: 2560, height: 1440 }, devicePixelRatio: 2, touchPoints: 0 };
  const report = await service.create(input, guest, { userAgent: "Test Browser/1.0" });
  assert.equal(report.environment, undefined);
  assert.equal(records.data.get(report.id).environment.userAgent, "Test Browser/1.0");
  const staffView = await service.get(report.id, { account: admin, staff: true });
  assert.equal(staffView.environment.browser, "Chrome");
  assert.deepEqual(staffView.environment.viewport, { width: 1440, height: 900 });
  assert.equal(supportEnvironment({ viewport: { width: 999999, height: "bad" } }, "\u0000Agent").viewport.width, undefined);
});

test("a new-ticket notification is emitted once and not on an idempotent create replay", async () => {
  const notifications = []; const { service } = setup({ notifyNewTicket: (ticket) => notifications.push(ticket) });
  const input = createInput();
  await service.create(input, guest); await service.create(input, guest);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].contact.email, "guest@example.test");
  assert.equal(notifications[0].reference, input.id.slice(0, 8).toUpperCase());
});

test("create retries and concurrent duplicate submissions create one conversation", async () => {
  const { records, service } = setup(); const input = createInput();
  const reports = await Promise.all([service.create(input, guest), service.create(input, guest)]);
  assert.equal(reports[0].id, reports[1].id); assert.equal(records.data.size, 1);
  await assert.rejects(service.create({ ...input, text: "Different payload" }, guest), { statusCode: 409 });
  await assert.rejects(service.create(input, { secret: "b".repeat(64) }), { statusCode: 404 });
});

test("reply retries are idempotent and concurrent distinct replies are not lost", async () => {
  const { records, service } = setup(); const report = await service.create(createInput(), guest);
  const message = { id: randomUUID(), text: "More detail", author: "staff", status: "closed" };
  await Promise.all([service.reply(report.id, message, guest), service.reply(report.id, message, guest)]);
  assert.equal(records.data.get(report.id).messageCount, 2);
  assert.equal(records.data.get(report.id).messages[1].author, "requester");
  await Promise.all(["A", "B", "C"].map((text) => service.reply(report.id, { id: randomUUID(), text }, guest)));
  assert.equal(records.data.get(report.id).messageCount, 5);
  await assert.rejects(service.reply(report.id, { ...message, text: "Changed content" }, guest), { statusCode: 409 });
});

test("replies accept up to three Cloudinary photos, including a photo-only message", async () => {
  const { service } = setup(); const report = await service.create(createInput(), guest);
  const message = { id: randomUUID(), text: "", attachments: [photo()] };
  const current = await service.reply(report.id, message, guest);
  assert.equal(current.messages.at(-1).text, "");
  assert.deepEqual(current.messages.at(-1).attachments, message.attachments);
  assert.equal((await service.reply(report.id, message, guest)).messageCount, 2);
  await assert.rejects(service.reply(report.id, { ...message, attachments: [photo("different")] }, guest), { statusCode: 409 });
  await assert.rejects(service.reply(report.id, { id: randomUUID(), text: "", attachments: [] }, guest), { statusCode: 422 });
});

test("attachment policy accepts only bounded HTTPS Cloudinary image URLs", () => {
  assert.deepEqual(supportAttachments([photo()]), [photo()]);
  for (const attachments of [
    Array.from({ length: 4 }, (_, index) => photo(String(index))),
    [{ type: "file", url: photo().url }],
    [{ type: "image", url: "https://attacker.test/photo.webp" }],
    [{ type: "image", url: "http://res.cloudinary.com/bgsnl/image/upload/photo.webp" }],
    [{ type: "image", url: "not-a-url" }],
  ]) assert.throws(() => supportAttachments(attachments));
});

test("support uploads use content-addressed names in the conversation support folder", async () => {
  const conversationId = randomUUID(); const messageId = randomUUID(); const calls = [];
  const files = [{ buffer: Buffer.from("same photo"), mimetype: "image/png" }];
  const upload = async (_file, options) => {
    calls.push(options);
    return `https://res.cloudinary.com/bgsnl/image/upload/v123/${options.folder}/${options.public_id}.webp`;
  };
  const first = await uploadSupportImages(files, { conversationId, messageId, upload });
  const retry = await uploadSupportImages(files, { conversationId, messageId, upload });
  assert.deepEqual(first, retry);
  assert.equal(first[0].url.includes("/v123/"), false);
  assert.equal(calls[0].folder, `support/${conversationId}`);
  assert.match(calls[0].public_id, new RegExp(`^${messageId}-1-[0-9a-f]{20}$`));
  assert.equal(calls[0].resource_type, "image");
  assert.equal(calls[0].format, "webp");
});

test("staff replies request a response; requester replies reopen a resolved report", async () => {
  const { service } = setup(); const report = await service.create(createInput(), guest);
  const staff = { account: admin, staff: true };
  let current = await service.reply(report.id, { id: randomUUID(), text: "Could you tell us which browser?" }, staff);
  assert.equal(current.status, "waiting_for_you");
  current = await service.changeStatus(report.id, { status: "resolved", revision: current.revision }, guest);
  assert.equal(current.messages.at(-1).kind, "status");
  current = await service.reply(report.id, { id: randomUUID(), text: "It still occurs." }, guest);
  assert.equal(current.status, "open");
});

test("status edits cannot overwrite concurrent replies and closed reports reject new messages", async () => {
  const { service } = setup(); const report = await service.create(createInput(), guest);
  const current = await service.reply(report.id, { id: randomUUID(), text: "Another detail" }, guest);
  await assert.rejects(service.changeStatus(report.id, { status: "closed", revision: report.revision }, { account: admin, staff: true }), { statusCode: 409 });
  await assert.rejects(service.changeStatus(report.id, { status: "in_progress", revision: current.revision }, guest), { statusCode: 403 });
  await service.changeStatus(report.id, { status: "closed", revision: current.revision }, { account: admin, staff: true });
  await assert.rejects(service.reply(report.id, { id: randomUUID(), text: "Later" }, guest), { statusCode: 409 });
  await assert.rejects(service.changeStatus(report.id, { status: "open", revision: current.revision + 1 }, guest), { statusCode: 403 });
});

test("thread growth and reads are bounded; older messages are paginated", async () => {
  const { records, service } = setup(); const report = await service.create(createInput(), guest);
  const raw = records.data.get(report.id);
  raw.messages = Array.from({ length: MAX_MESSAGES }, (_, index) => ({ id: randomUUID(), text: String(index), author: "requester", kind: "message", createdAt: new Date() }));
  raw.messageCount = MAX_MESSAGES;
  const latest = await service.get(report.id, guest);
  assert.equal(latest.messages.length, 50); assert.equal(latest.before, 150); assert.equal(latest.messages[0].order, 150);
  const earlier = await service.get(report.id, guest, { before: latest.before });
  assert.equal(earlier.messages[0].order, 100);
  await assert.rejects(service.reply(report.id, { id: randomUUID(), text: "Full" }, guest), { statusCode: 409 });
  await assert.rejects(service.get(report.id, guest, { before: "bad" }), { statusCode: 422 });
});

test("list responses exclude message bodies and enforce owner/staff scopes", async () => {
  const { service } = setup(); await service.create(createInput(), guest); await service.create(createInput(), { account: member });
  const own = await service.list({ account: member });
  assert.equal(own.conversations.length, 1); assert.equal(own.conversations[0].messages, undefined); assert.equal(own.conversations[0].contact, undefined);
  assert.equal((await service.list({ account: admin, staff: true })).conversations.length, 2);
  await assert.rejects(service.list({}), { statusCode: 403 });
  await assert.rejects(service.list({ account: member }, { page: "-1" }), { statusCode: 422 });
  await assert.rejects(service.list({ account: admin, staff: true }, { status: { $ne: null } }), { statusCode: 422 });
});

test("URLs exclude queries, fragments and account-access tokens", () => {
  assert.equal(safePagePath("/user?token=private#profile"), "/user");
  assert.equal(safePagePath("/reset-password/secret-token"), "/[account-access-page]");
  assert.throws(() => safePagePath("https://external.test")); assert.throws(() => safePagePath("//external.test"));
});

test("inbox pagination and status filters keep result sizes bounded", async () => {
  const { service } = setup(); const staff = { account: admin, staff: true };
  for (let index = 0; index < 27; index++) await service.create(createInput(), { account: member });
  const first = await service.list(staff);
  assert.equal(first.conversations.length, 25); assert.equal(first.hasMore, true);
  const second = await service.list(staff, { page: "2" });
  assert.equal(second.conversations.length, 2); assert.equal(second.hasMore, false);
  assert.equal(first.conversations.some(({ id }) => second.conversations.some((item) => item.id === id)), false);
  const record = first.conversations[0];
  await service.changeStatus(record.id, { revision: record.revision, status: "in_progress" }, staff);
  assert.equal((await service.list(staff, { status: "in_progress" })).conversations.length, 1);
});

test("malformed content and honeypot submissions are rejected", async () => {
  const { service, records } = setup();
  for (const patch of [{ subject: { $ne: null } }, { text: "a".repeat(4001) }, { text: "\u0000bad" }, { website: "spam" }, { id: "not-a-uuid" }]) await assert.rejects(service.create({ ...createInput(), ...patch }, guest));
  assert.equal(records.data.size, 0);
  assert.throws(() => authorizeConversation(null, guest), { statusCode: 404 });
});

test("shared database rate limits survive insert races and fail closed", async () => {
  let count = 0; let raced = false; const ids = [];
  const limits = { async findOneAndUpdate(filter, update, options) {
    ids.push(filter._id); if (options?.upsert && !raced) { raced = true; throw Object.assign(new Error("Race"), { code: 11000 }); }
    count += update.$inc.count; return { count };
  } };
  await consumeSupportLimit("private@example.test", 1, 60000, { limits, now: 1000 });
  await assert.rejects(consumeSupportLimit("private@example.test", 1, 60000, { limits, now: 1000 }), { statusCode: 429 });
  assert.ok(ids.every((id) => !id.includes("private@example.test")));
});

test("Mongo schema provides bounded chat fields and indexed owner/inbox lookups", () => {
  const schema = SupportConversation.schema;
  assert.equal(schema.path("guestSecretHash").options.select, false);
  assert.ok(schema.indexes().some(([index]) => index.ownerAccountId === 1 && index.lastMessageAt === -1));
  assert.ok(schema.indexes().some(([index]) => index.status === 1));
  const invalid = new SupportConversation({ _id: randomUUID(), subject: "a".repeat(141), status: "forged" });
  assert.ok(invalid.validateSync().errors.subject); assert.ok(invalid.validateSync().errors.status);
  const tooManyPhotos = new SupportConversation({ _id: randomUUID(), subject: "Photos", status: "open", messages: [{
    id: randomUUID(), author: "requester", kind: "message", text: "", createdAt: new Date(),
    attachments: Array.from({ length: 4 }, (_, index) => photo(String(index))),
  }] });
  assert.ok(tooManyPhotos.validateSync().errors["messages.0.attachments"]);
});

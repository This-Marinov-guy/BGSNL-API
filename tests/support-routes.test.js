import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildReq } from "../util/logging/axiom-log-models.js";
import { createSupportRouter, requireSupportOrigin, supportPrivacy, supportError } from "../routes/support-routes.js";
import { createSupportService } from "../services/support/conversations.js";
import { memorySupportStore } from "./fixtures/support-store.js";

test("support privacy headers cover both versioned and legacy paths, without marketing capture", () => {
  for (const path of ["/api/support/conversations", "/api/v1/support/conversations", "/api/v2/support/inbox"]) {
    const req = { path, method: "POST", originalUrl: `${path}?secret=do-not-log`, body: { text: "Private report", contact: { email: "private@example.test" } }, headers: {} };
    const headers = {}; const res = { locals: {}, set: (key, value) => { headers[key] = value; } };
    supportPrivacy(req, res, () => {});
    assert.equal(headers["Cache-Control"], "private, no-store"); assert.equal(res.locals.skipMarketingCapture, true);
    assert.deepEqual(buildReq(req, (value) => value), { method: "POST", url: "/api/support", path: "/api/support" });
  }
});

test("cross-site/form writes are rejected, same-origin JSON writes pass", () => {
  for (const [origin, json, allowed] of [["https://www.bulgariansociety.nl", true, true], ["https://attacker.test", true, false], ["https://www.bulgariansociety.nl", false, false], [undefined, true, false]]) {
    let error;
    requireSupportOrigin({ method: "POST", headers: { origin }, is: () => json }, {}, (value) => { error = value; });
    assert.equal(!error, allowed);
  }
  let multipartError;
  requireSupportOrigin({ method: "POST", headers: { origin: "https://www.bulgariansociety.nl" }, is: (types) => types.includes("multipart/form-data") }, {}, (value) => { multipartError = value; });
  assert.equal(multipartError, undefined);
});

test("private parser and upstream errors cannot expose bodies in responses or generic logs", () => {
  for (const [type, expectedStatus] of [["entity.parse.failed", 400], ["entity.too.large", 413], ["unknown", 503]]) {
    let status; let payload; let forwarded = false;
    supportError(Object.assign(new Error("Private report content and contact details"), { type, body: "private" }), { supportPrivate: true }, {
      status(value) { status = value; return this; }, json(value) { payload = value; },
    }, () => { forwarded = true; });
    assert.equal(status, expectedStatus); assert.equal(forwarded, false);
    assert.equal(JSON.stringify(payload).includes("Private report"), false);
  }
  let status; let payload;
  supportError(Object.assign(new Error("private filename"), { name: "MulterError", code: "LIMIT_FILE_SIZE", field: "images" }), { supportPrivate: true }, {
    status(value) { status = value; return this; }, json(value) { payload = value; },
  }, () => {});
  assert.equal(status, 422); assert.equal(payload.errors.images, "File must not exceed 5 MB");
});

// Invoke the real Express router without opening ports or connecting to Mongo.
async function request(router, { method = "GET", url = "/conversations", body = {}, secret, account } = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, url, originalUrl: url, body, account, query: {}, headers: { origin: "https://www.bulgariansociety.nl", "user-agent": "Route Browser/2.0", ...(secret ? { "x-support-token": secret } : {}) },
      get: (name) => req.headers[name.toLowerCase()], is: () => true };
    const res = { locals: {}, statusCode: 200, setHeader() {}, status(value) { this.statusCode = value; return this; }, json(value) { resolve({ status: this.statusCode, body: value }); return this; } };
    router.handle(req, res, (error) => error ? resolve({ status: error.statusCode, body: { message: error.message } }) : reject(new Error("Route did not handle request")));
  });
}

test("real routes save/read/reply as guest, deny staff routes, and hide database failures", async () => {
  const records = memorySupportStore(); const service = createSupportService({ records });
  const router = createSupportRouter({ service, throttle: async () => {} });
  const id = randomUUID(); const secret = "a".repeat(64);
  const result = await request(router, { method: "POST", secret, body: { id, subject: "Problem", text: "Test report", contact: { name: "Guest", phone: "+31612345678" }, pagePath: "/" } });
  assert.equal(result.status, 201);
  assert.equal(records.data.get(id).environment.userAgent, "Route Browser/2.0");
  assert.equal((await request(router, { url: `/conversations/${id}`, secret })).body.conversation.id, id);
  assert.equal((await request(router, { url: `/conversations/${id}` })).status, 404);
  assert.equal((await request(router, { url: "/inbox", secret })).status, 403);
  const reply = await request(router, { method: "POST", url: `/conversations/${id}/messages`, secret, body: { id: randomUUID(), text: "More detail", author: "staff" } });
  assert.equal(reply.body.conversation.messages.at(-1).author, "requester");
  const broken = createSupportRouter({ service: { list: async () => { throw new Error("Private DB connection and report contents"); } }, throttle: async () => {} });
  const failure = await request(broken);
  assert.equal(failure.status, 503); assert.equal(JSON.stringify(failure).includes("Private DB"), false);
});

test("message routes ignore forged attachment URLs and retain only server-uploaded photos", async () => {
  const records = memorySupportStore(); const service = createSupportService({ records });
  const uploaded = { type: "image", url: "https://res.cloudinary.com/bgsnl/image/upload/support/report/server.webp" };
  const router = createSupportRouter({ service, throttle: async () => {}, uploadImages: async () => [uploaded] });
  const id = randomUUID(); const secret = "a".repeat(64);
  await request(router, { method: "POST", secret, body: { id, subject: "Problem", text: "Test report", contact: { name: "Guest", phone: "+31612345678" }, pagePath: "/" } });
  const reply = await request(router, { method: "POST", url: `/conversations/${id}/messages`, secret, body: {
    id: randomUUID(), text: "Screenshot", attachments: [{ type: "image", url: "https://attacker.test/forged.webp" }],
  } });
  assert.deepEqual(reply.body.conversation.messages.at(-1).attachments, [uploaded]);
});

test("an active support-role account can use the staff inbox without broader admin roles", async () => {
  const records = memorySupportStore(); const service = createSupportService({ records });
  const router = createSupportRouter({ service, throttle: async () => {} });
  const account = { _id: "support_only", id: "support_only", status: "active", roles: ["support"] };
  const response = await request(router, { url: "/inbox", account });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.conversations, []);
});

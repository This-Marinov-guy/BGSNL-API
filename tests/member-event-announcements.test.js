import { createEmailRunGuard } from "../services/background-services/email-run-guard.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildMemberEventEmail, announcementWorkerEnabled, processMemberEventAnnouncements } from "../services/events/member-event-announcements.js";
import { createMemberEventLink, verifyMemberEventLink, isCurrentEventMember, memberEventPrice, memberEventPreferencesUrl } from "../services/events/member-event-links.js";
import { createMemberEventCheckoutHandler } from "../controllers/member-event-checkout-controller.js";
import { buildReq } from "../util/logging/axiom-log-models.js";
import { ACCESS_4, MEMBER_EVENT_ANNOUNCEMENT_TEMPLATE } from "../util/config/defines.js";

const env = { JWT_STRING: "test-secret-only-".repeat(4), NODE_ENV: "test" };
const event = { _id: "a".repeat(24), region: "groningen", slug: "autumn-meetup", title: 'Meet <friends> & "dance"', description: "An evening together", status: "opened", date: new Date("2099-10-20T17:00:00Z"), ticketTimer: new Date("2099-10-20T16:00:00Z"), location: "Groningen", ticketLimit: 20, guestList: [], product: { member: { price: 8, priceId: "price_member" }, activeMember: { price: 5, priceId: "price_active" }, guest: { price: 12, priceId: "price_guest" } }, memberAnnouncementQueuedAt: new Date("2026-09-11") };
const member = { _id: `member_${"b".repeat(24)}`, email: "mila@example.test", name: "Mila <test>", status: "active", roles: ["member"], expireDate: new Date("2099-12-01") };
const makeLink = (e = event, m = member) => createMemberEventLink(e, m, { env });
const paramsFor = (e = event, m = member) => ({ token: new URL(makeLink(e, m)).searchParams.get("token") });

test("event links bind prefixed member IDs, event, email and expiry without creating login tokens", () => {
  const values = paramsFor();
  const claims = verifyMemberEventLink(values, { env });
  assert.equal(claims.memberId, member._id);
  assert.equal(claims.eventId, event._id);
  assert.equal(claims.exp, event.ticketTimer.getTime());
  assert.notEqual(claims.email, member.email);
  assert.equal(claims.token_use, undefined);
  for (const changed of [{ token: `${values.token.slice(0, -8)}modified` }, { token: [] }]) {
    assert.throws(() => verifyMemberEventLink({ ...values, ...changed }, { env }), /invalid or has expired/);
  }
  assert.throws(() => verifyMemberEventLink(values, { env, now: claims.exp }), /expired/);
  assert.throws(() => verifyMemberEventLink(values, { env: { JWT_STRING: "other-secret".repeat(5) } }), /invalid/);
  assert.throws(() => createMemberEventLink(event, member, { env: {} }));
});

test("link destination requires a safe configured API origin", () => {
  assert.throws(() => createMemberEventLink(event, member, { env: { ...env, EVENT_ANNOUNCEMENT_API_URL: "javascript:bad" } }), /Invalid/);
  assert.throws(() => createMemberEventLink(event, member, { env: { ...env, NODE_ENV: "production", EVENT_ANNOUNCEMENT_API_URL: "http://api.example.test" } }), /Invalid/);
  assert.match(makeLink(), /^https:\/\/kanatitsa.bulgariansociety.nl\/api\/v1\/payment\/event-ticket\?token=e1\./);
});

test("recipient eligibility requires an active non-expired membership", () => {
  assert.equal(isCurrentEventMember(member), true);
  for (const patch of [{ status: "locked" }, { status: "membership-migrated" }, { expireDate: new Date(0) }, { roles: ["alumni"] }]) assert.equal(isCurrentEventMember({ ...member, ...patch }), false);
});

test("email targets the Domakin Mailer template with event details and matching member price", () => {
  const email = buildMemberEventEmail({ event, member, ticketUrl: makeLink() });
  assert.equal(email.templateId, MEMBER_EVENT_ANNOUNCEMENT_TEMPLATE);
  assert.equal(email.templateVariables.name, "Mila <test>");
  assert.equal(email.templateVariables.location, "Groningen");
  assert.match(email.templateVariables.priceLabel, /8\.00/);
  assert.match(email.templateVariables.viewUrl, /autumn-meetup/);
  assert.match(email.templateVariables.ticketUrl, /^https:\/\//);
  assert.equal(memberEventPrice(event, { ...member, roles: [ACCESS_4[0]] }).price, 5);
  assert.equal(memberEventPrice({ ...event, isMemberFree: true }, member).price, 0);
  const promoted = { ...event, promotion: { member: { isEnabled: true, startTimer: new Date(0), endTimer: new Date("2099-01-01"), discount: 25, priceId: "discount" } } };
  assert.equal(memberEventPrice(promoted, member).price, 6);
  assert.equal(event.product.member.price, 8);
});

function workerHarness() {
  const runGuard = createEmailRunGuard();
  const calls = { sent: [], eventQueries: [], memberQueries: [], completed: [] };
  const dependencies = {
    enabled: true,
    EventModel: { find(query) { calls.eventQueries.push(query); return { limit: async () => [event] }; }, updateOne: async (...args) => calls.completed.push(args) },
    MemberModel: { find(query) { calls.memberQueries.push(query); return { select: () => ({ lean: async () => [member, { ...member, _id: 'duplicate', email: member.email.toUpperCase() }, { ...member, _id: 'expired', email: 'expired@example.test', expireDate: new Date(0) }] }) }; } },
    runGuard,
    makeLink,
    send: async (message) => calls.sent.push(message),
  };
  return { dependencies, calls };
}

test("worker is production-only by default and requires explicit publication markers", async () => {
  assert.equal(announcementWorkerEnabled({ NODE_ENV: "production" }), true);
  assert.equal(announcementWorkerEnabled({ NODE_ENV: "test" }), false);
  assert.equal(announcementWorkerEnabled({ NODE_ENV: "production", EVENT_ANNOUNCEMENTS_ENABLED: "false" }), false);
  const h = workerHarness();
  assert.deepEqual(await processMemberEventAnnouncements({ ...h.dependencies, enabled: false }), { sent: 0, failed: 0, skipped: 0 });
  assert.equal(h.calls.sent.length, 0);
  await processMemberEventAnnouncements(h.dependencies);
  assert.equal(h.calls.eventQueries[0].memberAnnouncementQueuedAt.$exists, true);
  assert.equal(h.calls.eventQueries[0].memberAnnouncementCompletedAt.$exists, false);
  assert.deepEqual(h.calls.eventQueries[0].status.$nin, ["draft", "archived"]);
  assert.equal(h.calls.memberQueries[0].status, "active");
  assert.ok(h.calls.memberQueries[0].$or[0].expireDate.$gt instanceof Date);
});

test("repeated and concurrent worker runs within one process send once per inbox", async () => {
  const h = workerHarness();
  await Promise.all([processMemberEventAnnouncements(h.dependencies), processMemberEventAnnouncements(h.dependencies)]);
  await processMemberEventAnnouncements(h.dependencies);
  assert.equal(h.calls.sent.length, 1);
});

test("ambiguous email failure is not repeated within the same process", async () => {
  const h = workerHarness();
  let sends = 0;
  h.dependencies.send = async () => { sends++; throw new Error("timeout"); };
  assert.equal((await processMemberEventAnnouncements(h.dependencies)).failed, 1);
  await processMemberEventAnnouncements(h.dependencies);
  assert.equal(sends, 1);
});

function checkoutHarness({ eventRecord = event, account = member, reconcile, checkout, result = { url: "https://checkout.stripe.com/c/pay/test" } } = {}) {
  const values = paramsFor();
  const calls = { reads: 0, checkout: [], errors: [], headers: {} };
  const handler = createMemberEventCheckoutHandler({
    verify: (input) => verifyMemberEventLink(input, { env }),
    preferencesUrl: (e, m) => memberEventPreferencesUrl(e, m, { env }),
    EventModel: { async findById() { calls.reads++; return structuredClone(eventRecord); } },
    MemberModel: { async findById() { calls.reads++; return structuredClone(account); } },
    reconcile: reconcile || (async (user) => ({ user })),
    checkout: async (req, res, next) => {
      calls.checkout.push(req);
      if (checkout) return checkout(req, res, next);
      return res.status(200).json(typeof result === "function" ? result(req) : result);
    },
  });
  const res = { set(key, value) { Object.assign(calls.headers, typeof key === "object" ? key : { [key]: value }); return this; }, status(code) { calls.status = code; return this; }, end() { calls.ended = true; return this; } };
  const req = { method: "GET", params: {}, query: { token: values.token }, body: { userId: "attacker", normalTicket: true } };
  const run = () => handler(req, res, (error) => calls.errors.push(error));
  return { calls, req, run };
}

test("personal email link skips login and redirects trusted member checkout to Stripe", async () => {
  const h = checkoutHarness(); await h.run();
  assert.equal(h.calls.errors.length, 0);
  assert.equal(h.calls.status, 303);
  assert.equal(h.calls.headers.Location, "https://checkout.stripe.com/c/pay/test");
  assert.equal(h.calls.headers["Referrer-Policy"], "no-referrer");
  const request = h.calls.checkout[0];
  assert.equal(request.user.userId, member._id);
  assert.equal(request.body.eventId, event._id);
  assert.equal(request.body.quantity, 1);
  assert.equal(request.body.normalTicket, false);
  assert.equal(request.body.method, "buy_member_ticket");
  assert.equal(request.emailTicketCheckout, true);
});

test("HEAD and modified links never create a checkout or load account details", async () => {
  const head = checkoutHarness(); head.req.method = "HEAD"; await head.run();
  assert.equal(head.calls.status, 204); assert.equal(head.calls.reads, 0);
  const bad = checkoutHarness(); bad.req.query.token = `${bad.req.query.token.slice(0, -8)}modified`; await bad.run();
  assert.equal(bad.calls.reads, 0); assert.equal(bad.calls.checkout.length, 0); assert.equal(bad.calls.errors.length, 1);
});

test("changed email, expired account and revoked subscription benefits stop checkout", async () => {
  for (const account of [{ ...member, email: "new@example.test" }, { ...member, expireDate: new Date(0) }, { ...member, status: "frozen" }]) {
    const h = checkoutHarness({ account }); await h.run(); assert.equal(h.calls.checkout.length, 0); assert.equal(h.calls.errors.length, 1);
  }
  const h = checkoutHarness({ reconcile: async (user) => ({ user: { ...user, subscription: { id: "sub_test", hasBenefits: false, syncedAt: new Date() } } }) });
  await h.run(); assert.equal(h.calls.checkout.length, 0); assert.equal(h.calls.errors.length, 1);
});

test("sold-out, hidden, closed and expired events cannot start payment", async () => {
  for (const patch of [{ ticketLimit: 0 }, { hidden: true }, { status: "draft" }, { status: "archived" }, { isSaleClosed: true }, { ticketTimer: new Date(0) }, { date: new Date(0) }]) {
    const h = checkoutHarness({ eventRecord: { ...event, ...patch } }); await h.run();
    assert.equal(h.calls.checkout.length, 0); assert.equal(h.calls.status, 303);
  }
});

test("events requiring choices use the scoped preferences page and late duplicates retry as guests", async () => {
  for (const patch of [{ extraInputsForm: [{ name: "meal" }] }, { addOns: { isEnabled: true, isMandatory: true } }, { ticketLink: "https://tickets.example.test" }]) {
    const h = checkoutHarness({ eventRecord: { ...event, ...patch } }); await h.run();
    assert.equal(h.calls.checkout.length, 0); assert.match(h.calls.headers.Location, patch.ticketLink ? /purchase-ticket/ : /payment\/event-ticket\/start\?token=e1\./);
  }
  const duplicate = checkoutHarness({ result: (req) => req.body.method === "buy_member_ticket"
    ? { alreadyRegistered: true } : { url: "https://checkout.stripe.com/c/pay/guest" } }); await duplicate.run();
  assert.equal(duplicate.calls.checkout.length, 2);
  assert.equal(duplicate.calls.checkout[1].body.method, "buy_guest_ticket");
  assert.equal(duplicate.calls.headers.Location, "https://checkout.stripe.com/c/pay/guest");
});

test("free email tickets use the checkout adapter and unsafe redirect destinations are rejected", async () => {
  const free = checkoutHarness({ eventRecord: { ...event, isMemberFree: true } }); await free.run();
  assert.equal(free.calls.checkout[0].emailTicketCheckout, true);
  const bad = checkoutHarness({ result: { url: "https://attacker.example" } }); await bad.run();
  assert.equal(bad.calls.errors.length, 1); assert.equal(bad.calls.headers.Location, undefined);
});

test("ticket capabilities and member information are excluded from request logs", () => {
  const values = paramsFor();
  const logged = buildReq({ method: "GET", originalUrl: new URL(makeLink()).pathname + `?token=${values.token}`, query: { token: values.token } });
  assert.deepEqual(logged, { method: "GET", url: "/api/payment/event-ticket", path: "/api/payment/event-ticket" });
});

test("both publication paths save the announcement marker atomically with the event", () => {
  const source = readFileSync(new URL("../controllers/Events/future-events-action-controller.js", import.meta.url), "utf8");
  assert.equal((source.match(/new Event\(\{\s*memberAnnouncementQueuedAt: new Date\(\)/g) || []).length, 2);
});

test("real ticket controller prefills member email, preserves fulfillment metadata and confirms free tickets in Stripe", async () => {
  const { postCheckoutFile } = await import("../controllers/payments-controllers.js");
  for (const free of [false, true]) {
    const e = { ...event, isMemberFree: free };
    const calls = {};
    const req = { emailTicketCheckout: true, account: member, user: { userId: member._id }, body: { eventId: event._id, origin_url: "https://bulgariansociety.nl", method: "buy_member_ticket", quantity: 1, code: 123456789, addOns: "[]" } };
    const res = { status() { return this; }, json(result) { calls.result = result; return result; } };
    await postCheckoutFile(req, res, (error) => { throw error; }, {
      loadEvent: async () => e,
      reconcile: async (user) => ({ user }),
      generateTicket: async (data) => { calls.ticket = data; return "https://tickets.example.test/test.png"; },
      resolvePrice: async () => { assert.equal(free, false); return "price_member"; },
      stripeForRegion: (region) => { assert.equal(region, event.region); return {}; },
      createCheckout: async (data) => { calls.checkout = data; return { url: "https://checkout.stripe.com/c/pay/test" }; },
    });
    assert.equal(calls.checkout.checkoutType, "member");
    assert.equal(calls.checkout.userId, member._id);
    assert.equal(calls.ticket.memberUser.email, member.email);
    const data = calls.checkout.checkoutData;
    assert.equal(data.customer_email, member.email);
    assert.equal(data.metadata.userId, member._id);
    assert.equal(data.metadata.eventId, event._id);
    assert.equal(data.metadata.method, "buy_member_ticket");
    assert.equal(data.metadata.memberPriceApplied, "true");
    assert.ok(Number.isSafeInteger(data.metadata.code));
    assert.equal(data.metadata.code, calls.ticket.code);
    assert.notEqual(data.metadata.code, 123456789);
    assert.equal(data.metadata.file, "https://tickets.example.test/test.png");
    if (free) assert.equal(data.line_items[0].price_data.unit_amount, 0);
    else assert.equal(data.line_items[0].price, "price_member");
  }
});

test("production firewall admits encrypted email navigation without website Origin, but rejects forgery and other routes", async () => {
  const { firewall } = await import("../middleware/firewall.js");
  const previous = process.env.EVENT_TICKET_LINK_SECRET;
  process.env.EVENT_TICKET_LINK_SECRET = env.JWT_STRING;
  try {
    const url = new URL(makeLink());
    const req = { method: "GET", path: url.pathname, headers: {}, query: { token: url.searchParams.get("token") } };
    let result = "not-called";
    firewall(req, {}, (error) => { result = error; });
    assert.equal(result, undefined);
    for (const patch of [{ method: "POST" }, { path: "/api/v1/payment/checkout/member-ticket" }, { path: `/api/v1/payment/event-ticket/${event._id}/${member._id}` }, { query: { token: "forged" } }]) {
      firewall({ ...req, ...patch }, {}, (error) => { result = error; });
      assert.equal(result.statusCode, 403);
    }
  } finally {
    if (previous === undefined) delete process.env.EVENT_TICKET_LINK_SECRET;
    else process.env.EVENT_TICKET_LINK_SECRET = previous;
  }
});


test("encrypted links hide both IDs even after Base64 decoding and use a fresh IV every time", () => {
  const first = new URL(makeLink());
  const second = new URL(makeLink());
  assert.equal(first.pathname, "/api/v1/payment/event-ticket");
  assert.deepEqual([...first.searchParams.keys()], ["token"]);
  const token = first.searchParams.get("token");
  const other = second.searchParams.get("token");
  assert.notEqual(token, other);
  assert.equal(first.href.includes(event._id), false);
  assert.equal(first.href.includes(member._id), false);
  const bytes = Buffer.from(token.split(".")[1], "base64url");
  const otherBytes = Buffer.from(other.split(".")[1], "base64url");
  assert.equal(bytes.includes(Buffer.from(event._id)), false);
  assert.equal(bytes.includes(Buffer.from(member._id)), false);
  assert.equal(bytes.includes(Buffer.from(member.email)), false);
  assert.notDeepEqual(bytes.subarray(0, 12), otherBytes.subarray(0, 12));
  assert.deepEqual(verifyMemberEventLink({ token }, { env }), verifyMemberEventLink({ token: other }, { env }));
});

test("changing any part of the IV, ciphertext or authentication tag rejects the encrypted link", () => {
  const { token } = paramsFor();
  const packed = Buffer.from(token.split(".")[1], "base64url");
  for (const position of [0, 11, 12, packed.length - 17, packed.length - 16, packed.length - 1]) {
    const changed = Buffer.from(packed);
    changed[position] ^= 1;
    assert.throws(() => verifyMemberEventLink({ token: `e1.${changed.toString("base64url")}` }, { env }), /invalid or has expired/);
  }
});

test("unsupported, truncated, non-canonical, malformed and legacy signed tokens fail closed", () => {
  const { token } = paramsFor();
  const claims = verifyMemberEventLink({ token }, { env });
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", env.JWT_STRING).update(`event-ticket:${payload}`).digest("base64url");
  const invalidTokens = [undefined, null, [], "", "e1.", `e2.${token.split(".")[1]}`, token.slice(0, -8), `${token}=`, "e1.!", `e1.${"a".repeat(1500)}`, `${payload}.${signature}`];
  for (const value of invalidTokens) assert.throws(() => verifyMemberEventLink({ token: value }, { env }), /invalid or has expired/);
});

test("caller-supplied IDs cannot override the authenticated encrypted member and event", async () => {
  const h = checkoutHarness();
  h.req.params = { eventId: "c".repeat(24), memberId: `member_${"d".repeat(24)}` };
  h.req.query.eventId = "c".repeat(24);
  h.req.query.memberId = `member_${"d".repeat(24)}`;
  await h.run();
  assert.equal(h.calls.errors.length, 0);
  assert.equal(h.calls.checkout[0].body.eventId, event._id);
  assert.equal(h.calls.checkout[0].user.userId, member._id);
});


test("email ticket links create guest checkout for existing Member, guest and aliased tickets", async () => {
  const account = { ...member, accountAliases: ["former_member"] };
  for (const ticket of [
    { type: "member", userId: member._id },
    { type: "guest", email: member.email.toUpperCase() },
    { type: "member", userId: "former_member" },
    { type: "member", email: ` ${member.email} `, memberPriceApplied: false },
  ]) {
    const h = checkoutHarness({ account, eventRecord: { ...event, guestList: [ticket] } });
    await h.run();
    assert.equal(h.calls.checkout.length, 1);
    assert.equal(h.calls.checkout[0].body.method, "buy_guest_ticket");
    assert.equal(h.calls.errors.length, 0);
    assert.equal(h.calls.status, 303);
    assert.equal(h.calls.headers.Location, "https://checkout.stripe.com/c/pay/test");
    assert.ok(!h.calls.headers.Location.includes(member._id));
    assert.ok(!h.calls.headers.Location.includes(h.req.query.token));
  }
});

test("refunded tickets and another member's ticket do not block an email purchase", async () => {
  for (const ticket of [
    { type: "member", userId: member._id, refunded: true },
    { type: "guest", email: member.email, refunded: true },
    { type: "member", userId: "someone_else", email: "someone_else@example.test" },
  ]) {
    const h = checkoutHarness({ eventRecord: { ...event, guestList: [ticket] } });
    await h.run();
    assert.equal(h.calls.checkout.length, 1);
    assert.equal(h.calls.checkout[0].body.method, "buy_member_ticket");
    assert.equal(h.calls.headers.Location, "https://checkout.stripe.com/c/pay/test");
  }
});

test("existing ticket holders still obey closed sales, event choices and membership checks", async () => {
  const purchased = { ...event, guestList: [{ type: "member", userId: member._id }] };
  for (const patch of [{ isSaleClosed: true }, { extraInputsForm: [{ name: "meal" }] }, { ticketLimit: 0 }]) {
    const h = checkoutHarness({ eventRecord: { ...purchased, ...patch } });
    await h.run();
    assert.equal(h.calls.checkout.length, 0);
    assert.equal(h.calls.status, 303);
    assert.ok(!h.calls.headers.Location.includes("ticketError"));
  }
  const expired = checkoutHarness({ account: { ...member, expireDate: new Date(0) }, eventRecord: purchased });
  await expired.run();
  assert.equal(expired.calls.checkout.length, 0);
  assert.equal(expired.calls.errors[0].code, 403);
});

test("guest fallback is bounded and rejects unsafe Stripe redirects", async () => {
  const duplicate = checkoutHarness({ result: { alreadyRegistered: true } });
  await duplicate.run();
  assert.equal(duplicate.calls.checkout.length, 2);
  assert.equal(duplicate.calls.errors.length, 1);
  assert.equal(duplicate.calls.headers.Location, undefined);
  const unsafe = checkoutHarness({ eventRecord: { ...event, guestList: [{ userId: member._id }] }, result: { url: "https://attacker.example" } });
  await unsafe.run();
  assert.equal(unsafe.calls.errors.length, 1);
  assert.equal(unsafe.calls.headers.Location, undefined);
});

test("email guest checkout uses guest price, prefilled details and guest fulfillment even for member-free events", async () => {
  const { postCheckoutFile } = await import("../controllers/payments-controllers.js");
  for (const mode of ["existing", "late", "member-free", "all-free"]) {
    const purchased = { ...event, isMemberFree: mode === "member-free", isFree: mode === "all-free",
      guestList: [{ type: "member", userId: member._id }] };
    const calls = {};
    const h = checkoutHarness({
      eventRecord: mode === "late" ? event : purchased,
      checkout: (req, res, next) => postCheckoutFile(req, res, next, {
        loadEvent: async () => purchased,
        reconcile: async (user) => ({ user }),
        generateTicket: async (data) => { calls.ticket = data; return "https://tickets.example.test/guest.png"; },
        resolvePrice: async (record, type, userId) => {
          assert.equal(type, "guest"); assert.equal(userId, "");
          assert.notEqual(mode, "all-free"); return record.product.guest.priceId;
        },
        stripeForRegion: () => ({}),
        createCheckout: async (data) => { calls.checkout = data; return { url: "https://checkout.stripe.com/c/pay/guest" }; },
      }),
    });
    await h.run();
    assert.deepEqual(h.calls.errors, []);
    assert.equal(h.calls.headers.Location, "https://checkout.stripe.com/c/pay/guest");
    assert.equal(h.calls.checkout.length, mode === "late" ? 2 : 1);
    assert.equal(calls.ticket.checkoutType, "guest");
    assert.equal(calls.ticket.guestName, member.name);
    assert.equal(calls.checkout.checkoutType, "guest");
    const data = calls.checkout.checkoutData;
    assert.equal(data.customer_email, member.email);
    assert.equal(data.metadata.guestEmail, member.email);
    assert.equal(data.metadata.guestName, member.name);
    assert.equal(data.metadata.method, "buy_guest_ticket");
    assert.equal(data.metadata.type, "guest");
    assert.equal(data.metadata.memberPriceApplied, "false");
    assert.equal(data.metadata.userId, "");
    assert.equal(data.metadata.quantity, 1);
    assert.equal(data.metadata.file, "https://tickets.example.test/guest.png");
    if (mode === "all-free") assert.equal(data.line_items[0].price_data.unit_amount, 0);
    else assert.equal(data.line_items[0].price, "price_guest");
  }
});


test("active VIP announcement eligibility has no expiry date", () => {
  assert.equal(isCurrentEventMember({ ...member, roles: ["member", "vip"], expireDate: new Date(0) }), true);
  assert.equal(isCurrentEventMember({ ...member, roles: ["member", "vip"], expireDate: new Date(0), status: "suspended" }), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createMemberEventCheckoutHandler } from "../controllers/member-event-checkout-controller.js";
import { createMemberEventToken, verifyMemberEventLink, requiresEventChoices } from "../services/events/member-event-links.js";
import { memberEventPreferences, validateMemberEventChoices } from "../services/events/member-event-preferences.js";
import { postCheckoutFile, createTicketCheckoutSession } from "../controllers/payments-controllers.js";
import { verifySessionToken } from "../util/auth/session-token.js";

const env = { EVENT_TICKET_LINK_SECRET: "email-preferences-test-secret-".repeat(3) };
const member = { _id: `member_${"b".repeat(24)}`, id: `member_${"b".repeat(24)}`, name: "Test", surname: "Member", email: "test@example.test", phone: "123456789", status: "active", roles: ["member"], expireDate: new Date("2099-01-01") };
const event = { _id: "a".repeat(24), region: "groningen", title: "Event", poster: "https://example.test/poster.jpg", date: new Date("2098-01-01"), ticketTimer: new Date("2097-12-31"), ticketLimit: 50, guestList: [], status: "opened", product: { member: { price: 8, priceId: "price_member" }, guest: { price: 12, priceId: "price_guest" } },
  addOns: { isEnabled: true, isMandatory: false, multi: false, title: "Extras", items: [{ _id: "c".repeat(24), title: "Meal", price: 3, priceId: "price_meal" }, { _id: "d".repeat(24), title: "Drink", price: 2, priceId: "price_drink" }] },
  extraInputsForm: [{ type: "select", placeholder: "Diet", required: true, options: ["Vegetarian", "Other"] }, { type: "text", placeholder: "Note", required: false }] };
const token = () => createMemberEventToken(event, member, { env, ttlMs: 1800000 });
const choices = () => ({ addOns: ["c".repeat(24)], preferences: { Diet: "Vegetarian", Note: "No nuts" }, revision: memberEventPreferences(event, member, false).revision });

function harness(mode, { eventRecord = event, account = member, checkout } = {}) {
  const calls = { checkout: [], errors: [], headers: {} };
  const req = { method: "POST", body: { token: token(), ...choices() } };
  const res = { set(headers) { Object.assign(calls.headers, headers); return this; }, status(status) { calls.status = status; return this; }, json(data) { calls.result = data; return this; } };
  const handler = createMemberEventCheckoutHandler({ mode,
    verify: input => verifyMemberEventLink(input, { env }),
    EventModel: { findById: async () => structuredClone(eventRecord) }, MemberModel: { findById: async () => structuredClone(account) },
    reconcile: async user => ({ user }), checkout: async (request, response, next) => { calls.checkout.push(request); return checkout ? checkout(request, response, next) : response.json({ url: "https://checkout.stripe.com/c/pay/test" }); },
  });
  return { calls, req, run: () => handler(req, res, error => calls.errors.push(error)) };
}

test("optional add-ons, fields, and both require preferences; disabled add-ons do not", () => {
  assert.equal(requiresEventChoices({ addOns: event.addOns }), true);
  assert.equal(requiresEventChoices({ extraInputsForm: event.extraInputsForm }), true);
  assert.equal(requiresEventChoices(event), true);
  assert.equal(requiresEventChoices({ addOns: { ...event.addOns, isEnabled: false } }), false);
});

test("short continuation expires after 30 minutes and is never an account session", () => {
  const now = Date.now();
  const value = createMemberEventToken(event, member, { env, now, ttlMs: 1800000 });
  assert.equal(verifyMemberEventLink({ token: value }, { env, now }).exp, now + 1800000);
  assert.throws(() => verifyMemberEventLink({ token: value }, { env, now: now + 1800000 }));
  assert.throws(() => verifySessionToken(value));
});

test("preview returns only event choices and price, never member details or a Stripe session", async () => {
  const h = harness("preferences"); await h.run();
  assert.equal(h.calls.errors.length, 0); assert.equal(h.calls.result.price, 8);
  assert.equal(h.calls.result.event.extraInputsForm.length, 2);
  assert.equal(h.calls.checkout.length, 0);
  const payload = JSON.stringify(h.calls.result);
  for (const secret of [member.email, member.id, "price_member", "price_meal", "guestList", "subscription"]) assert.ok(!payload.includes(secret));
  assert.equal(h.calls.headers["Cache-Control"], "private, no-store");
});

test("submission derives identity, quantity, prices and metadata from verified records", async () => {
  const h = harness("checkout");
  Object.assign(h.req.body, { userId: "attacker", eventId: "other", quantity: 10, origin_url: "https://attacker.test", method: "signup", price: 0 });
  await h.run(); assert.equal(h.calls.errors.length, 0);
  const request = h.calls.checkout[0];
  assert.equal(request.account.id, member.id); assert.equal(request.body.eventId, event._id);
  assert.equal(request.body.quantity, 1); assert.equal(request.body.method, "buy_member_ticket");
  assert.equal(request.body.price, undefined); assert.equal(request.body.token, undefined);
  assert.deepEqual(JSON.parse(request.body.preferences), choices().preferences);
  assert.deepEqual(JSON.parse(request.body.addOns), [{ _id: "c".repeat(24), title: "Meal", price: 3 }]);
});

test("missing, invalid or expired capability cannot preview or submit", async () => {
  for (const mode of ["preferences", "checkout"]) for (const value of [undefined, "invalid", createMemberEventToken(event, member, { env, ttlMs: -1 })]) {
    const h = harness(mode); h.req.body.token = value; await h.run(); assert.equal(h.calls.checkout.length, 0); assert.equal(h.calls.errors.length, 1);
  }
});

test("closed sales, changed account and revoked membership block submit", async () => {
  for (const patch of [{ isSaleClosed: true }, { hidden: true }, { ticketLimit: 0 }, { status: "cancelled" }]) {
    const h = harness("checkout", { eventRecord: { ...event, ...patch } }); await h.run(); assert.equal(h.calls.checkout.length, 0); assert.equal(h.calls.errors.length, 1);
  }
  for (const patch of [{ email: "changed@example.test" }, { status: "frozen" }, { expireDate: new Date(0) }]) {
    const h = harness("checkout", { account: { ...member, ...patch } }); await h.run(); assert.equal(h.calls.checkout.length, 0); assert.equal(h.calls.errors.length, 1);
  }
});

test("required answers, allowed options and add-on selection limits are enforced", () => {
  for (const body of [{ preferences: {} }, { ...choices(), preferences: { Diet: "Invalid" } }, { ...choices(), preferences: { ...choices().preferences, extra: "bad" } }, { ...choices(), addOns: ["unknown"] }, { ...choices(), addOns: ["c".repeat(24), "c".repeat(24)] }, { ...choices(), addOns: ["c".repeat(24), "d".repeat(24)] }, { ...choices(), addOns: [{ _id: "c".repeat(24), price: 0 }] }]) assert.throws(() => validateMemberEventChoices(event, body));
  assert.throws(() => validateMemberEventChoices({ ...event, addOns: { ...event.addOns, isMandatory: true } }, { ...choices(), addOns: [] }));
  assert.throws(() => validateMemberEventChoices({ ...event, addOns: { ...event.addOns, isEnabled: false } }, choices()));
  assert.doesNotThrow(() => validateMemberEventChoices(event, { ...choices(), addOns: [] }));
});

test("changed options or prices require review before checkout", async () => {
  const h = harness("checkout", { eventRecord: { ...event, product: { ...event.product, member: { price: 10, priceId: "changed" } } } });
  await h.run(); assert.equal(h.calls.errors[0].code, 409); assert.equal(h.calls.checkout.length, 0);
});

test("existing ticket holders get a guest preview and preserve preferences on the guest checkout", async () => {
  const ticketed = { ...event, guestList: [{ userId: member.id, type: "member" }] };
  const preview = harness("preferences", { eventRecord: ticketed }); await preview.run();
  assert.equal(preview.calls.result.guest, true); assert.equal(preview.calls.result.price, 12);
  const h = harness("checkout", { eventRecord: ticketed }); h.req.body.revision = preview.calls.result.revision; await h.run();
  assert.equal(h.calls.checkout[0].body.method, "buy_guest_ticket"); assert.deepEqual(JSON.parse(h.calls.checkout[0].body.preferences), choices().preferences);
});

test("real ticket controller charges DB add-on price IDs alongside a free member ticket", async () => {
  const freeEvent = { ...event, isMemberFree: true };
  let sent;
  const h = harness("checkout", { eventRecord: freeEvent, checkout: (req, res, next) => postCheckoutFile(req, res, next, {
    loadEvent: async () => freeEvent, reconcile: async user => ({ user }), generateTicket: async () => "ticket.png", stripeForRegion: () => ({}),
    createCheckout: async args => { sent = args.checkoutData; return { url: "https://checkout.stripe.com/c/pay/free-plus-addon" }; },
  }) });
  h.req.body.revision = memberEventPreferences(freeEvent, member, false).revision;
  await h.run(); assert.equal(h.calls.errors.length, 0);
  assert.equal(sent.line_items[0].price_data.unit_amount, 0);
  assert.deepEqual(sent.line_items[1], { price: "price_meal", quantity: 1 });
  assert.equal(sent.customer_email, member.email);
});

test("open member checkout is reused only for matching preferences and add-ons", async () => {
  const record = { data: {} }; let created = 0; const expired = [];
  const args = { stripeClient: { checkout: { sessions: {
    retrieve: async id => ({ id, status: "open", url: record.data.sessionUrl }),
    expire: async id => { expired.push(id); return { id, status: "expired" }; },
  } } }, event: { ...event, product: {} }, eventId: event._id, checkoutType: "member", userId: member.id, member,
    checkoutData: { line_items: [{ price: "price_member", quantity: 1 }], metadata: { region: "groningen", preferences: '{"Diet":"Vegetarian"}' } } };
  const deps = { hasDuplicate: async () => false, lease: async (key, run) => run({ record, assertOwned: async () => {} }), updateRecord: async (query, update) => { record.data = update.$set.data; }, createReturned: async () => ({ id: `cs_${++created}`, url: `https://checkout.stripe.com/${created}` }) };
  await createTicketCheckoutSession(args, deps); await createTicketCheckoutSession(args, deps); assert.equal(created, 1);
  args.checkoutData.metadata.preferences = '{"Diet":"Other"}'; await createTicketCheckoutSession(args, deps);
  assert.equal(created, 2); assert.deepEqual(expired, ["cs_1"]);
});

test("ticket checkout trusts Stripe over cached expiry and safely handles expiration races", async () => {
  for (const scenario of ["expired", "lost-response", "completed", "cannot-expire"]) {
    const record = { data: { sessionId: "cs_old", sessionUrl: "old", expiresAt: 1 } };
    let status = scenario === "expired" ? "expired" : "open";
    let created = 0;
    const args = { stripeClient: { checkout: { sessions: {
      retrieve: async () => ({ id: "cs_old", status, url: "old" }),
      expire: async () => {
        status = scenario === "lost-response" ? "expired" : scenario === "completed" ? "complete" : "open";
        throw new Error("Expiration interrupted");
      },
    } } }, event: { ...event, product: {} }, eventId: event._id, checkoutType: "member", userId: member.id, member,
    checkoutData: { line_items: [{ price: "price_member", quantity: 1 }], metadata: { region: "groningen" } } };
    const deps = { hasDuplicate: async () => false, lease: async (_key, run) => run({ record, assertOwned: async () => {} }),
      updateRecord: async () => {}, createReturned: async () => { created++; return { id: "cs_new", url: "new" }; } };
    if (["expired", "lost-response"].includes(scenario)) {
      assert.deepEqual(await createTicketCheckoutSession(args, deps), { url: "new" });
      assert.equal(created, 1);
    } else {
      await assert.rejects(createTicketCheckoutSession(args, deps), scenario === "completed" ? /payment is being processed/ : /Expiration interrupted/);
      assert.equal(created, 0);
    }
  }
});

test("guest and normal ticket checkouts are not blocked by stored member sessions", async () => {
  for (const selection of [{ checkoutType: "guest" }, { checkoutType: "member", isNormalTicket: true }]) {
    const result = await createTicketCheckoutSession({ ...selection, stripeClient: {}, event: { ...event, product: {} }, eventId: event._id,
      checkoutData: { line_items: [{ price: "price_guest", quantity: 1 }], metadata: { region: "groningen" } } }, {
      lease: async () => { throw new Error("Must not block on member checkout"); },
      createReturned: async () => ({ url: "new-guest-checkout" }),
    });
    assert.deepEqual(result, { url: "new-guest-checkout" });
  }
});

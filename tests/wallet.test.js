import test from "node:test";
import assert from "node:assert/strict";
import { walletControllers } from "../controllers/wallet-controller.js";
import { createWalletCards } from "../services/wallet/cards.js";
import { createCardToken, validCardToken, publicCard, publicTicketImages, cardOwner, cardUrl } from "../services/wallet/policy.js";

function response() {
  return { headers: {}, code: 200, body: null,
    set(key, value) { if (typeof key === "object") Object.assign(this.headers, key); else this.headers[key] = value; return this; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; } };
}

const member = { id: "member_abc", name: "Example", surname: "Member", roles: ["member"], status: "active", region: "groningen",
  expireDate: new Date(Date.now() + 86400000), email: "private@example.test", password: "private" };

test("short links use random 128-bit tokens and the confirmed domain", () => {
  const tokens = Array.from({ length: 1000 }, createCardToken);
  assert.equal(new Set(tokens).size, 1000);
  for (const token of tokens) { assert.ok(validCardToken(token)); assert.equal(token.length, 22); }
  assert.equal(cardUrl(tokens[0]), `https://bulgariansociety.nl/c/${tokens[0]}`);
  for (const token of ["", "../abc", "member_123", "a".repeat(23)]) assert.throws(() => cardUrl(token));
  assert.equal(cardOwner(member), cardOwner({ ...member, id: "alumni_abc" }));
});

test("public card has only approved fields and conservative current status", () => {
  const card = publicCard(member);
  assert.deepEqual(Object.keys(card).sort(), ["firstName", "surname", "profileImage", "region", "membershipLabel", "status"].sort());
  assert.equal(card.membershipLabel, "Member of Groningen");
  assert.equal(card.status, "active");
  assert.equal(publicCard({ ...member, status: "locked" }).status, "locked");
  assert.equal(publicCard({ ...member, expireDate: new Date(0) }).status, "locked");
  assert.equal(publicCard({ ...member, status: "deleted" }), null);
  assert.equal(publicCard({ ...member, subscription: { id: "sub", hasBenefits: true, syncedAt: new Date(0) } }).status, "locked");
  assert.equal(publicCard({ ...member, roles: ["alumni"], tier: 2 }).membershipLabel, "Alumni Tier II");
  assert.equal(publicCard({ ...member, image: "javascript:alert(1)" }).profileImage.startsWith("/assets/"), true);
});

test("membership labels show the highest priority board or committee role", () => {
  const cases = [
    ["regional_board_member", "Board Member of Groningen"],
    ["national_board_member", "National Board Member"],
    ["regional_committee_member", "Committee Member of Groningen"],
    ["national_committee_member", "National Committee Member"],
  ];
  for (const [role, title] of cases) {
    assert.equal(publicCard({ ...member, roles: ["member", role] }).membershipLabel, title);
    assert.equal(publicCard({ ...member, roles: ["alumni", role], tier: 2 }).membershipLabel, `Alumni Tier II & ${title}`);
  }
  assert.equal(publicCard({ ...member, roles: ["alumni", "national_board_member"], tier: 0 }).membershipLabel,
    "Alumni Tier 0 & National Board Member");
  assert.equal(publicCard({ ...member, roles: ["member", "regional_committee_member", "national_committee_member",
    "regional_board_member", "national_board_member"] }).membershipLabel, "National Board Member");
  assert.equal(publicCard({ ...member, roles: ["member", "regional_committee_member", "national_committee_member",
    "regional_board_member"] }).membershipLabel, "Board Member of Groningen");
  assert.equal(publicCard({ ...member, roles: ["member", "regional_committee_member", "national_committee_member"] }).membershipLabel,
    "National Committee Member");
  for (const [legacy, title] of [["society_board_member", "National Board Member"],
    ["board_member", "Board Member of Groningen"], ["committee_member", "Committee Member of Groningen"]]) {
    assert.equal(publicCard({ ...member, roles: ["member", legacy] }).membershipLabel, title);
  }
});

test("public ticket images contain no ticket or account metadata", () => {
  const ticket = { event: "Private event name", purchaseDate: new Date("2026-09-20T12:00:00Z"),
    image: "https://tickets.example.test/ticket.png", internal: "private" };
  assert.deepEqual(publicTicketImages({ ...member, tickets: [ticket] }), [ticket.image]);
  assert.deepEqual(publicTicketImages({ ...member, status: "locked", tickets: [ticket] }), []);
  assert.deepEqual(publicTicketImages({ ...member, tickets: [{ ...ticket, image: "javascript:alert(1)" }] }), []);
});

test("creation no longer requires consent and errors remain private", async () => {
  let created = 0;
  const controller = walletControllers({ create: async () => { created++; throw new Error("private database detail"); } });
  const res = response();
  await controller.create({ account: member, body: {} }, res);
  assert.equal(res.code, 503); assert.equal(created, 1);
  const failure = response();
  await controller.create({ account: member, body: { publicCardConsent: true } }, failure);
  assert.equal(failure.code, 503); assert.equal(created, 2);
  assert.doesNotMatch(JSON.stringify(failure.body), /database detail/);
});

test("public controller excludes the token and uses no-store", async () => {
  const controller = walletControllers({ public: async () => ({ card: publicCard(member), ticketImages: [], token: createCardToken(), accountId: member.id }) });
  const res = response();
  await controller.public({ params: { token: createCardToken() } }, res);
  assert.deepEqual(Object.keys(res.body), ["card", "ticketImages"]);
  assert.equal(res.headers["Cache-Control"], "private, no-store");
});

test("missing-card availability becomes ready after an explicit Create request", async () => {
  let packet = null;
  const controller = walletControllers({ own: async () => packet,
    create: async () => { const token = createCardToken(); packet = { card: publicCard(member), token, publicUrl: cardUrl(token) }; return packet; } });
  const before = response();
  await controller.availability({ account: member }, before);
  assert.deepEqual(before.body, { eligible: true, hasCard: false, publicUrl: null });
  const created = response();
  await controller.create({ account: member }, created);
  assert.equal(created.code, 200);
  const after = response();
  await controller.availability({ account: member }, after);
  assert.equal(after.body.hasCard, true);
  assert.equal(after.body.publicUrl, packet.publicUrl);
});

test("records reuse links, separate members, revoke, and replace revoked links", async () => {
  const saved = new Map();
  const matches = (r, q) => (!q._id || r._id === q._id) && (!q.token || r.token === q.token) &&
    (!Object.hasOwn(q, "revokedAt") || r.revokedAt === q.revokedAt) &&
    (!q.$or || q.$or.some((part) => part._id === r._id || part.accountId?.$in.includes(r.accountId)));
  const records = {
    init: async () => {},
    findOne: async (q) => [...saved.values()].find((r) => matches(r, q)) || null,
    findOneAndUpdate: async (q, update, options) => {
      let r = saved.get(q._id);
      if (!r && options.upsert) { r = { _id: q._id, revokedAt: null, ...update.$setOnInsert }; saved.set(r._id, r); }
      if (!r || !matches(r, q)) return null;
      Object.assign(r, update.$set || {}); return r;
    },
    updateMany: async (q, update) => { for (const r of saved.values()) if (matches(r, q)) Object.assign(r, update.$set); },
  };
  const cards = createWalletCards({ records, findAccount: async (id) => ({ ...member, id }), reconcile: async (account) => ({ user: account }) });
  assert.equal(await cards.own(member), null, "reads do not silently create a missing card");
  const first = await cards.create(member);
  assert.ok(first.token, "Create repairs the exceptional missing-card state");
  assert.equal((await cards.create(member)).token, first.token);
  assert.notEqual((await cards.create({ ...member, id: "member_other" })).token, first.token);
  assert.equal((await cards.public(first.token)).card.firstName, member.name);
  await cards.revoke(member);
  assert.equal(await cards.public(first.token), null);
  assert.equal(await cards.own(member), null);
  const renewed = await cards.create(member);
  assert.notEqual(renewed.token, first.token);
  assert.equal(await cards.public(first.token), null);
  assert.equal((await cards.own({ ...member, id: "alumni_abc", roles: ["alumni"], tier: 2 })).token, renewed.token);
  assert.equal(await cards.public("../../private"), null);
});

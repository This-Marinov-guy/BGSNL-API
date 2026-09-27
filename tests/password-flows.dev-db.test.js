import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import https from "node:https";
import http from "node:http";
import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

// Opt-in integration test. Never use the application's default DB ("test" is
// production here), start app.js, or send Stripe/email/Google requests.
dotenv.config();
const databaseName = process.env.BGSNL_PASSWORD_TEST_DB;
// Redis must point at a dedicated local fixture namespace for this opt-in suite.
if (databaseName) {
  assert.match(process.env.BGSNL_REDIS_URL || "", /^redis:\/\/[^/]*127\.0\.0\.1:6389\/15$/);
  process.env.BGSNL_REDIS_PREFIX = "bgsnl-password-tests:";
}
const safeName = (name) => /^bgsnl_flow_test_passwords(?:_[a-z0-9]+)?$/.test(name || "");
test("development Mongo password flows", { skip: !databaseName, timeout: 180000 }, async (t) => {
  assert.ok(safeName(databaseName), "Only the dedicated password-test DB namespace is allowed");
  assert.equal(process.env.APP_ENV, "dev", "Set APP_ENV=dev explicitly; production is refused");
  assert.notEqual(process.env.NODE_ENV, "production");
  const host = process.env.DB?.split(/[/?]/)[0];
  assert.match(host || "", /^[a-z0-9.-]+$/i);
  assert.ok(process.env.DB_USER && process.env.DB_PASS, "Database credentials are required");
  const run = randomUUID().replaceAll("-", ""), emails = [], checkoutKeys = [];
  const domain = "password-tests.bgsnl.invalid";
  const noop = () => {};
  const blocked = () => { throw new Error("Outbound HTTP is disabled in password DB tests"); };
  t.mock.method(https, "request", blocked); t.mock.method(http, "request", blocked);
  t.mock.method(globalThis, "fetch", blocked);
  process.env.JWT_STRING = randomBytes(48).toString("hex");
  process.env.CRYPTO_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  process.env.AUTH_VERSION = "1";
  // All regional keys become fake before importing any service; even a missed
  // dependency stub cannot authenticate with Stripe. No values are printed.
  for (const key of Object.keys(process.env)) if (/STRIPE.*(?:SECRET_KEY|WEBHOOK)/.test(key)) process.env[key] = "sk_test_password_fixture_not_a_real_key";
  const [{ default: MemberUser }, { default: Alumni }, { default: BillingRecord }, { default: RefreshSession }, { default: Reset }, { default: Profile },
    passwords, checkout, security, helpers, loginService, tokens, policy, legacy, resetService, profileService] = await Promise.all([
    import("../models/MemberUser.js"), import("../models/AlumniUser.js"), import("../models/BillingRecord.js"), import("../models/RefreshSession.js"),
    import("../models/PasswordResetChallenge.js"), import("../models/ProfileChange.js"),
    import("../services/authentication/passwords.js"), import("../services/subscriptions/checkout.js"), import("../controllers/security-controller.js"),
    import("../util/functions/helpers.js"), import("../services/authentication/login.js"), import("../util/auth/session-token.js"),
    import("../util/subscriptions/policy.js"), import("../services/main-services/stripe-webhook-service.js"),
    import("../services/authentication/password-reset.js"), import("../services/authentication/profile-change.js"),
  ]);
  const uri = `mongodb+srv://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_PASS)}@${host}`;
  try {
    await mongoose.connect(uri, { dbName: databaseName, autoIndex: false, autoCreate: false, maxPoolSize: 3, serverSelectionTimeoutMS: 10000 });
  } catch {
    await mongoose.disconnect();
    throw new Error("Could not connect to the isolated development DB; check network/access permissions (credentials redacted).");
  }
  let isolationVerified = false;
  t.after(async () => {
    try {
      if (!isolationVerified) return;
      assert.equal(mongoose.connection.name, databaseName);
      assert.ok(safeName(mongoose.connection.name));
      assert.ok(emails.every((email) => email.startsWith(`${run}-`) && email.endsWith(`@${domain}`)));
      const owned = (await Promise.all([MemberUser.find({ email: { $in: emails } }).select("_id").lean(), Alumni.find({ email: { $in: emails } }).select("_id").lean()])).flat().map((u) => u._id);
      // Exact records created by THIS run only; no dropDatabase/dropCollection.
      for (const Model of [Reset, Profile]) await Model.deleteMany({ _id: { $in: owned } });
      await RefreshSession.deleteMany({ accountId: { $in: owned } });
      await BillingRecord.deleteMany({ _id: { $in: checkoutKeys } });
      for (const Model of [MemberUser, Alumni]) await Model.deleteMany({ _id: { $in: owned }, email: { $in: emails } });
      assert.equal(await MemberUser.countDocuments({ email: { $in: emails } }) + await Alumni.countDocuments({ email: { $in: emails } }), 0);
      t.diagnostic(`Cleaned this run's ${owned.length} synthetic accounts and associated auth/checkout records from ${databaseName}.`);
    } finally { await mongoose.disconnect(); }
  });
  assert.equal(mongoose.connection.name, databaseName);
  for (const Model of [MemberUser, Alumni]) assert.equal(await Model.exists({ email: { $not: /@password-tests\.bgsnl\.invalid$/ } }), null,
    "Database contains non-fixture accounts; no writes allowed");
  const allowedCollections = [MemberUser, Alumni, Reset, Profile];
  const existingCollections = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
  assert.ok(existingCollections.every((c) => allowedCollections.some((Model) => Model.collection.name === c.name)), "Unexpected collections: refusing this database");
  isolationVerified = true;
  for (const Model of allowedCollections) await Model.createCollection();
  // Only these two indexes are required for real unique-account behaviour.
  await MemberUser.collection.createIndex({ email: 1 }, { unique: true });
  await Alumni.collection.createIndex({ email: 1 }, { unique: true });
  t.diagnostic(`Verified isolated DB: ${databaseName}; Stripe, email and all outbound HTTP disabled.`);
  const raw = "  Password-dev-fixture-123!  ";
  const memberPlan = policy.MEMBERSHIP_PLANS.find((p) => p.type === "member");
  const alumniPlan = policy.MEMBERSHIP_PLANS.find((p) => p.type === "alumni");
  function body(label, plan = memberPlan, password = raw) {
    const email = `${run}-${label}@${domain}`; emails.push(email);
    return { email, password: helpers.encryptData(password), method: plan.type === "member" ? "signup" : "alumni-signup", itemId: plan.priceId,
      name: "Password", surname: "Fixture", birth: "2000-01-01", phone: "+31600000000", university: "working", profession: "Test fixture",
      region: "groningen", period: plan.period, tier: plan.tier || 0, notificationTerms: false, origin_url: "http://localhost:3001" };
  }
  const response = () => ({ code: 200, status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } });
  const login = security.createPasswordLogin({ buildResponse: (user) => loginService.buildLoginResponse(user, { reconcile: async () => ({ user }) }) });
  async function assertLogin(email, password, storedHash) {
    const res = response();
    await login({ body: { email, password } }, res, (error) => { throw error; });
    assert.equal(res.code, 201);
    const claims = tokens.verifySessionToken(res.body.token);
    assert.ok(await RefreshSession.exists({ _id: claims.sid, accountId: claims.userId }));
    const user = await MemberUser.findOne({ email }) || await Alumni.findOne({ email });
    assert.equal(user.password, storedHash, "login must not rewrite the existing hash");
    const rejected = response(); let error;
    await login({ body: { email, password: "Wrong-password-123" } }, rejected, (value) => { error = value; });
    assert.equal(error.statusCode, 401);
    return { user, claims };
  }
  async function paid(label, plan, { explicitHashField = false } = {}) {
    const input = body(label, plan), customerId = `cus_fixture_${label}`, subscriptionId = `sub_fixture_${label}`, sessionId = `cs_fixture_${label}`;
    const stripeCalls = [];
    const stripe = { customers: { create: async (data) => { stripeCalls.push(data); return { id: customerId }; } },
      subscriptions: { list: () => (async function* () {})() },
      checkout: { sessions: { create: async (data) => { stripeCalls.push(data); return { id: sessionId, url: "https://checkout.stripe.com/fixture" }; },
        retrieve: async () => ({ id: sessionId, status: "open" }) } } };
    let registration, key;
    const reserve = async (options) => {
      registration = options.registration; key = options.key; checkoutKeys.push(key);
      if (explicitHashField) { registration.passwordHash = registration.password; delete registration.password; }
      return checkout.reserveCheckout({ ...options, dependencies: { stripe, prepareReturn: async () => ({ id: `receipt_${label}`,
        success_url: "http://localhost:3001/payment/return", cancel_url: "http://localhost:3001/payment/return", bind: async () => {} }) } });
    };
    await checkout.startMembershipSignup(input, null, { checkout: reserve });
    const record = await BillingRecord.findById(key), storedHash = passwords.registrationPasswordHash(record.data.registration);
    assert.equal(bcrypt.getRounds(storedHash), 12);
    for (const secret of [raw, input.password, storedHash]) assert.ok(!JSON.stringify(stripeCalls).includes(secret), "No password or hash may reach Stripe");
    assert.equal(await MemberUser.exists({ email: input.email }), null); assert.equal(await Alumni.exists({ email: input.email }), null);
    const session = { id: sessionId, mode: "subscription", status: "complete", subscription: subscriptionId, customer: customerId,
      metadata: { checkoutKey: key, password: "ignored-client-metadata" } };
    let notifications = 0;
    const options = { stripeClient: () => stripe,
      readSubscription: async () => ({ sub: { id: subscriptionId, customer: customerId, created: Math.floor(Date.now() / 1000) },
        state: { plan, hasBenefits: true, periodEnd: Math.floor(Date.now() / 1000) + 86400 } }),
      reconcile: async () => {}, notifyMember: () => notifications++, notifyAlumni: () => notifications++ };
    return { input, key, session, storedHash, options, notices: () => notifications,
      complete: (override = {}) => checkout.completeMembershipCheckout(session, "netherlands", { ...options, ...override }) };
  }
  for (const plan of [memberPlan, alumniPlan]) await t.test(`${plan.type}: paid checkout stores one hash, webhook preserves it, replay is harmless and login works`, async () => {
    const h = await paid(`paid-${plan.type}`, plan); await h.complete(); await h.complete();
    const user = await MemberUser.findOne({ email: h.input.email }) || await Alumni.findOne({ email: h.input.email });
    assert.equal(user.password, h.storedHash); assert.equal(h.notices(), 1);
    const record = await BillingRecord.findById(h.key); assert.ok(record.completedAt); assert.equal(record.data.registration, undefined);
    await assertLogin(user.email, raw, h.storedHash);
  });
  await t.test("the alternate explicit passwordHash reservation field also completes without rehashing", async () => {
    const h = await paid("explicit-hash-pending", memberPlan, { explicitHashField: true }); await h.complete();
    await assertLogin(h.input.email, raw, h.storedHash);
  });
  await t.test("a webhook retry after account save cannot overwrite a subsequently changed password", async () => {
    const h = await paid("retry-after-save", alumniPlan);
    await assert.rejects(h.complete({ records: { updateOne: async () => { throw new Error("Fixture: receipt write failed"); } } }));
    const user = await Alumni.findOne({ email: h.input.email }), replacement = await passwords.hashPassword("Replacement-123!");
    user.password = replacement; user.sessionVersion++; await user.save();
    await h.complete(); await assertLogin(user.email, "Replacement-123!", replacement);
  });
  await t.test("corrupt pending password state cannot create an account at webhook completion", async () => {
    const h = await paid("corrupt-pending", memberPlan);
    await BillingRecord.updateOne({ _id: h.key }, { $set: { "data.registration.password": "plaintext-not-a-hash" } });
    await assert.rejects(h.complete(), /password hash is invalid/);
    assert.equal(await MemberUser.exists({ email: h.input.email }), null); assert.equal(h.notices(), 0);
  });
  for (const [plan, handler] of [[memberPlan, security.signup], [alumniPlan, security.alumniSignup]]) await t.test(`${plan.type}: internal non-payment account creation hashes the original password once`, async () => {
    const input = body(`direct-${plan.type}`, plan), res = response();
    await handler({ body: input }, res, (error) => { throw error; }, { notify: noop, sync: noop });
    assert.equal(res.code, 201);
    const user = await MemberUser.findOne({ email: input.email }) || await Alumni.findOne({ email: input.email });
    assert.equal(bcrypt.getRounds(user.password), 12); await assertLogin(user.email, raw, user.password);
  });
  for (const [plan, handler] of [[memberPlan, legacy.handleUserSignup], [alumniPlan, legacy.handleAlumniSignup]]) await t.test(`${plan.type}: old encrypted Stripe metadata remains compatible`, async () => {
    const input = body(`legacy-${plan.type}`, plan);
    await handler(input, { subscriptionId: `sub_legacy_${plan.type}`, customerId: `cus_legacy_${plan.type}`, paymentStatus: "paid", stripeRegion: "netherlands" },
      { resolveJoinDate: async () => new Date(), notify: noop, sync: noop, recount: noop });
    const user = await MemberUser.findOne({ email: input.email }) || await Alumni.findOne({ email: input.email });
    assert.equal(bcrypt.getRounds(user.password), 12); await assertLogin(user.email, raw, user.password);
  });
  await t.test("existing bcrypt accounts keep their passwords and hashes without migration", async () => {
    for (const [cost, value] of [[4, "oldpass"], [10, "Ab1" + "б".repeat(60)], [12, raw]]) {
      const input = body(`existing-${cost}`), stored = await bcrypt.hash(value, cost);
      const user = await MemberUser.create({ ...input, password: stored, image: "/fixture.png", expireDate: new Date(Date.now() + 86400000) });
      await assertLogin(user.email, value, stored);
    }
  });
  await t.test("password reset and emailed profile change use the same hash policy with real Mongo transactions", async () => {
    const input = body("reset-profile"), stored = await passwords.hashPassword(raw);
    let user = await MemberUser.create({ ...input, password: stored, image: "/fixture.png", expireDate: new Date(Date.now() + 86400000) });
    const code = await resetService.issuePasswordReset(user);
    await resetService.completePasswordReset(user, code, "Reset-password-123!");
    user = await MemberUser.findById(user.id); assert.equal(bcrypt.getRounds(user.password), 12);
    const logged = await assertLogin(user.email, "Reset-password-123!", user.password), messages = [];
    await profileService.requestProfileChange(user, { password: raw, origin: "http://localhost:3001", claims: logged.claims }, { deliver: async (message) => messages.push(message) });
    const pending = await Profile.findById(user.id); assert.equal(bcrypt.getRounds(pending.passwordHash), 12);
    const approval = messages[0].templateVariables.url.match(/#token=([\w-]+)/)[1];
    await profileService.confirmProfileChange(approval, { deliver: async () => {} });
    user = await MemberUser.findById(user.id); assert.equal(user.password, pending.passwordHash);
    await assertLogin(user.email, raw, user.password);
  });
});

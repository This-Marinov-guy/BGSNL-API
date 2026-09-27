import test from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { BSON, ObjectId } from "mongodb";
import { BACKUP_COLLECTION, eventSlugIndexReadiness, normalizeLegacyEvent, planEventProductionUpgrade, upgradeProductionEvents } from "../services/events/event-production-upgrade.js";
import migration from "../migrations/007-upgrade-production-events.js";
import backgroundMigration from "../migrations/005-remove-event-backgrounds.js";
import { isActiveUpgradeEvent } from "../services/events/event-upgrade-scope.js";

const clone = value => BSON.deserialize(BSON.serialize(value));
const date = new Date("2026-09-22T17:00:00Z");
const fixture = (overrides = {}) => ({
  _id: new ObjectId(), title: "Welcome Night", region: "breda", date, correctedDate: new Date("2099-09-22"), createdAt: new Date("2026-01-01"),
  status: "opened", ticketTimer: date, isSaleClosed: false,
  lastUpdate: { id: "legacy-editor", timestamp: date },
  product: { id: "prod_unchanged", guest: { price: 12, priceId: "price_guest" }, member: { price: 0, priceId: "price_free" },
    promoCodes: [{ _id: new ObjectId(), id: "promo_legacy", couponId: "coupon_legacy", code: "Legacy Code", active: false, discountType: 2, discount: 15, useLimit: 5 }] },
  earlyBird: { isEnabled: true, ticketLimit: 5, price: 8, priceId: "price_early", ticketTimer: "2026-09-22T19:00:00+02:00", startTimer: "" },
  lateBird: { isEnabled: false, startTimer: "", memberPrice: 10, memberPriceId: "price_late" },
  promotion: { guest: { isEnabled: false, discount: 0 }, member: { isEnabled: false } },
  addOns: { isEnabled: false, items: [{ _id: new ObjectId(), price: 3, priceId: "price_extra" }] },
  guestList: [{ status: 1, type: "member", refunded: false, ticket: "ticket-existing" }],
  memberAnnouncementQueuedAt: undefined, bgImage: 1, bgImageSelection: 1, bgImageExtra: "old",
  ...overrides,
});

function applyUpdate(record, update) {
  for (const [operator, paths] of Object.entries(update)) for (const [path, value] of Object.entries(paths)) {
    const parts = path.split(".");
    const last = parts.pop();
    let parent = record;
    for (const part of parts) parent = parent[part] ??= {};
    if (operator === "$unset") delete parent[last];
    else parent[last] = clone({ value }).value;
  }
}

test("legacy normalization fills the new schema without changing commercial or attendee data", () => {
  const original = fixture();
  const snapshot = clone(original);
  const upgraded = normalizeLegacyEvent(original);
  assert.equal(upgraded.region, "breda_tilburg");
  assert.deepEqual(upgraded.metadata, { createdBy: null, createdAt: original.createdAt, updatedBy: "legacy-editor", updatedAt: date });
  assert.equal(upgraded.lastUpdate, undefined);
  assert.equal(upgraded.bgImage, undefined);
  assert.equal(upgraded.addOns.isMandatory, false);
  assert.equal(upgraded.promotion.member.discount, 0);
  assert.deepEqual(upgraded.earlyBird.ticketTimer, date);
  assert.equal(Object.hasOwn(upgraded.earlyBird, "startTimer"), false);
  assert.equal(Object.hasOwn(upgraded.lateBird, "startTimer"), false);
  assert.deepEqual(upgraded.product.guest, original.product.guest);
  assert.deepEqual(upgraded.product.member, original.product.member);
  assert.deepEqual(upgraded.guestList, original.guestList);
  assert.deepEqual(upgraded.addOns.items, original.addOns.items);
  assert.deepEqual(upgraded.product.promoCodes[0], { ...original.product.promoCodes[0], customerScoped: false, audiences: ["guest", "member"], redeemedBefore: 0, exhausted: false });
  assert.deepEqual(clone(original), snapshot);
  assert.equal(upgraded.status, "opened");
  assert.equal(upgraded.memberAnnouncementQueuedAt, undefined);
});

test("current metadata, explicit false/zero values and customer-scoped code settings survive", () => {
  const metadata = { createdBy: "creator", createdAt: date, updatedBy: "current-editor", updatedAt: date };
  const event = fixture({ metadata, addOns: { isEnabled: true, isMandatory: true }, product: { guest: { price: 0 }, promoCodes: [
    { id: "coupon_current", customerScoped: true, active: false, exhausted: true, redeemedBefore: 7, audiences: ["activeMember"] },
  ] } });
  const normalized = normalizeLegacyEvent(event);
  assert.deepEqual(normalized.metadata, metadata);
  assert.deepEqual(normalized.product.promoCodes, event.product.promoCodes);
  assert.equal(normalized.addOns.isMandatory, true);
  assert.equal(normalized.product.guest.price, 0);
});

test("free events keep their null product; missing historical dates/actors stay unknown", () => {
  const event = normalizeLegacyEvent(fixture({ product: null, createdAt: undefined, lastUpdate: undefined, isFree: true }));
  assert.equal(event.product, null);
  assert.deepEqual(event.metadata, { createdBy: null, createdAt: null, updatedBy: null, updatedAt: null });
});

test("slug allocation reserves historical/current URLs, normalizes regions and is deterministic", async () => {
  const first = fixture({ _id: new ObjectId("000000000000000000000001"), createdAt: new Date("2025-01-01") });
  const second = fixture({ _id: new ObjectId("000000000000000000000002") });
  const third = fixture({ _id: new ObjectId("000000000000000000000003"), region: "groningen" });
  const historic = fixture({ _id: new ObjectId("000000000000000000000004"), status: "archived", slug: "welcome-night", region: "breda_tilburg" });
  const { plans } = await planEventProductionUpgrade([second, third, first, historic]);
  const slug = event => plans.find(plan => plan.eventId.equals(event._id))?.update.$set.slug;
  assert.equal(slug(first), "welcome-night-2209");
  assert.equal(slug(second), "welcome-night-2209-2");
  assert.equal(slug(third), "welcome-night");
  assert.equal(slug(historic), undefined);
  const ordered = await planEventProductionUpgrade([historic, first, third, second]);
  assert.deepEqual(ordered.plans, plans);
});

test("a second run is a no-op, including BSON dates and embedded ObjectIds", async () => {
  const original = fixture();
  const { plans } = await planEventProductionUpgrade([original]);
  applyUpdate(original, plans[0].update);
  const repeat = await planEventProductionUpgrade([original]);
  assert.equal(repeat.summary.pending, 0);
  assert.equal(repeat.plans.length, 0);
});

test("invalid timer shapes and duplicate regional slugs block preflight", async () => {
  for (const timer of ["not-a-date", "2026-09-22T19:00:00", false, 100]) {
    await assert.rejects(planEventProductionUpgrade([fixture({ earlyBird: { isEnabled: true, ticketTimer: timer } })]), /earlyBird.ticketTimer/);
  }
  await assert.rejects(planEventProductionUpgrade([fixture({ slug: "same" }), fixture({ slug: "same", region: "breda_tilburg" })]), /duplicate region\/slug/);
  await assert.rejects(planEventProductionUpgrade([fixture({ product: { promoCodes: "malformed" } })]), /product.promoCodes/);
});

const regionalIndex = { name: "event_region_slug_unique", key: { region: 1, slug: 1 }, unique: true, partialFilterExpression: { slug: { $type: "string" } } };

function database(rows, { concurrentEdit, backupFailure = false, indexes = [regionalIndex] } = {}) {
  const calls = [];
  const backups = new Map();
  const events = {
    indexes: async () => indexes,
    find: (_filter, { projection }) => ({ toArray: async () => rows.map(row => clone(Object.fromEntries(Object.keys(projection).filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])))) }),
    updateOne: async (filter, update) => {
      calls.push("update");
      const row = rows.find(row => row._id.equals(filter._id));
      concurrentEdit?.(row);
      const matches = row && filter.$and.every(clause => Object.entries(clause).every(([key, condition]) => condition.$exists === Object.hasOwn(row, key) && (!condition.$exists || isDeepStrictEqual(row[key], condition.$eq))));
      if (!matches) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(row, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  return { calls, backups, collection(name) {
    if (name === "events") return events;
    assert.equal(name, BACKUP_COLLECTION);
    return { updateOne: async (filter, update) => {
      calls.push("backup");
      if (backupFailure) throw new Error("Backup unavailable");
      if (!backups.has(filter._id)) backups.set(filter._id, update.$setOnInsert);
    } };
  } };
}

test("dry run never writes or creates backups; apply backs up first and is resumable", async () => {
  const row = fixture();
  const db = database([row]);
  const dry = await upgradeProductionEvents(db);
  assert.equal(dry.pending, 1);
  assert.equal(dry.modified, 0);
  assert.deepEqual(db.calls, []);
  await migration.up(db);
  assert.deepEqual(db.calls, ["backup", "update"]);
  const backup = [...db.backups.values()][0];
  assert.equal(backup.before.region, "breda");
  assert.ok(backup.missingBefore.includes("slug"));
  assert.equal(backup.before.guestList, undefined);
  assert.ok(!Object.keys(backup.update.$set).some(path => path.startsWith("guestList")));
  assert.equal((await upgradeProductionEvents(db, { apply: true })).modified, 0);
  assert.equal(db.backups.size, 1);
});

test("preflight checks all events before any write", async () => {
  const db = database([fixture(), fixture({ earlyBird: { ticketTimer: "bad" } })]);
  await assert.rejects(upgradeProductionEvents(db, { apply: true }), /earlyBird.ticketTimer/);
  assert.deepEqual(db.calls, []);
});

test("a concurrent commercial edit stops the migration instead of overwriting it", async () => {
  const row = fixture();
  const db = database([row], { concurrentEdit: record => { record.product.guest.price = 99; } });
  await assert.rejects(upgradeProductionEvents(db, { apply: true }), /changed during migration/);
  assert.equal(row.product.guest.price, 99);
  assert.equal(row.slug, undefined);
});

test("a concurrent ticket sale is preserved and does not block unrelated field updates", async () => {
  const row = fixture();
  const db = database([row], { concurrentEdit: record => record.guestList.push({ ticket: "new-ticket" }) });
  assert.equal((await upgradeProductionEvents(db, { apply: true })).modified, 1);
  assert.equal(row.guestList.length, 2);
  assert.equal(row.guestList[1].ticket, "new-ticket");
});

test("backup failure prevents the event update", async () => {
  const db = database([fixture()], { backupFailure: true });
  await assert.rejects(upgradeProductionEvents(db, { apply: true }), /Backup unavailable/);
  assert.deepEqual(db.calls, ["backup"]);
});

test("promotion and promo expiry dates normalize without imposing start or expiration dates", async () => {
  const event = fixture({ promotion: {
    guest: { isEnabled: true, discount: 20, startTimer: "", endTimer: null },
    member: { isEnabled: true, discount: 10, startTimer: "2026-09-22T19:00:00+02:00" },
  } });
  event.product.promoCodes[0].timeLimit = date.toISOString();
  const normalized = normalizeLegacyEvent(event);
  assert.equal(Object.hasOwn(normalized.promotion.guest, "startTimer"), false);
  assert.equal(normalized.promotion.guest.endTimer, null);
  assert.equal(Object.hasOwn(normalized.promotion.member, "endTimer"), false);
  assert.deepEqual(normalized.promotion.member.startTimer, date);
  assert.deepEqual(normalized.product.promoCodes[0].timeLimit, date);
  assert.equal(normalized.promotion.guest.isEnabled, true);
  assert.equal(normalized.promotion.guest.discount, 20);
  const { plans } = await planEventProductionUpgrade([event]);
  applyUpdate(event, plans[0].update);
  assert.equal((await planEventProductionUpgrade([event])).summary.pending, 0);
});

test("ambiguous or impossible promotion/promo deadlines block the entire plan before writing", async () => {
  for (const invalid of ["2026-02-30T12:00:00Z", "2026-09-22T24:00:00Z", "2026-09-22T12:00:00", "tomorrow", false]) {
    for (const target of ["promotion", "promoCode"]) {
      const event = fixture();
      if (target === "promotion") event.promotion.guest.endTimer = invalid;
      else event.product.promoCodes[0].timeLimit = invalid;
      const db = database([fixture(), event]);
      await assert.rejects(upgradeProductionEvents(db, { apply: true }), /unexpected (promotion.guest.endTimer|product.promoCodes.0.timeLimit)/);
      assert.deepEqual(db.calls, []);
    }
  }
});

test("apply requires the regional slug constraint and removal of the legacy global constraint", async () => {
  const globalIndex = { key: { slug: 1 }, unique: true, sparse: true };
  for (const indexes of [[], [globalIndex], [regionalIndex, globalIndex], [{ ...regionalIndex, unique: false }], [{ ...regionalIndex, collation: { locale: "en" } }]]) {
    const db = database([fixture()], { indexes });
    assert.equal((await upgradeProductionEvents(db)).modified, 0);
    await assert.rejects(upgradeProductionEvents(db, { apply: true }), /requires migration 006/);
    assert.deepEqual(db.calls, []);
  }
  assert.deepEqual(eventSlugIndexReadiness([regionalIndex]), { regionalUnique: true, legacyGlobalUnique: false });
});

test("only active events change; malformed historical records are not normalized or backed up", async () => {
  const now = new Date("2026-09-27T12:00:00Z");
  const active = fixture();
  const excluded = [
    fixture({ status: "archived" }), fixture({ status: "draft" }), fixture({ status: "cancelled" }), fixture({ status: "canceled" }),
    fixture({ date: new Date("2026-09-01"), correctedDate: undefined }),
    fixture({ date: new Date("2099-01-01"), correctedDate: new Date("2026-09-01") }),
    fixture({ status: "archived", title: null, product: "invalid", earlyBird: { ticketTimer: "bad" } }),
  ];
  const before = clone({ excluded });
  const db = database([active, ...excluded]);
  const result = await upgradeProductionEvents(db, { apply: true, now });
  assert.equal(result.active, 1);
  assert.equal(result.skipped, excluded.length);
  assert.equal(result.modified, 1);
  assert.deepEqual(clone({ excluded }), before);
  assert.equal(db.backups.size, 1);
  assert.ok([...db.backups.values()][0].eventId.equals(active._id));
});

test("scope uses the corrected event date and includes upcoming events with closed sales", () => {
  const now = new Date("2026-09-27T12:00:00Z");
  for (const status of ["opened", "closed", "temporary closed"]) {
    assert.equal(isActiveUpgradeEvent({ status, date: now }, now), true);
    assert.equal(isActiveUpgradeEvent({ status, date: new Date(now - 1) }, now), false);
    assert.equal(isActiveUpgradeEvent({ status, date: new Date(now - 1), correctedDate: now }, now), true);
  }
  assert.equal(isActiveUpgradeEvent({ status: "opened", date: "invalid" }, now), false);
});

test("concurrent archiving or rescheduling stops the update", async () => {
  for (const concurrentEdit of [record => { record.status = "archived"; }, record => { record.correctedDate = new Date("2000-01-01"); }]) {
    const record = fixture();
    const db = database([record], { concurrentEdit });
    await assert.rejects(upgradeProductionEvents(db, { apply: true }), /changed during migration/);
    assert.equal(record.slug, undefined);
    assert.equal(record.bgImage, 1);
  }
});

test("the earlier background cleanup also limits event documents to active dates and statuses", async () => {
  const calls = [];
  await backgroundMigration.up({ collection: name => ({ updateMany: async (filter, update) => {
    calls.push({ name, filter, update });
    return { modifiedCount: 0 };
  } }) });
  const event = calls.find(call => call.name === "events");
  assert.deepEqual(event.filter.status, { $in: ["opened", "closed", "temporary closed"] });
  assert.deepEqual(event.filter.$expr.$gte[0], { $ifNull: ["$correctedDate", "$date"] });
  assert.ok(event.filter.$expr.$gte[1] instanceof Date);
});

import assert from "node:assert/strict";
import test from "node:test";
import migration, { initialRegionEmails } from "../migrations/012-region-contacts.js";
import RegionContact from "../models/RegionContact.js";
import { createRegionEmailsHandler, loadRegionEmails } from "../services/region-contacts.js";

test("migration seeds all ten addresses without overwriting database edits", async () => {
  const documents = new Map([["amsterdam", { _id: "amsterdam", email: "changed@example.com" }]]);
  const db = { collection(name) {
    assert.equal(name, "regionContacts");
    return { async updateOne({ _id }, update, options) {
      assert.equal(options.upsert, true);
      if (!documents.has(_id)) documents.set(_id, { _id, ...update.$setOnInsert });
    } };
  } };
  await migration.up(db);
  await migration.up(db);
  assert.equal(documents.size, 10);
  assert.equal(documents.get("amsterdam").email, "changed@example.com");
  for (const [key, email] of Object.entries(initialRegionEmails)) {
    if (key !== "amsterdam") assert.equal(documents.get(key).email, email);
  }
});

test("directory schema enforces known keys and valid normalized addresses", async () => {
  const contact = new RegionContact({ _id: "groningen", email: " TEAM@EXAMPLE.COM " });
  await contact.validate();
  assert.equal(contact.email, "team@example.com");
  await assert.rejects(new RegionContact({ _id: "unknown", email: "x@example.com" }).validate());
  await assert.rejects(new RegionContact({ _id: "groningen", email: "bad\r\nvalue" }).validate());
});

test("directory read only returns validated public addresses, not unrelated fields", async () => {
  const ContactModel = { find(query) {
    assert.equal(query._id.$in.length, 10);
    return { select(fields) {
      assert.deepEqual(fields, { _id: 1, email: 1 });
      return { maxTimeMS(timeout) {
        assert.equal(timeout, 5000);
        return { lean: async () => [
          { _id: "groningen", email: " Team@Example.com ", secret: "never exposed" },
          { _id: "support", email: "broken" },
          { _id: "unexpected", email: "other@example.com" },
        ] };
      } };
    } };
  } };
  assert.deepEqual(await loadRegionEmails({ ContactModel }), { groningen: "team@example.com" });
});

test("public endpoint handles seeded, empty and unavailable directories safely", async () => {
  for (const [loadContacts, expected] of [
    [async () => ({ groningen: "team@example.com" }), 200],
    [async () => ({}), 503],
    [async () => { throw new Error("private database details"); }, 503],
  ]) {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await createRegionEmailsHandler({ loadContacts })({}, res);
    assert.equal(res.code, expected);
    assert.doesNotMatch(JSON.stringify(res.body), /private database details/);
    if (expected === 200) assert.deepEqual(res.body, { emails: { groningen: "team@example.com" } });
  }
});

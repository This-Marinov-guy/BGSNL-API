import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";
import { runMigrations } from "../services/migrations/runner.js";
import eleven from "../migrations/011-ticket-tokens-into-guest-list.js";

// eslint-disable-next-line no-process-env
const uri = process.env.BGSNL_MIGRATION_TEST_URL;
if (uri && !/^mongodb:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/.test(uri)) throw new Error("Migration integration tests only accept a local MongoDB host without a database");
const options = { writersStopped: true, log: () => {} };
const groupToken = "aaaaaaaaaaaaaaaaaaaaaa";
const soloToken = "bbbbbbbbbbbbbbbbbbbbbb";

async function setup(t) {
  const client = await new MongoClient(uri).connect();
  const db = client.db(`bgsnl_ticket_token_test_${randomUUID().replaceAll("-", "")}`);
  t.after(async () => { await db.dropDatabase(); await client.close(); });
  return db;
}

async function seed(db) {
  const eventId = new ObjectId();
  const otherId = new ObjectId();
  await db.collection("events").insertMany([
    { _id: eventId, title: "Group event", guestList: [
      { _id: new ObjectId(), code: 4417, name: "Ana" },
      { _id: new ObjectId(), code: 4417, name: "Ivo" },
      { _id: new ObjectId(), code: 9022, name: "Mila" },
    ] },
    { _id: otherId, title: "Untouched event", guestList: [{ _id: new ObjectId(), code: 4417, name: "Other" }] },
  ]);
  await db.collection("ticketqrs").insertMany([
    { _id: new ObjectId(), eventId, code: "4417", token: groupToken },
    { _id: new ObjectId(), eventId, code: "9022", token: soloToken },
    { _id: new ObjectId(), eventId, code: "5555", token: "cccccccccccccccccccccc" }, // no guest bought this
  ]);
  return { eventId, otherId };
}

const tokensFor = (event, code) => event.guestList.filter(row => row.code === code).map(row => row.ticketToken);

test("011 moves tokens onto every guest of a purchase and drops the collection", { skip: !uri }, async t => {
  const db = await setup(t);
  const { eventId, otherId } = await seed(db);

  const result = await runMigrations(db, [eleven], options);
  assert.equal(result.status, "succeeded");

  const event = await db.collection("events").findOne({ _id: eventId });
  // A group purchase shares one token: the whole group is admitted by one image.
  assert.deepEqual(tokensFor(event, 4417), [groupToken, groupToken]);
  assert.deepEqual(tokensFor(event, 9022), [soloToken]);

  // The same purchase code on a different event must not be touched.
  const other = await db.collection("events").findOne({ _id: otherId });
  assert.equal(other.guestList[0].ticketToken, undefined);

  assert.equal((await db.listCollections({ name: "ticketqrs" }).toArray()).length, 0);
  const index = (await db.collection("events").indexes()).find(item => item.name === "guestlist_ticket_token");
  assert.deepEqual(index.key, { "guestList.ticketToken": 1 });
  assert.notEqual(index.unique, true);
});

test("011 rolls back fully, restoring ticketqrs and leaving no tokens behind", { skip: !uri }, async t => {
  const db = await setup(t);
  const { eventId } = await seed(db);

  await assert.rejects(runMigrations(db, [eleven, { id: "012-fail", async up() { throw new Error("Injected failure"); } }], options),
    error => error.result.status === "rolledBack" && error.result.safeToResume);

  const event = await db.collection("events").findOne({ _id: eventId });
  assert.deepEqual(event.guestList.map(row => row.ticketToken), [undefined, undefined, undefined]);
  assert.equal(await db.collection("ticketqrs").countDocuments(), 3);
  assert.equal(await db.collection("_migrations").countDocuments(), 0);
});

test("011 is safe to run where ticketqrs was never created", { skip: !uri }, async t => {
  const db = await setup(t);
  await db.collection("events").insertOne({ _id: new ObjectId(), guestList: [{ code: 1, name: "Solo" }] });
  assert.equal((await runMigrations(db, [eleven], options)).status, "succeeded");
  assert.ok((await db.collection("events").indexes()).some(item => item.name === "guestlist_ticket_token"));
});

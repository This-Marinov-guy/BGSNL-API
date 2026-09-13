import { randomUUID } from "node:crypto";
import { EJSON } from "bson";
import { redisClient, redisPrefix } from "./redis.js";
import { matchesRecord, recordQuery, updateRecord } from "./record-operations.js";
const cas = `local old = redis.call('GET', KEYS[1])
if (ARGV[1] == '' and old) or (ARGV[1] ~= '' and old ~= ARGV[1]) then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[1])
elseif tonumber(ARGV[3]) > 0 then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
else return redis.error_reply('A finite expiry is required') end
return 1`;
const duplicate = () => Object.assign(new Error("Record already exists"), { code: 11000 });
// A small CAS repository for bounded operational state, NOT payment history.
// Expiring records retain their absolute deadline; reads never extend a token.
export function redisRecordStore(namespace, { ttlMs, expiresAtFor, clientFor = redisClient } = {}) {
  if (!/^[a-z-]+$/.test(namespace)) throw new Error("Invalid Redis namespace");
  if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)) throw new Error("Invalid Redis lifetime");
  const remainingLifetime = (record) => {
    if (expiresAtFor) record.expiresAt = new Date(expiresAtFor(record));
    if (!record.expiresAt && ttlMs) record.expiresAt = new Date(+new Date(record.createdAt) + ttlMs);
    const deadline = record.expiresAt && +new Date(record.expiresAt);
    if (!Number.isSafeInteger(deadline)) throw new Error("A finite Redis expiry is required");
    return deadline - Date.now();
  };
  const prefix = () => `${redisPrefix()}${namespace}:`;
  const keyFor = (id) => prefix() + Buffer.from(String(id)).toString("base64url");
  const decode = (raw) => raw ? EJSON.parse(raw) : null;
  async function candidates(query) {
    const client = await clientFor();
    if (typeof query._id === "string") return [[keyFor(query._id), await client.get(keyFor(query._id))]];
    const rows = [];
    for await (const keys of client.scanIterator({ MATCH: `${prefix()}*`, COUNT: 100 })) {
      for (const key of keys) { const raw = await client.get(key); if (raw) rows.push([key, raw]); }
    }
    return rows;
  }
  const find = (query) => recordQuery(async () => (await candidates(query)).map(([, raw]) => decode(raw)).filter((row) => matchesRecord(row, query)));
  async function mutate(query, update, options = {}, remove = false) {
    if (options.session) throw new Error("Redis cannot participate in a MongoDB transaction");
    const client = await clientFor();
    for (let attempt = 0; attempt < 20; attempt++) {
      const rows = await candidates(query);
      const match = rows.find(([, raw]) => matchesRecord(decode(raw), query));
      if (!match && !options.upsert) return { value: null, inserted: false };
      if (!match && rows.some(([, raw]) => raw) && typeof query._id === "string") throw duplicate();
      const previous = match ? decode(match[1]) : { _id: query._id || randomUUID(), createdAt: new Date() };
      if (typeof previous._id !== "string") throw new Error("An exact key is required to insert operational state");
      const record = updateRecord(previous, update, !match);
      record.updatedAt = new Date();
      const remaining = remove ? 0 : remainingLifetime(record);
      const deleting = remove || remaining <= 0;
      const ok = await client.eval(cas, { keys: [keyFor(record._id)], arguments: [match?.[1] || "", deleting ? "" : EJSON.stringify(record), String(Math.max(0, remaining))] });
      if (ok) return { value: remove ? previous : record, inserted: !match };
    }
    throw new Error("Concurrent operational state update; retry required");
  }
  const store = {
    find,
    findOne: (query) => recordQuery(() => find(query), true),
    findById: (id) => store.findOne({ _id: id }),
    exists: async (query) => !!await store.findOne(query),
    countDocuments: async (query) => (await find(query)).length,
    findOneAndUpdate: (query, update, options) => recordQuery(async () => (await mutate(query, update, options)).value),
    updateOne: async (query, update, options) => { const result = await mutate(query, update, options); return { matchedCount: result.value && !result.inserted ? 1 : 0, upsertedCount: result.inserted ? 1 : 0 }; },
    findOneAndDelete: (query, options) => recordQuery(async () => (await mutate(query, {}, options, true)).value),
    deleteOne: async (query, options) => ({ deletedCount: await store.findOneAndDelete(query, options) ? 1 : 0 }),
    async deleteMany(query) { let count = 0; for (const row of await find(query)) count += (await store.deleteOne({ ...query, _id: row._id })).deletedCount; return { deletedCount: count }; },
    async create(record) {
      record = { ...record, _id: record._id || randomUUID(), createdAt: record.createdAt || new Date() };
      const client = await clientFor();
      const remaining = remainingLifetime(record);
      if (remaining <= 0) throw new Error("Cannot create expired operational state");
      if (!await client.eval(cas, { keys: [keyFor(record._id)], arguments: ["", EJSON.stringify(record), String(remaining)] })) throw duplicate();
      return record;
    },
  };
  return store;
}

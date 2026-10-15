import mongoose from "mongoose";

const asObjectId = value => typeof value === "string" && mongoose.isValidObjectId(value)
  ? new mongoose.Types.ObjectId(value) : value;
const normalize = (filter, parentIdField) => Object.fromEntries(Object.entries(filter || {}).map(([key, value]) => {
  if (key === "$or" || key === "$and") return [key, value.map(clause => normalize(clause, parentIdField))];
  return [key, key === parentIdField ? asObjectId(value) : value];
}));
const prefixed = (filter, field) => Object.fromEntries(Object.entries(filter).map(([key, value]) =>
  key === "$or" || key === "$and" ? [key, value.map(clause => prefixed(clause, field))] : [`${field}.${key}`, value]));
const projection = fields => {
  if (!fields) return null;
  if (typeof fields === "object") return fields;
  const parts = fields.split(/\s+/).filter(Boolean);
  const include = parts.filter(part => !part.startsWith("-"));
  if (include.length) return Object.fromEntries([...include.map(part => [part, 1]), ...parts.filter(part => part.startsWith("-")).map(part => [part.slice(1), 0])]);
  return Object.fromEntries(parts.map(part => [part.slice(1), 0]));
};

class EmbeddedQuery {
  constructor(run) { this.run = run; this.sortBy = null; this.max = null; this.fields = null; }
  select(fields) { this.fields = fields; return this; }
  sort(fields) { this.sortBy = fields; return this; }
  limit(value) { this.max = value; return this; }
  lean() { return this.run({ sort: this.sortBy, limit: this.max, fields: this.fields }); }
  then(resolve, reject) { return this.lean().then(resolve, reject); }
}

// Atomic positional updates keep retry/operation IDs inside their parent record.
// This preserves the existing Mongoose-like delivery API while avoiding a
// separate collection for each event or monthly-summary workflow.
export function createEmbeddedRecords({ ParentModel, field, parentIdField = "eventId" }) {
  const collection = () => ParentModel.collection;
  const list = (filter, { sort, limit, fields } = {}) => {
    const match = normalize(filter, parentIdField);
    const pipeline = [
      { $match: { [field]: { $elemMatch: match } } },
      { $unwind: `$${field}` },
      { $match: prefixed(match, field) },
      { $replaceRoot: { newRoot: `$${field}` } },
    ];
    if (sort) pipeline.push({ $sort: sort });
    if (Number.isSafeInteger(limit) && limit > 0) pipeline.push({ $limit: limit });
    const selected = projection(fields);
    if (selected) pipeline.push({ $project: selected });
    return collection().aggregate(pipeline).toArray();
  };
  const one = async filter => (await list(filter, { limit: 1 }))[0] || null;
  const parent = value => ({ _id: asObjectId(value) });
  const inserted = (filter, update) => ({ ...(update.$setOnInsert || {}), ...(filter._id ? { _id: filter._id } : {}) });
  const updateOne = async (input, update, options = {}) => {
    const filter = normalize(input, parentIdField);
    if (update.$setOnInsert && options.upsert) {
      const record = inserted(filter, update);
      if (!record._id || !record[parentIdField]) throw new Error(`Missing embedded ${field} identity`);
      record[parentIdField] = asObjectId(record[parentIdField]);
      const identity = filter.key ? { key: filter.key } : { _id: record._id };
      const result = await collection().updateOne({ ...parent(record[parentIdField]),
        [field]: { $not: { $elemMatch: identity } } }, { $push: { [field]: record } });
      if (!result.matchedCount && !await one(identity)) throw new Error(`Parent record missing for ${field}`);
      return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount,
        upsertedCount: result.modifiedCount };
    }
    const changes = {};
    for (const operator of ["$set", "$inc", "$unset", "$max"]) {
      if (update[operator]) changes[operator] = Object.fromEntries(Object.entries(update[operator])
        .map(([key, value]) => [`${field}.$.${key}`, value]));
    }
    return collection().updateOne({ [field]: { $elemMatch: filter } }, changes);
  };
  const findOneAndUpdate = (filter, update, options = {}) => new EmbeddedQuery(async () => {
    if (options.upsert) {
      await updateOne(filter, update, options);
      return one(filter);
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidate = await one(filter);
      if (!candidate) return null;
      const condition = normalize({ ...filter, _id: candidate._id }, parentIdField);
      const changes = {};
      for (const operator of ["$set", "$inc", "$unset", "$max"]) {
        if (update[operator]) changes[operator] = Object.fromEntries(Object.entries(update[operator])
          .map(([key, value]) => [`${field}.$.${key}`, value]));
      }
      const result = await collection().findOneAndUpdate({ ...parent(candidate[parentIdField]),
        [field]: { $elemMatch: condition } }, changes, { returnDocument: "after" });
      if (result.value) return result.value[field].find(row => row._id === candidate._id) || null;
    }
    return null;
  });
  return {
    find: filter => new EmbeddedQuery(options => list(filter, options)),
    findOne: filter => new EmbeddedQuery(() => one(filter)),
    findById: id => new EmbeddedQuery(() => one({ _id: id })),
    findOneAndUpdate, updateOne,
    updateMany: async (filter, update) => {
      const rows = await list(filter);
      let modifiedCount = 0;
      for (const row of rows) modifiedCount += (await updateOne({ ...filter, _id: row._id }, update)).modifiedCount || 0;
      return { modifiedCount };
    },
    exists: async filter => Boolean(await one(filter)),
    countDocuments: async filter => (await list(filter)).length,
    aggregate: async pipeline => {
      const rows = await list(pipeline[0]?.$match || {});
      if (pipeline[1]?.$group?._id !== "$status") throw new Error("Unsupported embedded-record aggregation");
      const counts = new Map();
      for (const row of rows) counts.set(row.status, (counts.get(row.status) || 0) + 1);
      return [...counts].map(([_id, count]) => ({ _id, count }));
    },
    create: async record => {
      const result = await updateOne({ _id: record._id }, { $setOnInsert: record }, { upsert: true });
      if (!result.modifiedCount) throw Object.assign(new Error("Duplicate embedded record"), { code: 11000 });
      return record;
    },
  };
}

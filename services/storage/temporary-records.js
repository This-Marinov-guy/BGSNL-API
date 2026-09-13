import mongoose from "mongoose";
const prefixQuery = (query, prefix) => Object.fromEntries(Object.entries(query).map(([key, value]) => {
  if (["$or", "$and"].includes(key)) return [key, value.map((part) => prefixQuery(part, prefix))];
  if (key === "_id") {
    if (typeof value === "string") return [key, prefix + value];
    if (value?.$in) return [key, { $in: value.$in.map((id) => prefix + id) }];
    throw new Error("Temporary records require exact IDs");
  }
  return [key, value];
}));
// Account-change challenges share one TTL collection while retaining Mongo
// transactions. Namespaced IDs isolate a reset and a profile change on one user.
export function temporaryRecordStore(name, schema) {
  const prefix = `${name}:`;
  schema.add({ recordType: { type: String, default: name, immutable: true } });
  const Model = mongoose.model(name, schema, "temporarycodes");
  const decode = (value) => {
    if (Array.isArray(value)) return value.map(decode);
    if (!value || !value._id) return value;
    const data = value.toObject ? value.toObject() : value;
    return { ...data, _id: String(data._id).slice(prefix.length) };
  };
  const wrap = (query) => {
    const result = { then: (resolve, reject) => query.then(decode).then(resolve, reject) };
    for (const method of ["session", "select", "lean", "sort", "limit"]) result[method] = (...args) => { query[method](...args); return result; };
    return result;
  };
  const scoped = (query) => ({ ...prefixQuery(query, prefix), recordType: name });
  const updates = (update) => Object.fromEntries(Object.entries(update).map(([op, fields]) => [op, prefixQuery(fields, prefix)]));
  return {
    schema, collection: Model.collection, init: () => Model.init(), createCollection: () => Model.createCollection(),
    find: (query) => wrap(Model.find(scoped(query))),
    findOne: (query) => wrap(Model.findOne(scoped(query))),
    findById: (id) => wrap(Model.findOne(scoped({ _id: id }))),
    findOneAndUpdate: (query, update, options) => wrap(Model.findOneAndUpdate(scoped(query), updates(update), options)),
    updateOne: (query, update, options) => Model.updateOne(scoped(query), updates(update), options),
    deleteOne: (query, options) => Model.deleteOne(scoped(query), options),
    deleteMany: (query, options) => Model.deleteMany(scoped(query), options),
    findOneAndDelete: (query, options) => wrap(Model.findOneAndDelete(scoped(query), options)),
    async create(data, options) {
      const encode = (item) => ({ ...item, _id: prefix + item._id, recordType: name });
      return decode(await Model.create(Array.isArray(data) ? data.map(encode) : encode(data), options));
    },
  };
}

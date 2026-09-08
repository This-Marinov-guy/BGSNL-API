// Test-only Mongo-shaped store. No connections, credentials or external writes.
const clone = (value) => value == null ? value : structuredClone(value);
function matches(record, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "messages.id") return !record.messages.some(({ id }) => id === expected.$ne);
    if (expected && typeof expected === "object" && "$in" in expected) return expected.$in.includes(record[key]);
    return record[key] === expected;
  });
}
class Query {
  constructor(read) { this.read = read; this.offset = 0; this.maximum = Infinity; }
  select(fields) { this.fields = fields; return this; }
  sort(value) { this.sortBy = value; return this; }
  skip(value) { this.offset = value; return this; }
  limit(value) { this.maximum = value; return this; }
  async lean() {
    let result = clone(this.read());
    if (Array.isArray(result)) {
      result.sort((left, right) => Number(new Date(right.lastMessageAt)) - Number(new Date(left.lastMessageAt)) || right._id.localeCompare(left._id));
      result = result.slice(this.offset, this.offset + this.maximum);
    }
    if (this.fields && !this.fields.startsWith("+")) {
      const fields = this.fields.split(" ");
      const project = (record) => Object.fromEntries(fields.filter((key) => key in record).map((key) => [key, record[key]]));
      result = Array.isArray(result) ? result.map(project) : result && project(result);
    }
    return result;
  }
}
export function memorySupportStore() {
  const data = new Map();
  return { data, conflicts: 0,
    findById(id) { return new Query(() => data.get(id) || null); },
    find(filter) { return new Query(() => [...data.values()].filter((record) => matches(record, filter))); },
    async create(input) {
      if (data.has(input._id)) throw Object.assign(new Error("Duplicate"), { code: 11000 });
      data.set(input._id, clone(input));
      return { toObject: () => clone(input) };
    },
    findOneAndUpdate(filter, update) {
      return new Query(() => {
        if (this.conflicts > 0) { this.conflicts--; return null; }
        const record = data.get(filter._id);
        if (!record || !matches(record, filter)) return null;
        for (const [key, value] of Object.entries(update.$set || {})) record[key] = clone(value);
        for (const [key, value] of Object.entries(update.$inc || {})) record[key] += value;
        for (const [key, value] of Object.entries(update.$push || {})) record[key].push(clone(value));
        record.updatedAt = new Date();
        return record;
      });
    },
  };
}

// Isolated Mongoose-shaped store: no database, accounts, email or Stripe writes.
export function memorySessionStore() {
  const rows = new Map();
  const copy = (value) => value ? structuredClone(value) : null;
  function matches(row, query) {
    return row && Object.entries(query).every(([key, value]) => value?.$gt ? +row[key] > +value.$gt : row[key] === value);
  }
  function update(row, change) {
    Object.assign(row, change.$set);
    for (const [key, value] of Object.entries(change.$max || {})) if (+value > +row[key]) row[key] = value;
    return copy(row);
  }
  return {
    rows,
    create: async (record) => { rows.set(record._id, copy(record)); return copy(record); },
    findById(id) { return { select() { return this; }, lean: async () => copy(rows.get(id)) }; },
    findOneAndUpdate(query, change) { return { lean: async () => {
      const row = rows.get(query._id);
      return matches(row, query) ? update(row, change) : null;
    } }; },
    updateOne: async (query, change) => {
      const row = rows.get(query._id);
      if (matches(row, query)) update(row, change);
    },
  };
}

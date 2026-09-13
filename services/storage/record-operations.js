import { isDeepStrictEqual } from "node:util";
export const getPath = (record, path) => path.split(".").reduce((value, part) => value?.[part], record);
export function setPath(record, path, value, remove = false) {
  const parts = path.split(".");
  if (parts.some((part) => ["__proto__", "prototype", "constructor"].includes(part))) throw new Error("Unsafe storage path");
  const last = parts.pop();
  const parent = parts.reduce((value, part) => value[part] ||= {}, record);
  if (remove) delete parent[last]; else parent[last] = value;
}
export function matchesRecord(record, query) {
  if (!record) return false;
  return Object.entries(query).every(([key, expected]) => {
    if (key === "$or") return expected.some((item) => matchesRecord(record, item));
    if (key === "$and") return expected.every((item) => matchesRecord(record, item));
    const actual = getPath(record, key);
    if (expected instanceof RegExp) return expected.test(String(actual ?? ""));
    if (expected && typeof expected === "object" && !(expected instanceof Date) && !Array.isArray(expected)) {
      return Object.entries(expected).every(([op, value]) => {
        switch (op) {
          case "$exists": return (actual !== undefined) === value;
          case "$gt": return actual > value;
          case "$gte": return actual >= value;
          case "$lt": return actual < value;
          case "$lte": return actual <= value;
          case "$ne": return !isDeepStrictEqual(actual, value);
          case "$in": return value.some((item) => isDeepStrictEqual(actual, item));
          case "$nin": return !value.some((item) => isDeepStrictEqual(actual, item));
          default: throw new Error(`Unsupported storage filter ${op}`);
        }
      });
    }
    return expected === null ? actual == null : isDeepStrictEqual(actual, expected);
  });
}
export function updateRecord(previous, update, inserting = false) {
  const record = structuredClone(previous);
  for (const [operation, fields] of Object.entries(update)) {
    if (!["$set", "$setOnInsert", "$unset", "$inc", "$max"].includes(operation)) throw new Error(`Unsupported storage update ${operation}`);
    if (operation === "$setOnInsert" && !inserting) continue;
    for (const [key, value] of Object.entries(fields)) {
      if (operation === "$inc") setPath(record, key, (getPath(record, key) || 0) + value);
      else if (operation === "$max") { if (getPath(record, key) === undefined || getPath(record, key) < value) setPath(record, key, value); }
      else setPath(record, key, value, operation === "$unset");
    }
  }
  return record;
}
export function recordQuery(run, single = false) {
  let order = {}, maximum = Infinity;
  const query = {
    sort(value) { order = value; return query; }, limit(value) { maximum = value; return query; },
    select() { return query; }, lean() { return query; },
    then(resolve, reject) { return run().then((values) => {
      if (!Array.isArray(values)) return values;
      values.sort((a, b) => {
        for (const [key, direction] of Object.entries(order)) {
          const x = getPath(a, key), y = getPath(b, key);
          if (x < y || x == null && y != null) return -direction;
          if (x > y || x != null && y == null) return direction;
        }
        return 0;
      });
      return single ? values[0] || null : values.slice(0, maximum);
    }).then(resolve, reject); },
  };
  return query;
}

import { observeIntegrationRequest } from "../../middleware/axiom-logger.js";

const methods = { get: "GET", batchGet: "GET", append: "POST", update: "PUT", batchUpdate: "POST", clear: "POST",
  batchClear: "POST", create: "POST", delete: "DELETE" };

const instrumentMethods = (target, prefix) => new Proxy(target, {
  get(object, key, receiver) {
    const value = Reflect.get(object, key, receiver);
    if (typeof key !== "string" || !Object.hasOwn(methods, key) || typeof value !== "function") return value;
    return (...args) => observeIntegrationRequest("google-sheets", `${prefix}-${key.replaceAll(/([A-Z])/g, '-$1').toLowerCase()}`,
      methods[key], () => value.apply(object, args));
  },
});

export const instrumentSheetsClient = (client) => {
  const spreadsheets = client.spreadsheets;
  const values = instrumentMethods(spreadsheets.values, "values");
  const tracedSpreadsheets = new Proxy(spreadsheets, {
    get(target, key, receiver) {
      if (key === "values") return values;
      const value = Reflect.get(target, key, receiver);
      if (typeof key !== "string" || !Object.hasOwn(methods, key) || typeof value !== "function") return value;
      return (...args) => observeIntegrationRequest("google-sheets", `spreadsheets-${key.replaceAll(/([A-Z])/g, '-$1').toLowerCase()}`,
        methods[key], () => value.apply(target, args));
    },
  });
  // googleapis defines `spreadsheets` as non-configurable and non-writable.
  // A proxy cannot return a different value for that property.
  return { ...client, spreadsheets: tracedSpreadsheets };
};

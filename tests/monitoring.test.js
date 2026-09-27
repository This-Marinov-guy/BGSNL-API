import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWebEvent } from "../routes/monitoring-routes.js";
import { axiomOverview } from "../services/monitoring/overview.js";
import { buildError, buildReq } from "../util/logging/axiom-log-models.js";
import { MONITORING_ACCESS } from "../util/config/defines.js";
import { describeError } from "../middleware/axiom-logger.js";

test("monitoring is limited to developer and administrative roles", () => {
  assert.deepEqual(MONITORING_ACCESS, ["super_admin", "admin", "developer"]);
  assert.equal(MONITORING_ACCESS.includes("support"), false);
  assert.equal(MONITORING_ACCESS.includes("active_member"), false);
});

test("web events keep fixed, privacy-minimal fields", () => {
  const event = normalizeWebEvent({ type: "client_error", path: "/events/0123456789abcdef01234567", name: "TypeError",
    component: "Calendar", cookie: "secret", email: "person@example.test", message: "private content" });
  assert.equal(event.level, "error");
  assert.equal(event.path, "/events/:id");
  assert.equal(event.error.name, "TypeError");
  assert.equal(JSON.stringify(event).includes("private content"), false);
  assert.equal(JSON.stringify(event).includes("person@example.test"), false);
  assert.equal(normalizeWebEvent({ type: "unknown" }), null);
});

test("API request logs exclude bodies, query parameters, headers and IPs", () => {
  const request = buildReq({ method: "POST", originalUrl: "/api/v1/event/foo?token=secret", body: { password: "secret" },
    query: { token: "secret" }, headers: { authorization: "Bearer secret" }, ip: "192.0.2.1" });
  assert.deepEqual(request, { method: "POST", url: "/api/v1/event/foo", path: "/api/v1/event/foo" });
});

test("Axiom overview separates web, operations and integrations", async () => {
  const query = async (apl) => {
    const data = apl.includes("by eventProvider, eventLevel") ? [{ eventProvider: "stripe", eventLevel: "error", events: 2 }] :
      apl.includes("by errorSource") ? [{ errorSource: "worker.billing", events: 1 }] :
      apl.includes("by eventType") ? [{ eventType: "page_view", events: 20 }, { eventType: "client_error", events: 1 }] :
      apl.includes("by eventLevel") ? [{ eventLevel: "info", events: 10 }, { eventLevel: "error", events: 1 }] : [];
    return { tables: [{ events: function* () { yield* data; } }] };
  };
  const result = await axiomOverview({ query });
  assert.deepEqual(result.datasets, { web: "web", operations: "operations", integrations: "integrations" });
  assert.equal(result.status, "connected");
  assert.equal(result.web.byType.page_view, 20);
  assert.equal(result.operations.byLevel.error, 1);
  assert.equal(result.integrations[0].provider, "stripe");
});

test("new empty Axiom datasets show zero activity without fake integration events", async () => {
  const queries = [];
  const query = async (apl) => {
    queries.push(apl);
    return { tables: [{ events: function* () { yield { events: 0 }; } }] };
  };
  const result = await axiomOverview({ query });
  assert.equal(result.status, "connected");
  assert.deepEqual(result.web.byType, {});
  assert.deepEqual(result.operations.byLevel, {});
  assert.deepEqual(result.integrations, []);
  assert.equal(queries.length, 6);
  assert.ok(queries.every((apl) => apl.includes("column_ifexists")));
});

test("service exception records retain safe diagnostics without messages or credentials", () => {
  const error = new Error("email person@example.test token secret-value");
  error.name = "Private person@example.test";
  error.code = "secret value";
  error.statusCode = 503;
  assert.deepEqual(describeError(error), { name: "Error", status: 503 });
  assert.deepEqual(describeError({ name: "MongoServerError", code: 11000 }), { name: "MongoServerError", code: "11000" });
  assert.deepEqual(buildError(describeError(error)), { name: "Error", code: undefined, status: 503 });
});

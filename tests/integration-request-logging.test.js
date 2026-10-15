import test from "node:test";
import assert from "node:assert/strict";

process.env.APP_ENV = "dev";
process.env.AXIOM_LOGGING_ENABLED = "false";

const { inboundIntegrationRoute, integrationRequestEvent, observeIntegrationRequest } = await import("../middleware/axiom-logger.js");
const { instrumentSheetsClient } = await import("../services/monitoring/instrument-sheets.js");
const { stripeRequestOperation } = await import("../util/config/stripe.js");

test("integration request records contain only fixed diagnostics", () => {
  const event = integrationRequestEvent("stripe", "checkout-sessions", { method: "POST", status: 503,
    durationMs: 42.6, url: "https://api.stripe.com/v1/customers/cus_private?token=secret",
    email: "member@example.test", body: { card: "private" }, requestId: "req_private" });
  assert.equal(event.level, "warning");
  assert.equal(event.outcome, "error");
  assert.equal(event.statusCode, 503);
  assert.equal(event.durationMs, 43);
  assert.equal(event.operation, "checkout-sessions");
  assert.deepEqual(Object.keys(event).sort(), ["direction", "durationMs", "level", "meta", "method", "operation", "outcome",
    "provider", "statusCode", "ts", "type"].sort());
  assert.equal(event.direction, "outbound");
  assert.equal(JSON.stringify(event).includes("private"), false);
  assert.equal(integrationRequestEvent("stripe", "cus_private", { status: 200 }).operation, "request");
});

test("inbound integration requests use fixed labels without path parameters", () => {
  assert.deepEqual(inboundIntegrationRoute("/api/v1/integrations/atlas/member-event-announcement"),
    { provider: "atlas", operation: "member-event-announcement" });
  assert.deepEqual(inboundIntegrationRoute("/api/v1/google-scripts/collections/private-members"),
    { provider: "google-scripts", operation: "collection-read" });
  assert.deepEqual(inboundIntegrationRoute("/api/v1/mobile/private-city"), { provider: "koko", operation: "city-data" });
  assert.deepEqual(inboundIntegrationRoute("/api/v1/wordpress/posts/123"), { provider: "wordpress", operation: "posts-proxy" });
  assert.equal(inboundIntegrationRoute("/api/v1/payment/event-ticket"), null);
  assert.equal(inboundIntegrationRoute("/api/v1/support/conversations"), null);
  const event = integrationRequestEvent("atlas", "member-event-announcement", { direction: "inbound", method: "POST", status: 200 });
  assert.equal(event.direction, "inbound");
  assert.equal(event.statusCode, 200);
  assert.equal(JSON.stringify(event).includes("private"), false);
});

test("observing a provider request preserves its result and failure", async () => {
  const value = { status: 202, data: { secret: "private" } };
  assert.equal(await observeIntegrationRequest("mailer", "queue-template", "POST", async () => value), value);
  const error = Object.assign(new Error("private"), { response: { status: 502 } });
  await assert.rejects(observeIntegrationRequest("mailer", "queue-template", "POST", async () => { throw error; }),
    (caught) => caught === error);
});

test("Sheets instrumentation traces method calls without changing arguments or receiver", async () => {
  const calls = [];
  const values = { async get(params) { calls.push({ self: this, params }); return { status: 200, data: { values: [["private"]] } }; } };
  const client = instrumentSheetsClient({ spreadsheets: { values } });
  const params = { spreadsheetId: "private-id", range: "Members!A:A" };
  const result = await client.spreadsheets.values.get(params);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].self, values);
  assert.equal(calls[0].params, params);
  assert.deepEqual(result.data.values, [["private"]]);
});

test("Sheets instrumentation supports the read-only spreadsheets property in googleapis", async () => {
  const values = { async get() { return { status: 200, data: { values: [["ok"]] } }; } };
  const sheets = { values };
  const client = {};
  Object.defineProperty(client, "spreadsheets", {
    value: sheets, enumerable: true, writable: false, configurable: false,
  });
  const traced = instrumentSheetsClient(client);
  assert.deepEqual((await traced.spreadsheets.values.get({})).data.values, [["ok"]]);
  assert.equal(client.spreadsheets, sheets);
});

test("Stripe request names discard resource IDs and query strings", () => {
  assert.equal(stripeRequestOperation("/v1/checkout/sessions/cs_secret?expand[]=customer"), "checkout-sessions");
  assert.equal(stripeRequestOperation("/v1/customers/cus_secret"), "customers");
  assert.equal(stripeRequestOperation("/v1/cus_secret"), "api-request");
});

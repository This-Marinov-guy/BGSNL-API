import test from "node:test";
import assert from "node:assert/strict";
import {
  createDomakinMailerClient,
  DOMAKIN_MAILER_CHANNEL,
  DOMAKIN_MAILER_FROM_ADDRESS,
} from "../services/background-services/domakin-mailer.js";

const SCOPED_SECRET = "bulgarian-society-scoped-secret-123456";

test("queues through the Bulgarian Society channel without accepting a sender", async () => {
  const calls = [];
  const client = createDomakinMailerClient({
    baseUrl: "https://mailer.example.test/api/",
    secret: SCOPED_SECRET,
    httpClient: {
      post: async (...args) => {
        calls.push(args);
        return { data: { ok: true, queued: true, jobId: "job-1" } };
      },
    },
  });
  const operationId = "d0bdeee2-c1b4-4a7a-9cda-60d8f2744428";

  const result = await client.queueTemplateEmail(
    "f6eb08e8-7e2d-4abe-9edf-1c874ae49035",
    { email: " Member@Example.com ", id: 42 },
    { template_variables: { name: "Member" } },
    { operationId }
  );

  assert.deepEqual(result, { ok: true, queued: true, jobId: "job-1" });
  assert.equal(calls.length, 1);
  const [url, payload, config] = calls[0];
  assert.equal(url, "https://mailer.example.test/api/delivery/template");
  assert.deepEqual(payload.receiver, { email: "member@example.com", id: "42" });
  assert.equal(payload.channel, DOMAKIN_MAILER_CHANNEL);
  assert.equal(Object.hasOwn(payload, "from"), false);
  assert.equal(config.headers["X-Mailer-Admin-Secret"], SCOPED_SECRET);
  assert.equal(config.headers["X-Domakin-Operation-Id"], operationId);
  assert.equal(DOMAKIN_MAILER_FROM_ADDRESS, "info@bulgariansociety.nl");
});

test("adds /api when the configured Mailer URL is the service root", async () => {
  let requestedUrl = "";
  const client = createDomakinMailerClient({
    baseUrl: "http://localhost:6000",
    secret: SCOPED_SECRET,
    httpClient: {
      post: async (url) => {
        requestedUrl = url;
        return { data: { ok: true } };
      },
    },
  });

  await client.queueTemplateEmail(
    "f6eb08e8-7e2d-4abe-9edf-1c874ae49035",
    "recipient@example.com",
    {},
    { operationId: "929848a7-c115-4905-9398-4c555cce792c" }
  );

  assert.equal(requestedUrl, "http://localhost:6000/api/delivery/template");
});

test("fails before an HTTP request when the scoped secret is missing", async () => {
  let called = false;
  const client = createDomakinMailerClient({
    baseUrl: "https://mailer.example.test",
    secret: "",
    httpClient: {
      post: async () => {
        called = true;
      },
    },
  });

  await assert.rejects(
    () => client.queueTemplateEmail("template-id", "recipient@example.com"),
    /MAILER_BULGARIANSOCIETY_SECRET is required/
  );
  assert.equal(called, false);
});

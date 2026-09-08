import test from "node:test";
import assert from "node:assert/strict";
import { createEmailSender, DOMAKIN_NOTIFICATION_TEMPLATE, resolveDomakinResendTemplate, useDomakinMailer } from "../services/background-services/email-provider.js";

test("production and unconfigured environments preserve the legacy delivery path", async () => {
  for (const env of [{}, { APP_ENV: "prod" }, { BGSNL_EMAIL_PROVIDER: "legacy" }]) {
    let sent;
    const message = { to: [{ email: "person@example.test" }], template_uuid: "welcome", template_variables: {} };
    await createEmailSender({ env, legacySend: async (payload) => { sent = payload; }, queueTemplate: () => assert.fail("local provider used") })(message);
    assert.equal(sent, message);
  }
});

test("local template delivery preserves nested variables and recipient identity", async () => {
  let sent;
  const message = { to: [{ email: "person@example.test", id: "member-1" }], template_uuid: "welcome", template_variables: { template_variables: { name: "Member" } } };
  await createEmailSender({ env: { BGSNL_EMAIL_PROVIDER: "domakin" }, queueTemplate: async (...args) => { sent = args; }, legacySend: () => assert.fail("external provider used") })(message);
  assert.deepEqual(sent, ["welcome", message.to[0], message.template_variables]);
});

test("billing and internal messages use the shared notification snapshot", async () => {
  let sent;
  await createEmailSender({ env: { BGSNL_EMAIL_PROVIDER: "domakin" }, queueTemplate: async (...args) => { sent = args; } })({
    to: [{ email: "person@example.test" }], subject: "Payment needs attention", html: "<p>Manage billing</p>", text: "Manage billing",
  });
  assert.deepEqual(sent, [DOMAKIN_NOTIFICATION_TEMPLATE, { email: "person@example.test" }, { subject: "Payment needs attention", html: "<p>Manage billing</p>", text: "Manage billing" }]);
});

test("plain text notification content is escaped for HTML", async () => {
  let sent;
  await createEmailSender({ env: { BGSNL_EMAIL_PROVIDER: "domakin" }, queueTemplate: async (...args) => { sent = args; } })({ to: [{ email: "person@example.test" }], subject: "Test", text: "<script>&" });
  assert.equal(sent[2].html, "<pre>&lt;script&gt;&amp;</pre>");
});

test("a local failure never falls back to a live provider", async () => {
  const send = createEmailSender({ env: { BGSNL_EMAIL_PROVIDER: "domakin" }, queueTemplate: async () => { throw new Error("Unavailable"); }, legacySend: () => assert.fail("fallback risks duplicate mail") });
  await assert.rejects(send({ to: [{ email: "person@example.test" }], template_uuid: "welcome" }), /Unavailable/);
});

test("local delivery rejects unsupported envelopes before queuing", async () => {
  const send = createEmailSender({ env: { BGSNL_EMAIL_PROVIDER: "domakin" }, queueTemplate: () => assert.fail("invalid envelope queued") });
  for (const extra of [{ to: [] }, { to: [{ email: "a@example.test" }, { email: "b@example.test" }] }, { bcc: ["hidden@example.test"] }, { attachments: [{}] }]) {
    await assert.rejects(send({ to: [{ email: "person@example.test" }], template_uuid: "welcome", ...extra }), /one recipient/);
  }
});

test("typos in the selected provider cannot silently enable external delivery", () => {
  assert.throws(() => useDomakinMailer({ BGSNL_EMAIL_PROVIDER: "domakn" }), /must be legacy or domakin/);
});

test("Resend slugs require an explicit UUID mapping, never a guessed campaign", () => {
  assert.throws(() => resolveDomakinResendTemplate("campaign", {}), /needs a DOMAKIN_RESEND_TEMPLATE_MAP/);
  assert.throws(() => resolveDomakinResendTemplate("campaign", { DOMAKIN_RESEND_TEMPLATE_MAP: "bad json" }), /must be a JSON object/);
  assert.equal(resolveDomakinResendTemplate("campaign", { DOMAKIN_RESEND_TEMPLATE_MAP: JSON.stringify({ campaign: DOMAKIN_NOTIFICATION_TEMPLATE }) }), DOMAKIN_NOTIFICATION_TEMPLATE);
});

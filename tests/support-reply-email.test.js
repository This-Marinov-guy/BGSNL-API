import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildCustomerSupportReplyEmail } from "../services/support/reply-email.js";
import { createInternalNotificationService } from "../services/background-services/internal-notifications.js";
import { createSupportService } from "../services/support/conversations.js";
import { memorySupportStore } from "./fixtures/support-store.js";

const ticket = { id: randomUUID(), reference: "ABC12345", ownerAccountId: "customer", contact: { email: "customer@example.test" } };
const reply = { id: randomUUID(), author: "staff", text: "Private reply", attachments: [{ url: "https://example.test/private.png" }] };

test("customer email has an action link and plaintext fallback, but no private conversation content", () => {
  const email = buildCustomerSupportReplyEmail(ticket, reply);
  assert.equal(email.receiver, ticket.contact.email);
  assert.equal(email.entityId, `${ticket.id}:${reply.id}`);
  assert.match(email.subject, /ABC12345/);
  const link = new URL(email.html.match(/href="([^"]+)"/)[1]);
  assert.equal(link.origin, "https://bulgariansociety.nl");
  assert.equal(link.pathname, "/");
  assert.equal(link.searchParams.get("supportTicket"), ticket.id);
  assert.match(email.html, />Open ticket<\/a>/);
  assert.ok(email.text.includes(link.href));
  assert.match(email.text, /Sign in/);
  assert.doesNotMatch(JSON.stringify(email), /Private reply|private\.png/);
  assert.match(buildCustomerSupportReplyEmail({ ...ticket, ownerAccountId: null }, reply).text, /same browser/);
  assert.doesNotMatch(buildCustomerSupportReplyEmail({ ...ticket, reference: "<script>" }, reply).html, /<script>/);
});

test("staff replies email the customer even when internal notifications are disabled", () => {
  const customer = []; const internal = [];
  const service = createInternalNotificationService({ config: { enabled: false, subscribers: [] },
    sendEmail: message => internal.push(message), sendCustomerEmail: message => customer.push(message) });
  assert.equal(service.notifySupportTicketReplied(ticket, reply), 1);
  assert.equal(customer.length, 1);
  assert.equal(internal.length, 0);
  assert.equal(service.notifySupportTicketReplied(ticket, { ...reply, author: "requester" }), 0);
  assert.equal(service.notifySupportTicketReplied({ ...ticket, contact: { phone: "+31600000000" } }, reply), 0);
  assert.equal(customer.length, 1);
});

test("staff replies notify the customer, while requester replies notify only developers", () => {
  const recipients = [];
  const service = createInternalNotificationService({ config: { enabled: true, subscribers: ["notifications@bulgariansociety.nl"] },
    developerConfig: { enabled: true, subscribers: ["developer@example.test"] },
    sendEmail: message => recipients.push(message.receiver), sendCustomerEmail: message => recipients.push(message.receiver) });
  assert.equal(service.notifySupportTicketReplied(ticket, reply), 1);
  assert.deepEqual(recipients, [ticket.contact.email]);
  assert.equal(service.notifySupportTicketReplied({ ...ticket, contact: {} }, reply), 0);
  assert.deepEqual(recipients, [ticket.contact.email]);
  assert.equal(service.notifySupportTicketReplied(ticket, { ...reply, author: "requester" }), 1);
  assert.deepEqual(recipients, [ticket.contact.email, "developer@example.test"]);
});

test("a saved staff reply queues exactly one customer email across optimistic conflicts and request replay", async () => {
  const messages = [];
  const notifications = createInternalNotificationService({ config: { enabled: false, subscribers: [] },
    sendCustomerEmail: message => messages.push(message) });
  const records = memorySupportStore();
  const service = createSupportService({ records, notifyReply: notifications.notifySupportTicketReplied });
  const guest = { secret: "a".repeat(64) };
  const report = await service.create({ id: randomUUID(), subject: "Help", text: "Please help", contact: { name: "Guest", email: ticket.contact.email } }, guest);
  const actor = { account: { id: "staff", roles: ["admin"], status: "active" }, staff: true };
  records.conflicts = 1;
  const input = { id: reply.id, text: reply.text };
  await service.reply(report.id, input, actor);
  await service.reply(report.id, input, actor);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].entityId, `${report.id}:${reply.id}`);
  await service.reply(report.id, { id: randomUUID(), text: "Thank you" }, guest);
  assert.equal(messages.length, 1);
});

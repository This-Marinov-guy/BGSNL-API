import test from "node:test";
import assert from "node:assert/strict";
import { ticketObjectKey, guestTicketPrefix, deleteEventGuestTickets } from "../services/tickets/ticket-storage.js";

const eventId = "a".repeat(24), token = "AbCdEfGhIjKlMnOpQrStUv";
const response = data => ({ promise: async () => data });
test("ticket keys preserve case-sensitive tokens and omit personal details", () => {
  assert.equal(ticketObjectKey(eventId, token), `guest_${eventId}_${token}.webp`);
  assert.equal(ticketObjectKey(eventId, token, "member"), `member_${eventId}_${token}.webp`);
  for (const id of ["", "../", "guest", "a".repeat(23)]) assert.throws(() => guestTicketPrefix(id));
  assert.throws(() => ticketObjectKey(eventId, ""));
  assert.throws(() => ticketObjectKey(eventId, token, "other"));
});
test("guest cleanup paginates and cannot delete members or another event", async () => {
  const calls = [], batches = [], prefix = guestTicketPrefix(eventId);
  const s3 = {
    getBucketVersioning: () => response({}),
    listObjectsV2: input => { calls.push(input); return response(input.ContinuationToken ? { Contents: [{ Key: `${prefix}second.webp` }] }
      : { Contents: [{ Key: `${prefix}first.webp` }, { Key: `member_${eventId}_${token}.webp` }, { Key: `guest_${"b".repeat(24)}_${token}.webp` }], IsTruncated: true, NextContinuationToken: "page2" }); },
    deleteObjects: input => { batches.push(input.Delete.Objects); return response({}); },
  };
  assert.equal(await deleteEventGuestTickets(eventId, { bucket: "unchanged-guest-bucket", s3 }), 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].ContinuationToken, "page2");
  assert.ok(calls.every(call => call.Prefix === prefix && call.Bucket === "unchanged-guest-bucket"));
  assert.ok(batches.flat().every(item => item.Key.startsWith(prefix)));
});
test("versioned cleanup removes versions and delete markers, and fails on partial deletion", async () => {
  const key = ticketObjectKey(eventId, token), deletes = [];
  const s3 = { getBucketVersioning: () => response({ Status: "Enabled" }),
    listObjectVersions: () => response({ Versions: [{ Key: key, VersionId: "v1" }], DeleteMarkers: [{ Key: key, VersionId: "m1" }] }),
    deleteObjects: input => { deletes.push(input.Delete.Objects); return response({}); } };
  assert.equal(await deleteEventGuestTickets(eventId, { bucket: "guests", s3 }), 2);
  assert.deepEqual(deletes[0], [{ Key: key, VersionId: "v1" }, { Key: key, VersionId: "m1" }]);
  s3.deleteObjects = () => response({ Errors: [{ Code: "AccessDenied" }] });
  await assert.rejects(deleteEventGuestTickets(eventId, { bucket: "guests", s3 }), /could not be deleted/);
});

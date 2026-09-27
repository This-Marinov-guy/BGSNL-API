import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ObjectId } from "mongodb";
import Event from "../models/Event.js";
import { auditProductionEvents, eventAuditProjection } from "../services/events/event-production-audit.js";

test("audit only reads projected event fields and reports validation paths, never values", async () => {
  const record = {
    _id: new ObjectId(), title: "Private event title", region: "breda", date: new Date("2099-09-27"), status: "opened",
    ticketLimit: "private-invalid-value", earlyBird: { ticketTimer: "" },
  };
  const db = { collection(name) {
    if (name === "_migrations") return { find: () => ({ toArray: async () => [] }) };
    assert.equal(name, "events");
    return {
      find: (_query, { projection }) => {
        assert.equal(projection.guestList, undefined);
        assert.equal(projection.lastUpdate, 1);
        assert.equal(projection.ticketTimer, 1);
        return { toArray: async () => [record] };
      },
      indexes: async () => [{ key: { slug: 1 }, unique: true }],
    };
  } };
  const audit = await auditProductionEvents(db, Event);
  assert.equal(audit.mode, "read-only-audit");
  assert.equal(audit.upgrade.pending, 1);
  assert.equal(audit.upgrade.modified, 0);
  assert.equal(audit.schemaValidation.afterNormalization.invalidEvents, 1);
  assert.equal(audit.schemaValidation.afterNormalization.errorsByPath["ticketLimit:cast"], 1);
  assert.equal(audit.slugIndexes.legacyGlobalUnique, true);
  assert.equal(audit.externalServicesVerified, false);
  assert.doesNotMatch(JSON.stringify(audit), /Private event title|private-invalid-value/);
  assert.deepEqual(eventAuditProjection(Event).guestList, undefined);
});

test("standalone apply refuses to connect without maintenance acknowledgement", () => {
  const result = spawnSync(process.execPath, ["scripts/upgrade-production-events.js", "--apply"], {
    // eslint-disable-next-line no-process-env
    env: { PATH: process.env.PATH }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Stop database writers and pass --writers-stopped/);
});

test("audit CLI has no apply mode", () => {
  const result = spawnSync(process.execPath, ["scripts/audit-production-events.js", "--apply"], {
    // eslint-disable-next-line no-process-env
    env: { PATH: process.env.PATH }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Read-only event audit failed/);
});

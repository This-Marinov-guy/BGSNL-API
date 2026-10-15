import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { bestEffortLog, reportAxiomFailure, snapshotLog } from "../middleware/axiom-safety.js";

// No real credentials or network are used. Every attempted event fails before ingest.
process.env.AXIOM_TOKEN = "test-token";
process.env.AXIOM_ORG_ID = "test-org";
process.env.AXIOM_LOGGING_ENABLED = "true";
process.env.APP_ENV = "test";
const { axiomCredentialsConfigured, axiomLogger, ingestLog, logError, logOperationalError, logIntegrationError } = await import("../middleware/axiom-logger.js");
const fail = () => { throw new Error("private failure details"); };

test("Axiom API tokens work without an organization ID, while personal tokens require one", () => {
  assert.equal(axiomCredentialsConfigured("xaat-test-token", undefined), true);
  assert.equal(axiomCredentialsConfigured("xapt-test-token", undefined), false);
  assert.equal(axiomCredentialsConfigured("xapt-test-token", "test-org"), true);
  assert.equal(axiomCredentialsConfigured(undefined, "test-org"), false);
});

test("production initializes Axiom ingestion with an API token alone", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    "import { axiomIngestionEnabled } from './middleware/axiom-logger.js'; console.log(axiomIngestionEnabled())"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production", APP_ENV: "prod", AXIOM_TOKEN: "xaat-test-token",
      AXIOM_ORG_ID: "", AXIOM_LOGGING_ENABLED: "true" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "true");
});

test("both synchronous and asynchronous logging errors are contained", async () => {
  assert.equal(bestEffortLog(fail), undefined);
  await assert.doesNotReject(bestEffortLog(async () => fail()));
  const previous = console.error;
  console.error = fail;
  try {
    assert.doesNotThrow(reportAxiomFailure);
    assert.doesNotThrow(() => bestEffortLog(fail));
    await assert.doesNotReject(bestEffortLog(async () => fail()));
  } finally { console.error = previous; }
});

test("serialization failures cannot reach a later SDK timer", () => {
  const circular = {}; circular.self = circular;
  assert.doesNotThrow(() => ingestLog(circular));
  assert.doesNotThrow(() => ingestLog({ toJSON: fail }));
  const original = { nested: { status: 200 } };
  const copy = snapshotLog(original);
  original.nested.circular = original;
  assert.deepEqual(copy, { nested: { status: 200 } });
});

test("event construction and error metadata getters are guarded", () => {
  const error = { get name() { return fail(); } };
  assert.doesNotThrow(() => logError(error));
  assert.doesNotThrow(() => logOperationalError("test", error));
  assert.doesNotThrow(() => logIntegrationError("test", error));
});

test("middleware never reruns a request or swallows application errors", () => {
  const response = new EventEmitter();
  let calls = 0;
  const badSetup = { get walletPrivate() { return fail(); } };
  axiomLogger(badSetup, response, () => { calls++; });
  const badFinish = { method: "POST", get originalUrl() { return fail(); } };
  axiomLogger(badFinish, response, () => { calls++; });
  assert.doesNotThrow(() => response.emit("finish"));
  assert.equal(calls, 2);
  const error = new Error("business failure");
  assert.throws(() => axiomLogger(badSetup, response, () => { calls++; throw error; }), value => value === error);
  assert.equal(calls, 3);
});

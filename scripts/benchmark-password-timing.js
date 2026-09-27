import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { randomInt } from "node:crypto";
import { mock } from "node:test";
import bcrypt from "bcryptjs";
import express from "express";
import mongoose from "mongoose";

// An isolated, loopback-only HTTP benchmark of the real login controller and
// verifier. No application startup, database, sessions, Stripe, email or Google.
// There is deliberately no option to target an external/production URL.
const arg = process.argv[2] || "--samples=6";
const sampleCount = Number(arg.replace(/^--samples=/, ""));
assert.ok(/^--samples=\d+$/.test(arg) && Number.isInteger(sampleCount) && sampleCount >= 3 && sampleCount <= 30 && process.argv.length <= 3,
  "Usage: node scripts/benchmark-password-timing.js [--samples=3..30]");
const blocked = () => { throw new Error("External services are disabled in the password timing benchmark"); };
mock.method(http, "request", blocked);
mock.method(https, "request", blocked);
mock.method(mongoose, "connect", blocked);
mock.method(mongoose, "createConnection", blocked);
mock.method(mongoose.connection, "openUri", blocked);
mongoose.set("bufferCommands", false);
const nativeFetch = globalThis.fetch;
let base;
mock.method(globalThis, "fetch", (url, options) => {
  if (!base || new URL(url).origin !== base) return blocked();
  return nativeFetch(url, options);
});

let server;
try {
  const [{ createPasswordLogin }, { passwordVerificationMinimumMs }, { loginValidators }, { validateRequest }] = await Promise.all([
    import("../controllers/security-controller.js"), import("../services/authentication/passwords.js"),
    import("../validation/form-validators.js"), import("../middleware/validate-request.js"),
  ]);
  const original = "Synthetic-password-123!";
  const current = await bcrypt.hash(original, 12);
  const accounts = {
    current: { password: current }, legacy4: { password: await bcrypt.hash(original, 4) },
    legacy10: { password: await bcrypt.hash(original, 10) }, missingHash: {}, corrupt: { password: "invalid" },
  };
  let issued = 0;
  const app = express();
  app.use(express.json({ limit: "8kb" }));
  app.post("/security/login", loginValidators, validateRequest, createPasswordLogin({
    findAccount: async (email) => accounts[email.split("@")[0]] || null,
    buildResponse: async () => { issued++; return { token: "synthetic-response-no-real-session" }; },
  }));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  const minimumMs = passwordVerificationMinimumMs();
  async function request(account, password, expected = 401) {
    const start = performance.now();
    const res = await fetch(`${base}/security/login`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `${account}@password-tests.invalid`, password }), signal: AbortSignal.timeout(minimumMs + 10000) });
    const body = await res.json(), elapsed = performance.now() - start;
    assert.equal(res.status, expected);
    if (expected === 401) assert.deepEqual(body, { message: "Invalid credentials" });
    return elapsed;
  }
  const cases = [
    ["wrong-1-char", "current", "x"], ["wrong-16-chars", "current", "x".repeat(16)],
    ["wrong-72-chars", "current", "x".repeat(72)], ["wrong-256-chars", "current", "x".repeat(256)],
    ["wrong-unicode", "current", "б".repeat(128)],
    ["near-match-start", "current", `X${original.slice(1)}`], ["near-match-end", "current", `${original.slice(0, -1)}X`],
    ["unknown-email", "unknown", "x"], ["missing-hash", "missinghash", "x"], ["corrupt-hash", "corrupt", "x"],
    ["legacy-cost-4", "legacy4", "x"], ["legacy-cost-10", "legacy10", "x"],
  ];
  // The API normalizes emails; fixture keys must follow the same convention.
  accounts.missinghash = accounts.missingHash; delete accounts.missingHash;
  const results = new Map(cases.map(([label]) => [label, []]));
  for (let i = 0; i < 3; i++) await request("current", "warm-up");
  for (let round = 0; round < sampleCount; round++) {
    const order = [...cases];
    for (let i = order.length - 1; i > 0; i--) { const j = randomInt(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
    for (const [label, account, password] of order) results.get(label).push(await request(account, password));
    console.log(`Completed synthetic timing round ${round + 1}/${sampleCount}`);
  }
  // Rejection of malformed inputs is deliberately fast and account-independent.
  for (const account of ["current", "unknown"]) {
    await request(account, "x".repeat(257), 422); await request(account, {}, 422);
  }
  assert.equal(issued, 0, "Failed login must never create sessions");
  const successMs = await request("current", original, 201);
  assert.equal(issued, 1);
  const percentile = (values, p) => values[Math.ceil(values.length * p) - 1];
  const stats = [...results].map(([label, values]) => {
    values.sort((a, b) => a - b);
    return { label, samples: values.length, minMs: +values[0].toFixed(2), medianMs: +percentile(values, 0.5).toFixed(2),
      p95Ms: +percentile(values, 0.95).toFixed(2), maxMs: +values.at(-1).toFixed(2) };
  });
  const spreadMs = Math.max(...stats.map((row) => row.medianMs)) - Math.min(...stats.map((row) => row.medianMs));
  console.log(JSON.stringify({ scope: "Loopback HTTP; synthetic accounts; no database or external services; rate-limit storage excluded",
    minimumMs, stats, medianSpreadMs: +spreadMs.toFixed(2), syntheticSuccessMs: +successMs.toFixed(2),
    reviewRequired: spreadMs > 75 || stats.some((row) => row.p95Ms > minimumMs + 150) }, null, 2));
} finally {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  mock.restoreAll();
}

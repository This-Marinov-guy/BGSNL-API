import assert from "node:assert/strict";
import test from "node:test";
import { requireServiceKey } from "../middleware/pass-secure.js";

const run = (middleware, key) => new Promise((resolve) => {
  middleware({ headers: key === undefined ? {} : { "x-api-key": key } }, {}, (error) => resolve(error));
});

test("machine integration keys fail closed when absent, wrong or cross-scoped", async () => {
  const originalGoogle = process.env.GOOGLE_SCRIPTS_PASS;
  const originalKoko = process.env.KOKO_APP_PASS;
  try {
    delete process.env.GOOGLE_SCRIPTS_PASS;
    assert.equal((await run(requireServiceKey("GOOGLE_SCRIPTS_PASS"))).statusCode, 503);
    process.env.GOOGLE_SCRIPTS_PASS = "g".repeat(32);
    process.env.KOKO_APP_PASS = "k".repeat(32);
    assert.equal((await run(requireServiceKey("GOOGLE_SCRIPTS_PASS"), "wrong")).statusCode, 403);
    assert.equal((await run(requireServiceKey("GOOGLE_SCRIPTS_PASS"), process.env.KOKO_APP_PASS)).statusCode, 403);
    assert.equal(await run(requireServiceKey("GOOGLE_SCRIPTS_PASS"), process.env.GOOGLE_SCRIPTS_PASS), undefined);
  } finally {
    if (originalGoogle === undefined) delete process.env.GOOGLE_SCRIPTS_PASS;
    else process.env.GOOGLE_SCRIPTS_PASS = originalGoogle;
    if (originalKoko === undefined) delete process.env.KOKO_APP_PASS;
    else process.env.KOKO_APP_PASS = originalKoko;
  }
});

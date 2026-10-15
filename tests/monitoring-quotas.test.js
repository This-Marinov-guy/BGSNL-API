import test from "node:test";
import assert from "node:assert/strict";
import { cloudinaryQuota, mailtrapQuota, mongoQuota, s3Quota, wordpressQuota, quotaOverview } from "../services/monitoring/quotas.js";

test("Cloudinary uses its reported credit allowance", async () => {
  const result = await cloudinaryQuota({ env: { CLOUDINARY_CLOUD_NAME: "demo", CLOUDINARY_API_KEY: "key", CLOUDINARY_API_SECRET: "secret" },
    api: { usage: async () => ({ credits: { usage: 12, limit: 25 } }) } });
  assert.equal(result.status, "ready");
  assert.deepEqual([result.metrics[0].used, result.metrics[0].limit], [12, 25]);
});

test("Mongo storage comparison is marked partial because cluster plan and other databases are unknown", async () => {
  const result = await mongoQuota({ database: { readyState: 1, db: { command: async () => ({ dataSize: 100, indexSize: 30 }) } }, env: {} });
  assert.equal(result.status, "partial");
  assert.equal(result.metrics[0].used, 130);
  assert.equal(result.metrics[0].limitType, "reference");
});

test("AWS Free Tier uses account-level S3 allowances without inventing a fixed limit", async () => {
  class FreeTier {
    getFreeTierUsage() { return { promise: async () => ({ freeTierUsages: [
      { service: "Amazon Simple Storage Service", description: "Storage", actualUsageAmount: 2, limit: 5, unit: "GB" },
      { service: "AWS Lambda", actualUsageAmount: 1, limit: 10, unit: "requests" },
    ] }) }; }
  }
  const result = await s3Quota({ env: { S3_ACCESS_KEY: "key", S3_SECRET_KEY: "secret" }, FreeTier });
  assert.equal(result.status, "ready");
  assert.equal(result.metrics.length, 1);
  assert.deepEqual([result.metrics[0].used, result.metrics[0].limit], [2, 5]);
});

test("AWS S3 shows stored usage from configured buckets when billing access is denied", async () => {
  class FreeTier {
    getFreeTierUsage() { return { promise: async () => { throw Object.assign(new Error("denied"), { code: "AccessDeniedException" }); } }; }
  }
  const seen = [];
  class S3 {
    async send(command) {
      seen.push([command.input.Bucket, command.input.ContinuationToken || null]);
      if (command.input.Bucket === "tickets" && !command.input.ContinuationToken) {
        return { Contents: [{ Size: 120 }], NextContinuationToken: "next" };
      }
      return { Contents: [{ Size: command.input.Bucket === "users" ? 150 : 30 }] };
    }
    destroy() {}
  }
  const result = await s3Quota({ env: { S3_ACCESS_KEY: "key", S3_SECRET_KEY: "secret", S3_BUCKET_REGION: "eu-central-1",
    BUCKET_GUEST_TICKETS: "tickets", BUCKET_MEMBER_TICKETS: "tickets", BUCKET_USERS: "users" }, FreeTier, S3 });
  assert.equal(result.status, "partial");
  assert.deepEqual(seen, [["tickets", null], ["users", null], ["tickets", "next"]]);
  assert.deepEqual(result.metrics.map(({ used, limit }) => [used, limit]), [[300, null], [3, null]]);
  assert.match(result.detail, /allowance could not be read/i);
});

test("WordPress only shows usage when its site API reports a quota", async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({ quota: { space_used: 10, space_allowed: 1024 } }) });
  const result = await wordpressQuota({ env: { WORDPRESS_BLOG_ID: "sample.wordpress.com" }, fetcher });
  assert.equal(result.status, "ready");
  assert.equal(result.metrics[0].used, 10 * 1024 * 1024);
  assert.equal(result.metrics[0].limit, 1024 * 1024 * 1024);
  const hidden = await wordpressQuota({ env: { WORDPRESS_BLOG_ID: "sample.wordpress.com" },
    fetcher: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(hidden.status, "unavailable");
});

test("WordPress calculates used space when the site reports total and available space", async () => {
  const result = await wordpressQuota({ env: { WORDPRESS_BLOG_ID: "sample.wordpress.com" },
    fetcher: async () => ({ ok: true, json: async () => ({ quota: { space_allowed: 1024, space_available: 768 } }) }) });
  assert.equal(result.status, "ready");
  assert.equal(result.metrics[0].used, 256 * 1024 * 1024);
  assert.equal(result.metrics[0].limit, 1024 * 1024 * 1024);
});

test("WordPress shows public post usage when storage quota is withheld", async () => {
  const result = await wordpressQuota({ env: { WORDPRESS_BLOG_ID: "sample.wordpress.com" },
    fetcher: async (url) => url.includes("/posts?")
      ? { ok: true, headers: { get: () => "27" } }
      : { ok: true, json: async () => ({}) } });
  assert.equal(result.status, "partial");
  assert.deepEqual([result.metrics[0].label, result.metrics[0].used, result.metrics[0].limit], ["Published posts", 27, null]);
  assert.match(result.detail, /not exposed media storage/i);
});

test("Mailtrap quota is read through Mailer's scoped endpoint", async () => {
  let url = "";
  const result = await mailtrapQuota({ env: { MAILER_API_URL: "https://mailer.example/api", MAILER_BULGARIANSOCIETY_SECRET: "secret" },
    fetcher: async (requestUrl) => { url = requestUrl; return { ok: true, json: async () =>
      ({ used: 380, limit: 4000, limitType: "reference", estimated: true, period: "Calendar month estimate",
        dailyUsed: 12, dailyLimit: 150, dailyLimitType: "reference", dailyEstimated: true }) }; } });
  assert.equal(url, "https://mailer.example/api/monitoring/bgsnl-mailtrap-quota");
  assert.equal(result.metrics[0].used, 380);
  assert.equal(result.metrics[0].limitType, "reference");
  assert.equal(result.metrics[0].period, "Calendar month estimate");
  assert.equal(result.metrics[1].used, 12);
});

test("Mailtrap leaves a visible daily reading when the provider omits it", async () => {
  const result = await mailtrapQuota({ env: { MAILER_API_URL: "https://mailer.example/api", MAILER_BULGARIANSOCIETY_SECRET: "secret" },
    fetcher: async () => ({ ok: true, json: async () => ({ used: 380, limit: 4000, dailyLimit: 150 }) }) });
  assert.equal(result.metrics[1].used, null);
  assert.equal(result.metrics[1].limit, 150);
  assert.match(result.detail, /did not return today's sending count/);
});

test("Mailtrap reports a missing Mailer usage route", async () => {
  const result = await mailtrapQuota({ env: { MAILER_API_URL: "https://mailer.example/api", MAILER_BULGARIANSOCIETY_SECRET: "secret" },
    fetcher: async () => ({ ok: false, status: 404 }) });
  assert.equal(result.status, "unavailable");
  assert.match(result.detail, /monitoring route/);
});

test("quota summary keeps unavailable providers independent", async () => {
  const result = await quotaOverview({ providers: [async () => ({ name: "Cloudinary", status: "ready" }),
    async () => ({ name: "Mailtrap", status: "unavailable" })] });
  assert.equal(result.quotas.length, 2);
  assert.ok(result.checkedAt);
});

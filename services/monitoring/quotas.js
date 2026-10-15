import mongoose from "mongoose";
import AWS from "aws-sdk";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { v2 as cloudinary } from "cloudinary";

const CHECK_TIMEOUT_MS = 8000;
const CACHE_MS = 5 * 60_000;
const MONGO_M0_BYTES = 512 * 1024 * 1024;
let cached = null;
let cacheTime = 0;
let inFlight = null;

const finite = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};
const measurement = (label, used, limit, unit, period, limitType = "reported") => ({
  label, used: finite(used), limit: finite(limit), unit, period, limitType,
});
const timed = async (task) => {
  let timer;
  try { return await Promise.race([task(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Quota check timed out")), CHECK_TIMEOUT_MS);
  })]); }
  finally { clearTimeout(timer); }
};
const unavailable = (name, detail, status = "unavailable") => ({ name, status, detail, metrics: [], checkedAt: new Date().toISOString() });
const checked = async (name, task) => {
  try {
    const result = await timed(task);
    return { name, checkedAt: new Date().toISOString(), ...result };
  } catch (error) {
    const code = Number(error?.status || error?.statusCode || error?.$metadata?.httpStatusCode);
    if (name === "AWS S3" && ([401, 403].includes(code) || ["AccessDenied", "AccessDeniedException"].includes(error?.code))) return unavailable(name,
      "AWS denied S3 usage access. Grant s3:ListBucket on the configured buckets, or freetier:GetFreeTierUsage and billing view access.");
    if (name === "Mailtrap" && [401, 403].includes(code)) return unavailable(name,
      "Mailer denied quota access. Check its Bulgarian Society scoped secret.");
    if (name === "Mailtrap" && code === 404) return unavailable(name,
      "Mailer usage endpoint is missing. Check MAILER_API_URL and deploy the Mailer monitoring route.");
    return unavailable(name, "Could not read usage from the provider. Refresh or check read access.");
  }
};

export const cloudinaryQuota = async ({ env = process.env, api = cloudinary.api } = {}) => checked("Cloudinary", async () => {
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    return { status: "not configured", detail: "Cloudinary credentials are missing.", metrics: [] };
  }
  cloudinary.config({ cloud_name: env.CLOUDINARY_CLOUD_NAME, api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET });
  const usage = await api.usage();
  const metrics = [measurement("Credits", usage?.credits?.usage, usage?.credits?.limit, "credits", "Rolling 30 days")]
    .filter((entry) => entry.used !== null);
  if (!metrics.length) return { status: "unavailable", detail: "Cloudinary did not return credit usage.", metrics: [] };
  return { status: metrics[0].limit === null ? "partial" : "ready",
    detail: "Provider-reported credits across storage, bandwidth, and transformations.", metrics };
});

export const mongoQuota = async ({ env = process.env, database = mongoose.connection } = {}) => checked("MongoDB", async () => {
  if (database.readyState !== 1 || !database.db) return { status: "unavailable", detail: "Database is not connected.", metrics: [] };
  const stats = await database.db.command({ dbStats: 1, scale: 1 });
  const dataSize = finite(stats?.dataSize);
  const indexSize = finite(stats?.indexSize);
  if (dataSize === null || indexSize === null) return { status: "unavailable", detail: "Database storage metrics are unavailable.", metrics: [] };
  const used = dataSize + indexSize;
  const configured = finite(env.MONGODB_FREE_STORAGE_LIMIT_BYTES);
  const limit = configured && configured > 0 ? configured : MONGO_M0_BYTES;
  return { status: "partial", detail: configured
    ? "Connected database data and indexes. Check other databases on the same Atlas cluster separately."
    : "Connected database only, compared with the Atlas M0 0.5 GB reference. Cluster plan and other databases are unverified.",
  metrics: [measurement("Data and indexes", used, limit, "bytes", "Current", configured ? "configured" : "reference")] };
});

export const s3Quota = async ({ env = process.env, FreeTier = AWS.FreeTier, S3 = S3Client } = {}) => checked("AWS S3", async () => {
  if (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) return { status: "not configured", detail: "AWS credentials are missing.", metrics: [] };
  const client = new FreeTier({ region: "us-east-1", endpoint: "https://freetier.us-east-1.api.aws", accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY, maxRetries: 0, httpOptions: { timeout: 2500, connectTimeout: 2000 } });
  const items = [];
  let freeTierError;
  try {
    let nextToken;
    do {
      const result = await client.getFreeTierUsage({ maxResults: 1000, ...(nextToken ? { nextToken } : {}) }).promise();
      items.push(...(result.freeTierUsages || []));
      nextToken = result.nextToken;
    } while (nextToken && items.length < 3000);
  } catch (error) { freeTierError = error; }
  const metrics = items.filter((item) => /Amazon Simple Storage Service|Amazon S3/i.test(item.service || ""))
    .map((item) => measurement(item.description || item.usageType || item.operation || "S3 usage",
      item.actualUsageAmount, item.limit, item.unit || "units", "Month to date"))
    .filter((item) => item.used !== null && item.limit !== null);
  if (metrics.length) return { status: "ready", detail: "Account-level AWS Free Tier offers that currently apply to S3.", metrics };

  const buckets = [...new Set([env.BUCKET_GUEST_TICKETS, env.BUCKET_MEMBER_TICKETS, env.BUCKET_USERS,
    env.BUCKET_AM, env.BUCKET_DOCUMENTS].filter(Boolean))];
  if (!buckets.length || !env.S3_BUCKET_REGION) {
    return { status: "unavailable", detail: "AWS Free Tier usage is unavailable and no storage buckets are configured for a usage reading.", metrics: [] };
  }
  const storage = new S3({ region: env.S3_BUCKET_REGION, credentials: { accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY }, maxAttempts: 1 });
  const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS - 500);
  try {
    const results = await Promise.allSettled(buckets.map(async (Bucket) => {
      let nextToken;
      let bytes = 0;
      let objects = 0;
      let pages = 0;
      do {
        if (++pages > 100) throw new Error("S3 bucket listing exceeded the page limit");
        const result = await storage.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1000,
          ...(nextToken ? { ContinuationToken: nextToken } : {}) }), { abortSignal: signal });
        for (const item of result.Contents || []) { bytes += Number(item.Size || 0); objects += 1; }
        nextToken = result.NextContinuationToken;
      } while (nextToken);
      return { bytes, objects };
    }));
    const readable = results.filter((result) => result.status === "fulfilled");
    if (!readable.length) throw results[0].reason;
    const bytes = readable.reduce((sum, result) => sum + result.value.bytes, 0);
    const objects = readable.reduce((sum, result) => sum + result.value.objects, 0);
    const scope = readable.length === buckets.length ? `${buckets.length} configured ${buckets.length === 1 ? "bucket" : "buckets"}`
      : `${readable.length} of ${buckets.length} configured buckets`;
    const allowance = freeTierError ? "The AWS Free Tier allowance could not be read with this key."
      : "AWS returned no active S3 Free Tier allowance.";
    return { status: "partial", detail: `Current objects in ${scope}; older versions and transfers are excluded. ${allowance}`,
      metrics: [measurement("Current object bytes", bytes, null, "bytes", "Current"),
        measurement("Current objects", objects, null, "objects", "Current")] };
  } finally { storage.destroy(); }
});

export const wordpressQuota = async ({ env = process.env, fetcher = fetch } = {}) => checked("WordPress", async () => {
  if (!env.WORDPRESS_BLOG_ID) return { status: "not configured", detail: "WordPress site is not configured.", metrics: [] };
  const site = encodeURIComponent(env.WORDPRESS_BLOG_ID);
  const response = await fetcher(`https://public-api.wordpress.com/rest/v1.1/sites/${site}?fields=quota,plan`, {
    headers: env.WORDPRESS_API_TOKEN ? { Authorization: `Bearer ${env.WORDPRESS_API_TOKEN}` } : {},
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), cache: "no-store", redirect: "error",
  });
  if (!response.ok && ![401, 403].includes(response.status)) throw new Error("WordPress quota request failed");
  const data = response.ok ? await response.json() : {};
  const quota = data?.quota;
  const reportedAllowedMb = finite(quota?.space_allowed ?? quota?.spaceAllowed);
  const reportedUsedMb = finite(quota?.space_used ?? quota?.spaceUsed);
  const availableMb = finite(quota?.space_available ?? quota?.spaceAvailable);
  const allowedMb = reportedAllowedMb ?? (reportedUsedMb !== null && availableMb !== null ? reportedUsedMb + availableMb : null);
  const usedMb = reportedUsedMb ?? (allowedMb !== null && availableMb !== null ? Math.max(0, allowedMb - availableMb) : null);
  if (allowedMb !== null && usedMb !== null && allowedMb > 0) return { status: "ready",
    detail: "WordPress.com reported media storage for the configured site.",
    metrics: [measurement("Media storage", usedMb * 1024 * 1024, allowedMb * 1024 * 1024, "bytes", "Current")] };

  const posts = await fetcher(`https://public-api.wordpress.com/wp/v2/sites/${site}/posts?per_page=1&_fields=id`, {
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), cache: "no-store", redirect: "error",
  });
  const postCount = finite(posts.headers?.get("x-wp-total"));
  if (!posts.ok || postCount === null) return { status: "unavailable",
    detail: "WordPress did not expose storage or public post usage. A site-authorized WORDPRESS_API_TOKEN may be needed.", metrics: [] };
  return { status: "partial", detail: "Public post count only. WordPress has not exposed media storage or its allowance; a site-authorized token may be needed.",
    metrics: [measurement("Published posts", postCount, null, "posts", "Current")] };
});

export const mailtrapQuota = async ({ env = process.env, fetcher = fetch } = {}) => checked("Mailtrap", async () => {
  if (!env.MAILER_API_URL || !env.MAILER_BULGARIANSOCIETY_SECRET) return { status: "not configured",
    detail: "Mailer quota connection is not configured.", metrics: [] };
  const base = env.MAILER_API_URL.replace(/\/+$/, "");
  const endpoint = `${base.endsWith("/api") ? base : `${base}/api`}/monitoring/bgsnl-mailtrap-quota`;
  const response = await fetcher(endpoint, { headers: { "X-Mailer-Admin-Secret": env.MAILER_BULGARIANSOCIETY_SECRET },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), cache: "no-store", redirect: "error" });
  if (!response.ok) throw Object.assign(new Error("Mailer quota request failed"), { status: response.status });
  const result = await response.json();
  const used = finite(result?.used);
  if (used === null) return { status: "unavailable", detail: "Mailer did not return Mailtrap sending usage.", metrics: [] };
  const limit = finite(result.limit);
  const period = result.period === "Billing cycle" ? "Billing cycle" : "Calendar month estimate";
  const dailyUsed = finite(result.dailyUsed);
  return { status: "partial", detail: dailyUsed === null
    ? "Mailtrap did not return today's sending count. Monthly usage remains available."
    : result.estimated || result.dailyEstimated
    ? "Sending counts use delivered plus bounced messages where Mailtrap omits sent counts; in-flight mail may be missing. Confirm the account billing day for accurate monthly comparison."
    : "Mailtrap sending stats. Confirm the account billing day and plan limits for exact quota comparison.",
  metrics: [measurement("Monthly email sending", used, limit, "emails", period,
    result.limitType === "configured" ? "configured" : "reference"),
  measurement("Daily email sending", dailyUsed, result.dailyLimit, "emails", "Today (UTC)",
    result.dailyLimitType === "configured" ? "configured" : "reference")] };
});

export async function quotaOverview({ force = false, now = Date.now, providers = null } = {}) {
  if (!providers && !force && cached && now() - cacheTime < CACHE_MS) return cached;
  if (!providers && inFlight) return inFlight;
  const collect = async () => {
    const checks = providers || [cloudinaryQuota, mailtrapQuota, mongoQuota, s3Quota, wordpressQuota];
    const quotas = await Promise.all(checks.map((check) => check()));
    const result = { checkedAt: new Date().toISOString(), quotas };
    if (!providers) { cached = result; cacheTime = now(); }
    return result;
  };
  if (providers) return collect();
  inFlight = collect().finally(() => { inFlight = null; });
  return inFlight;
}

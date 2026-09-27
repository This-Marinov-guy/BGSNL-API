import mongoose from "mongoose";
import Stripe from "stripe";
import { v2 as cloudinary } from "cloudinary";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { google } from "googleapis";
import { redisClient } from "../storage/redis.js";
import { SPREADSHEETS_ID } from "../../util/config/SPREEDSHEATS.js";
import { INTEGRATIONS_DATASET, OPERATIONS_DATASET, WEB_DATASET, axiomIngestionEnabled, ingestIntegrationLog, ingestLog, logIntegrationError, logOperationalError, queryAxiom } from "../../middleware/axiom-logger.js";
import { jobSummary } from "./jobs.js";

const TIMEOUT_MS = 5000;
const dataset = (name) => {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(name)) throw new Error("Invalid Axiom dataset name");
  return `['${name}']`;
};

export const queryRows = async (apl, query = queryAxiom) => {
  const result = await query(apl, { startTime: new Date(Date.now() - 24 * 3600_000).toISOString() });
  return result.tables?.flatMap((table) => [...table.events()]) || [];
};

const countRows = (rows, field) => Object.fromEntries(rows.filter((row) => Number(row.events || 0) > 0).map((row) =>
  [String(row[field] || "other"), Number(row.events || 0)]));

export async function axiomOverview({ query = queryAxiom } = {}) {
  const names = { web: WEB_DATASET, operations: OPERATIONS_DATASET, integrations: INTEGRATIONS_DATASET };
  if (new Set(Object.values(names)).size !== 3) return { status: "misconfigured", message: "Axiom datasets must have distinct names.", datasets: names };
  const [web, operations, sources, webTraffic, apiTraffic, integrations] = await Promise.allSettled([
    queryRows(`${dataset(names.web)} | extend eventType = column_ifexists('type', '') | summarize events=count() by eventType`, query),
    queryRows(`${dataset(names.operations)} | extend eventLevel = column_ifexists('level', '') | summarize events=count() by eventLevel`, query),
    queryRows(`${dataset(names.operations)} | extend eventLevel = column_ifexists('level', ''), errorSource = column_ifexists('meta.source', '') | where eventLevel == "error" | summarize events=count() by errorSource`, query),
    queryRows(`${dataset(names.web)} | extend eventType = column_ifexists('type', '') | where eventType == "page_view" | summarize events=count() by hour=bin(_time, 1h)`, query),
    queryRows(`${dataset(names.operations)} | extend eventLevel = column_ifexists('level', '') | where eventLevel == "info" | summarize events=count() by hour=bin(_time, 1h)`, query),
    queryRows(`${dataset(names.integrations)} | extend eventProvider = column_ifexists('provider', ''), eventLevel = column_ifexists('level', '') | summarize events=count() by eventProvider, eventLevel`, query),
  ]);
  const success = (result) => result.status === "fulfilled";
  const failed = [web, operations, sources, webTraffic, apiTraffic, integrations].find((result) => !success(result));
  if (failed) logOperationalError("service.axiom-query", failed.reason);
  const hourly = (result) => success(result) ? result.value.map((row) => ({ hour: row.hour, count: Number(row.events || 0) })) : [];
  return {
    status: [web, operations, sources, webTraffic, apiTraffic, integrations].every(success) ? "connected" : "unavailable",
    ingestionEnabled: axiomIngestionEnabled(), datasets: names,
    web: success(web) ? { byType: countRows(web.value, "eventType"), hourly: hourly(webTraffic) } : null,
    operations: success(operations) ? { byLevel: countRows(operations.value, "eventLevel"),
      errorSources: success(sources) ? countRows(sources.value, "errorSource") : {}, hourly: hourly(apiTraffic) } : null,
    integrations: success(integrations) ? integrations.value.filter((row) => Number(row.events || 0) > 0).map((row) => ({ provider: String(row.eventProvider || "other"),
      level: String(row.eventLevel || "other"), count: Number(row.events || 0) })) : null,
    ...(success(web) && success(operations) && success(integrations) ? {} : { message: "Axiom query failed. Check dataset names and query token permissions." }),
  };
}

const probe = async (name, check) => {
  const started = Date.now();
  let timer;
  try {
    const detail = await Promise.race([
      check(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Probe timed out")), TIMEOUT_MS); }),
    ]);
    return { name, status: "healthy", latencyMs: Date.now() - started, ...(detail ? { detail } : {}) };
  } catch (error) {
    if (["API", "Redis"].includes(name)) logOperationalError(`health.${name.toLowerCase()}`, error);
    else logIntegrationError(name.toLowerCase().replaceAll(" ", "-"), error, "healthcheck");
    const code = Number(error?.statusCode || error?.status || error?.$metadata?.httpStatusCode);
    return { name, status: code === 401 || code === 403 ? "unverified" : "unhealthy",
      latencyMs: Date.now() - started, detail: code === 401 || code === 403 ? "Credentials lack probe access" :
        error?.message === "Probe timed out" ? "Timed out" : "Probe failed" };
  } finally { clearTimeout(timer); }
};

const fetchHealth = async (url) => {
  const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw Object.assign(new Error("Probe failed"), { status: response.status });
};

export async function serviceHealth({ env = process.env, database = mongoose.connection, redis = redisClient } = {}) {
  const stripeKey = env.STRIPE_NL_SECRET_KEY || env.STRIPE_SECRET_KEY_TEST;
  const buckets = [...new Set([env.BUCKET_GUEST_TICKETS, env.BUCKET_MEMBER_TICKETS].filter(Boolean))];
  const checks = [
    probe("API", async () => { if (database.readyState !== 1) throw new Error("Database unavailable"); }),
    probe("Redis", async () => { const client = await redis(); if (await client.ping() !== "PONG") throw new Error("Redis unavailable"); }),
    probe("Mailer", async () => {
      const mailer = env.MAILER_HEALTH_URL || (env.MAILER_API_URL ? new URL("/health", env.MAILER_API_URL).href : null);
      if (!mailer) throw new Error("Mailer not configured"); await fetchHealth(mailer);
    }),
    probe("Stripe", async () => {
      if (!stripeKey) throw new Error("Stripe not configured");
      await new Stripe(stripeKey, { apiVersion: "2022-08-01", timeout: TIMEOUT_MS, maxNetworkRetries: 0 }).balance.retrieve();
    }),
    probe("WordPress", async () => {
      if (!env.WORDPRESS_BLOG_ID) throw new Error("WordPress not configured");
      await fetchHealth(`https://public-api.wordpress.com/wp/v2/sites/${encodeURIComponent(env.WORDPRESS_BLOG_ID)}/posts?per_page=1`);
    }),
    probe("Google Sheets", async () => {
      if (!env.GOOGLE_APPLICATION_ADMIN_CREDENTIALS || !SPREADSHEETS_ID.netherlands?.users) throw new Error("Google Sheets not configured");
      const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(env.GOOGLE_APPLICATION_ADMIN_CREDENTIALS),
        scopes: "https://www.googleapis.com/auth/spreadsheets.readonly" });
      await google.sheets({ version: "v4", auth }).spreadsheets.get({ spreadsheetId: SPREADSHEETS_ID.netherlands.users, fields: "spreadsheetId" });
    }),
    probe("Cloudinary", async () => {
      if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) throw new Error("Cloudinary not configured");
      cloudinary.config({ cloud_name: env.CLOUDINARY_CLOUD_NAME, api_key: env.CLOUDINARY_API_KEY, api_secret: env.CLOUDINARY_API_SECRET });
      const result = await cloudinary.api.ping();
      if (result?.status !== "ok") throw new Error("Cloudinary unavailable");
    }),
    probe("AWS S3", async () => {
      if (!buckets.length || !env.S3_BUCKET_REGION || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) throw new Error("S3 not configured");
      const client = new S3Client({ region: env.S3_BUCKET_REGION, credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
        maxAttempts: 1 });
      try { await Promise.all(buckets.map((Bucket) => client.send(new HeadBucketCommand({ Bucket })))); }
      finally { client.destroy(); }
    }),
  ];
  const results = await Promise.all(checks);
  for (const result of results) {
    const event = { level: result.status === "healthy" ? "health" : result.status === "unverified" ? "warning" : "error",
      ts: new Date().toISOString(), type: "health", status: result.status, latencyMs: result.latencyMs,
      meta: { service: "bgsnl-api", environment: env.APP_ENV || env.NODE_ENV } };
    if (["API", "Redis"].includes(result.name)) ingestLog({ ...event, meta: { ...event.meta, source: `health.${result.name.toLowerCase()}` } });
    else ingestIntegrationLog({ ...event, provider: result.name.toLowerCase().replaceAll(" ", "-") });
  }
  return results;
}

export async function monitoringOverview(options = {}) {
  const [axiom, services, jobs] = await Promise.all([axiomOverview(options), serviceHealth(options),
    jobSummary(options).catch((error) => {
      logOperationalError("service.monitoring-jobs", error);
      return { available: false, source: "spreadsheet-sync", counts: null };
    })]);
  return { checkedAt: new Date().toISOString(), windowHours: 24, axiom, services, jobs };
}

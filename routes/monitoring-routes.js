import { createHash } from "node:crypto";
import express from "express";
import { adminMiddleware } from "../middleware/authorization.js";
import { isTrustedServerRequest } from "../middleware/firewall.js";
import { ingestWebLog, logOperationalError } from "../middleware/axiom-logger.js";
import { requestClientAddress } from "../util/auth/request-client.js";
import { MONITORING_ACCESS } from "../util/config/defines.js";
import { redisRateLimits } from "../services/storage/rate-limits.js";
import { monitoringOverview } from "../services/monitoring/overview.js";
import { listJobs, normalizeJobFilter } from "../services/monitoring/jobs.js";

const text = (value, max) => typeof value === "string" ? value.slice(0, max) : "";
const safePath = (value) => {
  if (typeof value !== "string" || !/^\/(?!\/)[^?#]{0,200}$/.test(value)) return "/";
  return value.replace(/\/[a-f\d]{24}(?=\/|$)/gi, "/:id")
    .replace(/\/[A-Za-z0-9_-]{32,}(?=\/|$)/g, "/:token");
};

export function normalizeWebEvent(body) {
  if (!body || typeof body !== "object" || !["page_view", "client_error", "server_error"].includes(body.type)) return null;
  const event = { level: body.type === "page_view" ? "info" : "error", type: body.type,
    ts: new Date().toISOString(), path: safePath(body.path),
    meta: { service: "bgsnl-web", environment: process.env.NODE_ENV || "development" } };
  if (event.level === "error") {
    event.error = { name: text(body.name, 80) || "Error", digest: text(body.digest, 100),
      component: text(body.component, 80) };
  }
  return event;
}

export const createMonitoringRouter = ({ overview = monitoringOverview, ingest = ingestWebLog,
  jobs = listJobs, authorize = adminMiddleware(MONITORING_ACCESS), trusted = isTrustedServerRequest, limits = redisRateLimits } = {}) => {
  const router = express.Router();
  router.post("/web-events", async (req, res) => {
    if (!trusted(req) || req.headers["x-bgsnl-browser-proxy"] !== "1") return res.sendStatus(403);
    if (JSON.stringify(req.body || {}).length > 2000) return res.sendStatus(413);
    const event = normalizeWebEvent(req.body);
    if (!event) return res.sendStatus(422);
    const minute = Math.floor(Date.now() / 60_000);
    const addressHash = createHash("sha256").update(requestClientAddress(req)).digest("hex");
    try {
      const limit = await limits.findOneAndUpdate({ _id: `web-monitor:${addressHash}:${minute}` },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((minute + 2) * 60_000) } });
      if (limit.count > 60) return res.sendStatus(429);
    } catch (error) {
      logOperationalError("service.web-monitor-rate-limit", error);
      return res.sendStatus(503);
    }
    ingest(event);
    return res.sendStatus(202);
  });
  router.get("/overview", authorize, async (_req, res) => {
    res.set("Cache-Control", "private, no-store");
    try { return res.json(await overview()); }
    catch (error) { logOperationalError("service.monitoring-overview", error); return res.status(503).json({ message: "Monitoring is temporarily unavailable." }); }
  });
  router.get("/jobs", authorize, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const filter = normalizeJobFilter(req.query.status, req.query.page);
    if (!filter) return res.status(400).json({ message: "Choose a valid job status and page." });
    try { return res.json(await jobs(filter)); }
    catch (error) {
      logOperationalError("service.monitoring-job-list", error);
      return res.status(503).json({ message: "Jobs are temporarily unavailable." });
    }
  });
  return router;
};

export default createMonitoringRouter();

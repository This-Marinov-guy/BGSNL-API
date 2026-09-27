/**
 * Axiom log event models – fixed fields to stay under dataset field limits.
 * All events use grouped fields (req, res, meta, headers inside req) so
 * total top-level + nested paths stay under 100.
 *
 * Field budget (approx):
 *   info:   level, ts, req (8), res (4), meta (2) = 17
 *   warn:   + error (4), payload (1) = 22
 *   error:  same as warn = 22
 */

const SERVICE_NAME = "bgsnl-api";
const ENV = process.env.NODE_ENV || "development";

const safePath = (value) => String(value || "/").split("?")[0]
  .replace(/\/[a-f\d]{24}(?=\/|$)/gi, "/:id")
  .replace(/\/[A-Za-z0-9_-]{32,}(?=\/|$)/g, "/:token")
  .slice(0, 200);

/**
 * Build the shared "req" object (grouped) for API request logs.
 * @param {object} req - Express req
 * @param {object} redact - Redact function for sensitive data
 */
export function buildReq(req) {
  if (req.walletPrivate) return { method: req.method, url: "/api/user/wallet", path: "/api/user/wallet" };
  if (/\/payment\/event-ticket(?:[/?]|$)/.test(req.originalUrl || req.url || "")) {
    return { method: req.method, url: "/api/payment/event-ticket", path: "/api/payment/event-ticket" };
  }
  if (req.supportPrivate) {
    return { method: req.method, url: "/api/support", path: "/api/support" };
  }
  const path = safePath(req.route?.path ? `${req.baseUrl || ""}${req.route.path}` : req.path || req.originalUrl || req.url);
  return {
    method: req.method,
    url: path,
    path,
  };
}

/**
 * Build the shared "res" object (grouped).
 */
export function buildRes(statusCode, statusMessage, durationMs, body) {
  const res = {
    statusCode,
    statusMessage: statusMessage || "",
    durationMs,
  };
  if (body !== undefined) {
    res.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return res;
}

/**
 * Shared "meta" object.
 */
export function buildMeta(overrides = {}) {
  return {
    service: SERVICE_NAME,
    environment: ENV,
    ...overrides,
  };
}

/**
 * Build "error" object for warning/error logs (grouped).
 */
export function buildError(err) {
  if (!err) return undefined;
  return {
    name: err.name,
    code: err.code,
    status: err.status,
  };
}

/**
 * INFO – API request/response. Fixed fields: level, ts, req, res, meta.
 */
export function createInfoEvent({ req, res, meta, redact }) {
  return {
    level: "info",
    ts: new Date().toISOString(),
    req: buildReq(req, redact),
    res: buildRes(
      res.statusCode,
      res.statusMessage,
      res.durationMs,
      res.body
    ),
    meta: buildMeta(meta),
  };
}

/**
 * WARNING – Same as info but with optional error + payload (grouped).
 * Fixed fields: level, ts, req?, res?, meta, error?, payload?
 */
export function createWarningEvent({ req, res, meta, error, payload, redact }) {
  const event = {
    level: "warning",
    ts: new Date().toISOString(),
    meta: buildMeta(meta),
  };
  if (req) event.req = buildReq(req, redact);
  if (res) event.res = buildRes(res.statusCode, res.statusMessage, res.durationMs, res.body);
  if (error) event.error = buildError(error);
  if (payload !== undefined) event.payload = typeof payload === "object" ? JSON.stringify(payload) : payload;
  return event;
}

/**
 * ERROR – Same shape as warning for consistency.
 * Fixed fields: level, ts, req?, res?, meta, error?, payload?
 */
export function createErrorEvent({ req, res, meta, error, payload, redact }) {
  const event = {
    level: "error",
    ts: new Date().toISOString(),
    meta: buildMeta(meta),
  };
  if (req) event.req = buildReq(req, redact);
  if (res) event.res = buildRes(res.statusCode, res.statusMessage, res.durationMs, res.body);
  if (error) event.error = buildError(error);
  if (payload !== undefined) event.payload = typeof payload === "object" ? JSON.stringify(payload) : payload;
  return event;
}

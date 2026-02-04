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

/** Fixed request headers we log (no dynamic keys) */
const REQ_HEADER_KEYS = [
  "user-agent",
  "content-type",
  "accept",
  "host",
  "referer",
  "origin",
];

/**
 * Build the shared "req" object (grouped) for API request logs.
 * @param {object} req - Express req
 * @param {object} redact - Redact function for sensitive data
 */
export function buildReq(req, redact) {
  const headers = {};
  for (const key of REQ_HEADER_KEYS) {
    const v = req.headers[key];
    if (v !== undefined) headers[key] = v;
  }
  const body = req.body
    ? redact(req.body)
    : undefined;
  return {
    method: req.method,
    url: req.originalUrl || req.url,
    path: req.path,
    ip: req.ip,
    params: req.params && Object.keys(req.params).length
      ? JSON.stringify(req.params)
      : undefined,
    query: req.query && Object.keys(req.query).length
      ? JSON.stringify(req.query)
      : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers,
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
    message: err.message || String(err),
    name: err.name,
    code: err.code,
    stack: err.stack,
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

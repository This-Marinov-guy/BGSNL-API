import dotenv from "dotenv";
dotenv.config();

import { Axiom } from "@axiomhq/js";

/**
 * Initialize Axiom client
 */
let axiom = null;

if (
  process.env.AXIOM_TOKEN &&
  process.env.AXIOM_ORG_ID &&
  process.env.AXIOM_DATASET
) {
  try {
    axiom = new Axiom({
      token: process.env.AXIOM_TOKEN,
      orgId: process.env.AXIOM_ORG_ID,
    });
  } catch (err) {
    console.error("[axiom] failed to initialize client:", err);
  }
} else {
  console.warn("[axiom] missing environment variables, logging disabled");
}

/**
 * Dataset name
 */
const DATASET = process.env.AXIOM_DATASET || "api-logs";

/**
 * Graceful shutdown (important for Docker / K8s)
 */
const flushAxiom = async () => {
  if (!axiom) return;
  try {
    await axiom.flush();
    // eslint-disable-next-line no-console
    console.log("[axiom] flush complete");
  } catch (err) {
    console.error("[axiom] flush failed:", err);
  }
};

process.on("SIGTERM", flushAxiom);
process.on("SIGINT", flushAxiom);

/**
 * Scrub sensitive fields recursively
 */
const redactSensitive = (value) => {
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (/password|passwd|pwd|secret|token|key/i.test(key)) {
      out[key] = "<redacted>";
    } else {
      out[key] = redactSensitive(val);
    }
  }
  return out;
};

/**
 * Format request details
 */
const formatRequest = (req) => ({
  method: req.method,
  url: req.originalUrl || req.url,
  path: req.path,
  params: req.params,
  query: req.query,
  headers: {
    "user-agent": req.headers["user-agent"],
    "content-type": req.headers["content-type"],
    accept: req.headers.accept,
    host: req.headers.host,
    referer: req.headers.referer,
    origin: req.headers.origin,
  },
  ip: req.ip,
});

/**
 * Express middleware
 */
export const axiomLogger = (req, res, next) => {
  if (!axiom || process.env.APP_ENV === "dev") {
    return next();
  }

  const startTime = Date.now();
  const request = formatRequest(req);

  if (req.body) {
    request.body = redactSensitive(req.body);
  }

  const chunks = [];

  /**
   * Patch res.write safely
   */
  const originalWrite = res.write.bind(res);
  res.write = (chunk, encoding, callback) => {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return originalWrite(chunk, encoding, callback);
  };

  /**
   * Patch res.end safely
   */
  const originalEnd = res.end.bind(res);
  res.end = (chunk, encoding, callback) => {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    originalEnd(chunk, encoding, callback);

    const durationMs = Date.now() - startTime;

    const log = {
      timestamp: new Date().toISOString(),
      request,
      response: {
        statusCode: res.statusCode,
        statusMessage: res.statusMessage,
        durationMs,
      },
      meta: {
        service: "bgsnl-api",
        environment: process.env.NODE_ENV || "development",
      },
    };

    if (chunks.length) {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        log.response.body = redactSensitive(JSON.parse(raw));
      } catch {
        log.response.body = raw;
      }
    }

    // Fire and forget (do NOT block response)
    try {
      axiom.ingest(DATASET, log);
    } catch (err) {
      console.error("[axiom] ingest failed:", err);
    }
  };

  next();
};

export default axiomLogger;

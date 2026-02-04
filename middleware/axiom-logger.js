import dotenv from "dotenv";
dotenv.config();

import { Axiom } from "@axiomhq/js";
import { createInfoEvent } from "../util/logging/axiom-log-models.js";

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
 * Export flushAxiom to be called by app.js during graceful shutdown
 */
export const flushAxiom = async () => {
  if (!axiom) return;
  try {
    await axiom.flush();
    // eslint-disable-next-line no-console
    console.log("[axiom] flush complete");
  } catch (err) {
    console.error("[axiom] flush failed:", err);
  }
};

/**
 * Scrub sensitive fields recursively. Exported for use with createErrorEvent / createWarningEvent.
 */
export const redactSensitive = (value) => {
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
 * Ingest a log event (info/warning/error model). No-op if Axiom is disabled or in dev.
 */
export const ingestLog = (log) => {
  if (!axiom || process.env.APP_ENV === "dev") return;
  try {
    axiom.ingest(DATASET, log);
  } catch (err) {
    console.error("[axiom] ingest failed:", err);
  }
};

/**
 * Express middleware – logs API requests using fixed-field info model (req, res, headers).
 */
export const axiomLogger = (req, res, next) => {
  if (!axiom || process.env.APP_ENV === "dev") {
    return next();
  }

  const startTime = Date.now();
  const chunks = [];

  const originalWrite = res.write.bind(res);
  res.write = (chunk, encoding, callback) => {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return originalWrite(chunk, encoding, callback);
  };

  const originalEnd = res.end.bind(res);
  res.end = (chunk, encoding, callback) => {
    if (chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    originalEnd(chunk, encoding, callback);

    const durationMs = Date.now() - startTime;

    let responseBody;
    if (chunks.length) {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        responseBody = redactSensitive(JSON.parse(raw));
      } catch {
        responseBody = raw;
      }
    }

    const log = createInfoEvent({
      req,
      res: {
        statusCode: res.statusCode,
        statusMessage: res.statusMessage,
        durationMs,
        body: responseBody,
      },
      meta: {},
      redact: redactSensitive,
    });

    ingestLog(log);
  };

  next();
};

export default axiomLogger;

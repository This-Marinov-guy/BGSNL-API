import dotenv from "dotenv";
dotenv.config();

import { Axiom } from "@axiomhq/js";
import { bestEffortLog, reportAxiomFailure, snapshotLog } from "./axiom-safety.js";
import { createInfoEvent, createErrorEvent } from "../util/logging/axiom-log-models.js";

/**
 * Initialize Axiom client
 */
let axiom = null;

if (
  process.env.AXIOM_TOKEN &&
  process.env.AXIOM_ORG_ID
) {
  try {
    axiom = new Axiom({
      token: process.env.AXIOM_TOKEN,
      orgId: process.env.AXIOM_ORG_ID,
      onError: reportAxiomFailure,
    });
  } catch {
    reportAxiomFailure();
  }
} else {
  bestEffortLog(() => console.warn("[axiom] missing environment variables, logging disabled"));
}

/**
 * Dataset name
 */
export const OPERATIONS_DATASET = process.env.AXIOM_OPERATIONS_DATASET || "operations";
export const WEB_DATASET = process.env.AXIOM_WEB_DATASET || "web";
export const INTEGRATIONS_DATASET = process.env.AXIOM_INTEGRATIONS_DATASET || "integrations";
export const axiomIngestionEnabled = () => !!axiom && process.env.APP_ENV !== "dev" &&
  process.env.AXIOM_LOGGING_ENABLED !== "false" &&
  (process.env.NODE_ENV === "production" || process.env.AXIOM_LOGGING_ENABLED === "true");

/**
 * Graceful shutdown (important for Docker / K8s)
 * Export flushAxiom to be called by app.js during graceful shutdown
 */
export const flushAxiom = async () => {
  if (!axiom) return;
  try {
    await axiom.flush();
    bestEffortLog(() => console.log("[axiom] flush complete"));
  } catch {
    reportAxiomFailure();
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
    if (/password|passwd|pwd|secret|token|key|credential|nonce|proof|authorization|cookie|challenge|signature|authenticatorData|clientDataJSON|attestationObject|userHandle/i.test(key)) {
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
export const ingestLog = (log, dataset = OPERATIONS_DATASET) => bestEffortLog(() => {
  if (!axiomIngestionEnabled()) return;
  return axiom.ingest(dataset, snapshotLog(log));
});

// Browser reports have already been validated and reduced to fixed fields by
// the website and the monitoring route. They never contain cookies or bodies.
export const ingestWebLog = (event) => ingestLog(event, WEB_DATASET);
export const ingestIntegrationLog = (event) => ingestLog(event, INTEGRATIONS_DATASET);

export const queryAxiom = async (apl, options = {}) => {
  const token = process.env.AXIOM_QUERY_TOKEN || process.env.AXIOM_TOKEN;
  if (!token || !process.env.AXIOM_ORG_ID) throw new Error("Axiom query credentials are not configured");
  const client = process.env.AXIOM_QUERY_TOKEN
    ? new Axiom({ token, orgId: process.env.AXIOM_ORG_ID }) : axiom;
  if (!client) throw new Error("Axiom client is unavailable");
  return client.query(apl, { ...options, format: "tabular" });
};

export const describeError = (error) => {
  const name = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(error.name) ? error.name : "Error";
  const rawCode = error?.code;
  const code = (typeof rawCode === "string" || typeof rawCode === "number") && /^[A-Z0-9_-]{1,64}$/i.test(String(rawCode))
    ? String(rawCode) : undefined;
  const rawStatus = Number(error?.statusCode || error?.status || error?.response?.status);
  const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : undefined;
  return { name, ...(code ? { code } : {}), ...(status ? { status } : {}) };
};

export const logOperationalError = (source, error, details = {}) => bestEffortLog(() => {
  ingestLog({
    level: "error", ts: new Date().toISOString(),
    meta: {
      service: "bgsnl-api", environment: process.env.APP_ENV || process.env.NODE_ENV, source: String(source).slice(0, 80),
      ...Object.fromEntries(Object.entries(details).filter(([key, value]) => /^[a-zA-Z]{1,30}$/.test(key) &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean")).map(([key, value]) => [key, String(value).slice(0, 100)]))
    },
    error: describeError(error),
  });
});

export const logIntegrationError = (provider, error, operation = "request") => bestEffortLog(() => {
  ingestIntegrationLog({
    level: "error", ts: new Date().toISOString(), provider: String(provider).slice(0, 40),
    operation: String(operation).slice(0, 60), meta: { service: "bgsnl-api", environment: process.env.APP_ENV || process.env.NODE_ENV },
    error: describeError(error)
  });
});

/**
 * Log an error to Axiom. Drop into any catch block.
 *
 * @param {unknown} err - The caught error
 * @param {{ req?: object, meta?: object }} [options]
 *   req  - Express request (method and normalized path only)
 *   meta - Fixed, non-personal diagnostic fields
 */
export const logError = (err, options = {}) => bestEffortLog(() => {
  const { req, meta } = options;
  const event = createErrorEvent({
    error: describeError(err),
    req: req || null,
    res: null,
    meta,
    redact: redactSensitive,
  });
  ingestLog(event);
});

/**
 * Express middleware – logs request method/path, status and duration only.
 */
export const axiomLogger = (req, res, next) => {
  bestEffortLog(() => {
    if (req.walletPrivate || req.paymentPrivate || req.supportPrivate || req.monitoringPrivate || !axiomIngestionEnabled()) {
      return;
    }

    const startTime = Date.now();
    res.once("finish", () => bestEffortLog(() => {
      const log = createInfoEvent({
        req,
        res: {
          statusCode: res.statusCode,
          statusMessage: res.statusMessage,
          durationMs: Date.now() - startTime,
        },
        meta: {},
        redact: redactSensitive,
      });
      ingestLog(log);
    }));
  });

  // Never catch application errors, and never invoke the endpoint twice.
  return next();
};

export default axiomLogger;

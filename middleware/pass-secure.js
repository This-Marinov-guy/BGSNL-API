import HttpError from "../models/Http-error.js";
import { timingSafeEqual } from "node:crypto";

const suppliedKey = (request) => request.headers["x-api-key"];

const equalKey = (provided, expected) => {
  if (typeof provided !== "string" || typeof expected !== "string" || !expected) return false;
  const left = Buffer.from(provided), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

// Used only to admit configured machine callers through the coarse firewall.
// Each route still checks its own named credential with requireServiceKey.
export const isConfiguredServiceRequest = (req) =>
  ["GOOGLE_SCRIPTS_PASS", "KOKO_APP_PASS"].some((name) =>
    equalKey(suppliedKey(req), process.env[name])
  );

/**
 * Machine-to-machine integration guard. It deliberately fails closed in every
 * environment: a missing key must disable an integration, never authenticate
 * an omitted header. Each integration receives a separate environment key.
 */
export const requireServiceKey = (environmentVariable) => (req, _res, next) => {
  const expected = process.env[environmentVariable];
  if (typeof expected !== "string" || expected.length < 32) {
    return next(new HttpError("This integration is not configured.", 503));
  }
  if (!equalKey(suppliedKey(req), expected)) {
    return next(new HttpError("Unauthorized integration request.", 403));
  }
  return next();
};

// Backwards-compatible export name for integrations that have not yet been
// split to their own key. New routes must name the credential explicitly.
export const passSecured = requireServiceKey("GOOGLE_SCRIPTS_PASS");

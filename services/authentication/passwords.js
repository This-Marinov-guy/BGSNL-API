import bcrypt from "bcryptjs";
import { timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import HttpError from "../../models/Http-error.js";

// Keep the existing algorithm/work factor: no forced password reset or bulk
// rehash of existing accounts. Salt generation belongs to bcrypt, not callers.
export const PASSWORD_COST = 12;
export const MAX_PASSWORD_BYTES = 72;
export const PASSWORD_VERIFICATION_MIN_MS = 750;
const MAX_VERIFY_PASSWORD_BYTES = 4096;
// Public, non-credential placeholder at the current work factor. A match against
// this value must NEVER authenticate a missing account or malformed stored hash.
const DUMMY_PASSWORD = "BGSNL-public-timing-placeholder-not-a-credential!";
const DUMMY_HASH = "$2a$12$mpVENArLF4BiaGipU9xXeuEZfRPW3lCeVA0JpvCrUJT9a736w3qOS";
export const PASSWORD_MESSAGE = "Use at least 8 characters with uppercase, lowercase and a number (maximum 72 UTF-8 bytes).";
const pattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/s;
const bcryptFormat = /^\$2[aby]\$(?:0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;

export const validNewPassword = (value) => typeof value === "string" &&
  Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_BYTES && pattern.test(value);
export const isPasswordHash = (value) => typeof value === "string" && bcryptFormat.test(value);

export async function hashPassword(value, { legacyCheckout = false } = {}) {
  // Compatibility ONLY for signed, pre-deployment checkout metadata: honor the
  // password already chosen/paid for, including bcrypt's historical truncation.
  const valid = legacyCheckout ? typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096 : validNewPassword(value);
  if (!valid) throw new HttpError(PASSWORD_MESSAGE, 422);
  // Never "detect and skip" hash-looking user input: it is still a raw password.
  return bcrypt.hash(value, PASSWORD_COST);
}

export function passwordVerificationMinimumMs(value = process.env.AUTH_PASSWORD_MIN_MS) {
  const configured = Number(value);
  // Server-only tuning; an empty/invalid/too-low setting cannot disable padding.
  return Number.isFinite(configured) && configured >= PASSWORD_VERIFICATION_MIN_MS && configured <= 5000
    ? Math.ceil(configured) : PASSWORD_VERIFICATION_MIN_MS;
}

export function createPasswordVerifier({
  derive = bcrypt.hash, equal = timingSafeEqual,
  now = () => performance.now(), wait = delay, minimumMs = passwordVerificationMinimumMs,
} = {}) {
  return async (value, storedHash, { startedAt = now() } = {}) => {
    const deadline = startedAt + minimumMs();
    // Do not apply NEW-password strength rules or truncate/normalize old inputs.
    // The cheap character bound avoids scanning unbounded strings from callers.
    const validInput = typeof value === "string" && value.length > 0 && value.length <= MAX_VERIFY_PASSWORD_BYTES &&
      Buffer.byteLength(value, "utf8") <= MAX_VERIFY_PASSWORD_BYTES;
    const validHash = isPasswordHash(storedHash);
    const target = validInput && validHash ? storedHash : DUMMY_HASH;
    try {
      // Always do bcrypt work, including missing/invalid hashes. Reuse the stored
      // salt/work factor for compatibility, then compare the fixed 60 bytes in
      // Node's native timing-safe primitive, not a JS character-by-character test.
      const computed = await derive(validInput ? value : DUMMY_PASSWORD, target.slice(0, 29));
      if (typeof computed !== "string" || Buffer.byteLength(computed) !== 60) return false;
      const matches = equal(Buffer.from(computed), Buffer.from(target));
      return validInput && validHash && matches;
    } catch {
      return false;
    } finally {
      // Cover old cheaper hashes, input processing and (for login) account lookup.
      // This is asynchronous padding, not a CPU spin or an exact wall-time promise.
      // Recheck the monotonic clock because timers can wake slightly early.
      let remaining;
      while ((remaining = deadline - now()) > 0) await wait(Math.ceil(remaining));
    }
  };
}

export const verifyPassword = createPasswordVerifier();

export function requirePasswordHash(value) {
  if (!isPasswordHash(value)) throw new Error("Registration password hash is invalid");
  return value;
}

export function registrationPasswordHash(registration) {
  // Preserve the existing `password` reservation contract; also accept the
  // explicit `passwordHash` variant. Trusted DB state only, NEVER a browser shortcut.
  if (registration?.passwordHash && registration.password && registration.passwordHash !== registration.password) {
    throw new Error("Conflicting registration password hashes");
  }
  return requirePasswordHash(registration?.passwordHash ?? registration?.password);
}

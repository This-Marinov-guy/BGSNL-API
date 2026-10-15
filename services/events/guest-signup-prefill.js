import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import HttpError from "../../models/Http-error.js";
import { HOME_URL, REGIONS } from "../../util/config/defines.js";

const context = Buffer.from("bgsnl:guest-signup-prefill:v1");
const invalid = () => new HttpError("This signup link is invalid or has expired. You can still choose a plan and enter your details.", 410);
const keyFor = env => {
  const secret = env.GUEST_SIGNUP_LINK_SECRET || env.JWT_STRING;
  if (!secret || secret.length < 32) throw new Error("Guest signup links require a server secret of at least 32 characters.");
  return hkdfSync("sha256", Buffer.from(secret), Buffer.from("bgsnl:guest-signup"), context, 32);
};

export function createGuestSignupToken(details, { env = process.env, now = Date.now() } = {}) {
  if (!REGIONS.includes(details.region) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)) throw new Error("Guest signup details are invalid.");
  const claims = { region: details.region, name: String(details.name || "").slice(0, 100),
    surname: String(details.surname || "").slice(0, 100), email: details.email.toLowerCase(),
    phone: String(details.phone || "").slice(0, 40), exp: now + 90 * 86400000 };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(env), iv);
  cipher.setAAD(context);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(claims), "utf8"), cipher.final()]);
  return `g1.${Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString("base64url")}`;
}

export function createGuestSignupLink(details, options) {
  return `${HOME_URL}/${encodeURIComponent(details.region)}/signup?prefill=${createGuestSignupToken(details, options)}`;
}

export function verifyGuestSignupToken(token, { env = process.env, now = Date.now() } = {}) {
  if (typeof token !== "string" || token.length > 1500 || !/^g1\.[A-Za-z0-9_-]+$/.test(token)) throw invalid();
  const raw = token.slice(3);
  const packed = Buffer.from(raw, "base64url");
  if (packed.length <= 28 || packed.toString("base64url") !== raw) throw invalid();
  let claims;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(env), packed.subarray(0, 12));
    decipher.setAAD(context);
    decipher.setAuthTag(packed.subarray(-16));
    claims = JSON.parse(Buffer.concat([decipher.update(packed.subarray(12, -16)), decipher.final()]).toString("utf8"));
  } catch { throw invalid(); }
  if (!claims || !REGIONS.includes(claims.region) || typeof claims.email !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) ||
    typeof claims.name !== "string" || typeof claims.surname !== "string" || typeof claims.phone !== "string" ||
    claims.name.length > 100 || claims.surname.length > 100 || claims.phone.length > 40 ||
    !Number.isSafeInteger(claims.exp) || claims.exp <= now) throw invalid();
  return { region: claims.region, name: claims.name, surname: claims.surname, email: claims.email, phone: claims.phone };
}

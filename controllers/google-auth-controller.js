import HttpError from "../models/Http-error.js";
import { requestClientAddress } from "../util/auth/request-client.js";
import AccountIdentity from "../models/AccountIdentity.js";
import { sessions } from "../services/authentication/sessions.js";
import { buildLoginResponse } from "../services/authentication/login.js";
import {
  googleClientId, limitGoogleRequests, verifyCurrentPassword, createGoogleChallenge,
  consumeGoogleChallenge, findGoogleAccount, changeGoogleIdentity, googleConnectionStatus,
} from "../services/authentication/google.js";

const authAction = (handler) => async (req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  try { return await handler(req, res); }
  catch (error) {
    if (error instanceof HttpError) return next(error);
    // Never log Google credentials, passwords or provider error request objects.
    console.error("Google authentication request failed", { code: error.code });
    return next(new HttpError("Account sign-in is temporarily unavailable. Please try again.", 503));
  }
};

export const getGoogleConfig = authAction(async (_req, res) => res.json({ enabled: !!googleClientId() }));
export const getConnectedAccounts = authAction(async (req, res) => {
  const identity = await AccountIdentity.findOne({ provider: "google", accountId: req.account.id });
  res.json({ google: googleConnectionStatus(req.account, identity), passkeys: { available: true } });
});

export const prepareGoogle = (purpose) => authAction(async (req, res) => {
  await limitGoogleRequests(`ip:${requestClientAddress(req)}`);
  if (purpose === "link") await limitGoogleRequests(`account:${req.account.id}`, 5);
  const challenge = await createGoogleChallenge({ purpose, origin: req.headers.origin, proof: req.body.proof,
    user: req.account, password: req.body.password });
  res.json(challenge);
});
export const completeGoogle = (purpose) => authAction(async (req, res) => {
  await limitGoogleRequests(`ip:${requestClientAddress(req)}`);
  const identity = await consumeGoogleChallenge({
    purpose, origin: req.headers.origin, user: req.account,
    challengeId: req.body.challengeId, proof: req.body.proof, credential: req.body.credential,
  });
  if (purpose === "link") {
    const user = await changeGoogleIdentity(req.account, identity);
    return res.json({ google: googleConnectionStatus(user, identity), ...await sessions.replace(user, { session: req.authClaims }) });
  }
  return res.json(await buildLoginResponse(await findGoogleAccount(identity)));
});
export const disconnectGoogle = authAction(async (req, res) => {
  await limitGoogleRequests(`account:${req.account.id}`, 5);
  await verifyCurrentPassword(req.account, req.body.password);
  const user = await changeGoogleIdentity(req.account);
  // Disconnection revokes old sessions, including those originally issued via Google.
  res.json({ google: googleConnectionStatus(user), ...await sessions.replace(user, { session: req.authClaims }) });
});

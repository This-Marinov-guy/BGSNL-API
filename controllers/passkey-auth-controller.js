import HttpError from "../models/Http-error.js";
import { requestClientAddress } from "../util/auth/request-client.js";
import { sessions } from "../services/authentication/sessions.js";
import { buildLoginResponse } from "../services/authentication/login.js";
import { listPasskeys, preparePasskey, registerPasskey, authenticatePasskey, removePasskey, limitPasskeyRequests } from "../services/authentication/passkeys.js";

const authAction = (handler) => async (req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  try { return await handler(req, res); }
  catch (error) {
    if (error instanceof HttpError) return next(error);
    // Provider error objects can contain credentials; never log them.
    console.error("Passkey request failed", { code: typeof error.code === "number" ? error.code : "unavailable" });
    return next(new HttpError("Passkeys are temporarily unavailable. Please try again or use your BGSNL password.", 503));
  }
};

export const getPasskeys = authAction(async (req, res) => res.json({ passkeys: await listPasskeys(req.account) }));

export const prepare = (purpose) => authAction(async (req, res) => {
  await limitPasskeyRequests(`ip:${requestClientAddress(req)}`);
  if (purpose === "register") await limitPasskeyRequests(`account:${req.account.id}`, 5);
  return res.json(await preparePasskey({ purpose, origin: req.headers.origin, proof: req.body.proof,
    user: req.account, password: req.body.password, name: req.body.name }));
});

export const complete = (purpose) => authAction(async (req, res) => {
  await limitPasskeyRequests(`ip:${requestClientAddress(req)}`);
  const input = { origin: req.headers.origin, proof: req.body.proof, challengeId: req.body.challengeId,
    credential: req.body.credential, user: req.account };
  if (purpose === "register") {
    await registerPasskey(input);
    return res.json({ passkeys: await listPasskeys(req.account) });
  }
  return res.json(await buildLoginResponse(await authenticatePasskey(input)));
});

export const remove = authAction(async (req, res) => {
  await limitPasskeyRequests(`ip:${requestClientAddress(req)}`);
  await limitPasskeyRequests(`account:${req.account.id}`, 5);
  const user = await removePasskey({ user: req.account, password: req.body.password, credentialId: req.body.credentialId });
  return res.json({ passkeys: await listPasskeys(user), ...await sessions.replace(user, { session: req.authClaims }) });
});

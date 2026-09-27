import { body } from "express-validator";

const randomToken = (name) => body(name).isString().bail().matches(/^[a-zA-Z0-9_-]{43,128}$/).withMessage("Please start Google sign-in again.");
export const googlePasswordValidators = [body("password").isString().bail().isLength({ min: 1, max: 256 }).withMessage("Enter your current BGSNL password.")];
export const googleChallengeValidators = [randomToken("proof")];
export const googleLinkChallengeValidators = [...googleChallengeValidators, ...googlePasswordValidators];
export const googleCredentialValidators = [
  randomToken("proof"), randomToken("challengeId"),
  body("credential").isString().bail().isLength({ min: 100, max: 8192 }).bail()
    .matches(/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/).withMessage("Google did not return a valid sign-in credential."),
];

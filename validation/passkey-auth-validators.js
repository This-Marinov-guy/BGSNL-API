import { body } from "express-validator";

const encoded = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && /^[a-zA-Z0-9_-]+$/.test(value);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const randomToken = (name) => body(name).isString().bail().matches(/^[a-zA-Z0-9_-]{43,128}$/).withMessage("Please start the passkey request again.");
const password = () => body("password").isString().bail().isLength({ min: 1, max: 256 }).withMessage("Enter your current BGSNL password.");

export const passkeyOptionsValidators = [randomToken("proof")];
export const passkeyRegistrationOptionsValidators = [randomToken("proof"), password(),
  body("name").isString().bail().trim().isLength({ min: 1, max: 60 }).bail()
    .custom((value) => ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)).withMessage("Give your passkey a name of up to 60 characters."),
];

export const passkeyCredentialValidators = (purpose) => [randomToken("proof"), randomToken("challengeId"),
  body("credential").custom((credential) => {
    if (!object(credential) || !encoded(credential.id, 1400) || credential.id !== credential.rawId || credential.type !== "public-key" ||
        !object(credential.response) || !encoded(credential.response.clientDataJSON, 8192) ||
        !object(credential.clientExtensionResults) || JSON.stringify(credential.clientExtensionResults).length > 4096) return false;
    const response = credential.response;
    if (purpose === "register") {
      return encoded(response.attestationObject, 65536) && (response.transports === undefined ||
        (Array.isArray(response.transports) && response.transports.length <= 10 && response.transports.every((value) =>
          ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"].includes(value))));
    }
    return encoded(response.authenticatorData, 8192) && encoded(response.signature, 2048) && encoded(response.userHandle, 128);
  }).withMessage("Your device did not return a valid passkey response. Please try again."),
];

export const passkeyRemoveValidators = [password(), body("credentialId").custom((value) => encoded(value, 1400)).withMessage("Choose a passkey to remove.")];

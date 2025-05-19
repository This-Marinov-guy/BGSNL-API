import HttpError from "../models/Http-error.js";
import { IS_PROD } from "../util/functions/helpers.js";
// import CryptoJS from "crypto-js";

export const passSecured = (req, res, next) => {
  const authHeader = req.headers["x-api-key"];
  //   const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN
  //   const encryptedKey = CryptoJS.AES.encrypt(
  //     process.env.JWT_STRING,
  //     process.env.CRYPTO_ENCRYPTION_KEY
  //   ).toString();

  if (IS_PROD && authHeader !== process.env.GOOGLE_SCRIPTS_PASS) {
    return next(new HttpError("Unathorized access!", 403));
  }

  next();
};

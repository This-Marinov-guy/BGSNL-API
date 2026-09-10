import dotenv from "dotenv";
import { performance } from "node:perf_hooks";
dotenv.config();
import { hashPassword, verifyPassword } from "../services/authentication/passwords.js";
import { validationResult } from "express-validator";
import HttpError from "../models/Http-error.js";
import User from "../models/User.js";
import {
  alumniWelcomeEmail,
  sendNewPasswordEmail,
  welcomeEmail,
} from "../services/background-services/email-transporter.js";
import {
  alumniToSpreadsheet,
  usersToSpreadsheet,
} from "../services/background-services/google-spreadsheets.js";
import {
  chooseRandomAvatar,
  decryptData,
  encryptData,
  isBirthdayToday,
  jwtSign,
} from "../util/functions/helpers.js";
import {
  ADMIN,
  MEMBER,
} from "../util/config/defines.js";
import { calculatePurchaseAndExpireDates } from "../util/functions/dateConvert.js";
import { issuePasswordReset, verifyPasswordReset, completePasswordReset } from "../services/authentication/password-reset.js";
import {
  findUserByEmail,
  normalizeEmail,
} from "../services/main-services/user-service.js";
import AlumniUser from "../models/AlumniUser.js";
import { buildLoginResponse } from "../services/authentication/login.js";

export const postCheckEmail = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const error = new HttpError("Invalid inputs passed", 422);
    return next(error);
  }

  const email = normalizeEmail(req.body.email);
  if (!email) {
    return next(new HttpError("Please send a valid email", 422));
  }

  let existingUser;
  try {
    existingUser = await findUserByEmail(email);
  } catch (err) {
    const error = new HttpError("Email verifying failed", 500);
    return next(error);
  }

  if (existingUser) {
    const error = new HttpError("Email is already in use", 422);
    return next(error);
  }

  return res.status(200).send({ status: true });
};

export const postDirectSignupDisabled = (req, res, next) => {
  return next(
    new HttpError(
      "Direct signup is disabled. Please complete signup through checkout.",
      403
    )
  );
};

export const signup = async (req, res, next, { notify = welcomeEmail, sync = usersToSpreadsheet } = {}) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const error = new HttpError("Invalid inputs passed", 422);
    return next(error);
  }

  const {
    region,
    period,
    name,
    surname,
    birth,
    phone,
    email: rawEmail,
    university,
    otherUniversityName,
    graduationDate,
    course,
    studentNumber,
    profession,
    notificationTypeTerms,
  } = req.body;
  const email = normalizeEmail(rawEmail);
  if (!email) {
    return next(new HttpError("Please send a valid email", 422));
  }

  const password = decryptData(req.body.password);

  let hashedPassword;
  try {
    hashedPassword = await hashPassword(password);
  } catch (err) {
    return next(new HttpError("Could not create a new user", 500));
  }

  let image;
  if (!req.file) {
    image = chooseRandomAvatar();
  } else {
    image = req.file.Location;
  }

  const { purchaseDate, expireDate } = calculatePurchaseAndExpireDates(1200);

  const createdUser = new User({
    status: "freezed",
    region,
    joinDate: new Date(),
    purchaseDate,
    expireDate,
    image,
    name,
    surname,
    birth: new Date(birth),
    phone,
    email,
    university,
    otherUniversityName: university === "other" ? otherUniversityName : undefined,
    graduationDate: university === "working" ? undefined : graduationDate,
    course: university === "working" ? undefined : course,
    studentNumber: university === "working" ? undefined : studentNumber,
    profession: university === "working" ? profession : undefined,
    password: hashedPassword,
    notificationTypeTerms,
    tickets: [],
    roles: [ADMIN],
  });

  try {
    await createdUser.save();
  } catch (err) {
    const error = new HttpError("Signing up failed", 500);
    return next(error);
  }

  let token;
  try {
    token = await jwtSign(createdUser);
  } catch (err) {
    const error = new HttpError("Signing up failed", 500);
    return next(error);
  }

  sync(region);
  sync();

  if (isBirthdayToday(birth)) {
    return res
      .status(201)
      .json({ token, region, celebrate: true, roles: [MEMBER] });
  }

  notify(email, name, region);

  return res.status(201).json({ token, region, roles: [MEMBER] });
};

export const alumniSignup = async (req, res, next, { notify = alumniWelcomeEmail, sync = alumniToSpreadsheet } = {}) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const error = new HttpError("Invalid inputs passed", 422);
    return next(error);
  }

  let existingUser;
  try {
    existingUser = await findUserByEmail(req.body.email);
  } catch {
    return next(new HttpError("Could not check the existing account. Please try again.", 503));
  }

  if (existingUser) {
    return next(
      new HttpError(
        "Looks like you already have an account - please login and upgrade to an alumni account from there",
        422
      )
    );
  }

  const { tier, period, name, surname, phone, notificationTypeTerms } = req.body;
  const notificationTerms =
    req.body.notificationTerms === true || req.body.notificationTerms === "true";
  const email = normalizeEmail(req.body.email);
  if (!email) {
    return next(new HttpError("Please send a valid email", 422));
  }

  const password = decryptData(req.body.password);

  let hashedPassword;
  try {
    hashedPassword = await hashPassword(password);
  } catch (err) {
    return next(new HttpError("Could not create a new user", 500));
  }

  let image;
  if (!req.file) {
    image = chooseRandomAvatar();
  } else {
    image = req.file.Location;
  }

  const { purchaseDate, expireDate } = calculatePurchaseAndExpireDates(1200);

  const createdUser = new AlumniUser({
    status: "freezed",
    tier,
    joinDate: new Date(),
    purchaseDate,
    expireDate,
    image,
    name,
    surname,
    phone,
    email,
    password: hashedPassword,
    notificationTerms,
    notificationTypeTerms: notificationTerms
      ? notificationTypeTerms || "whatsapp & email"
      : undefined,
    tickets: [],
    roles: [ADMIN],
  });

  try {
    await createdUser.save();
  } catch (err) {
    const error = new HttpError("Signing up failed", 500);
    return next(error);
  }

  let token;
  try {
    token = await jwtSign(createdUser);
  } catch (err) {
    const error = new HttpError("Signing up failed", 500);
    return next(error);
  }

  sync();

  notify(email, name);

  return res.status(201).json({ token, region: null, roles: [MEMBER] });
};

export const createPasswordLogin = ({
  findAccount = findUserByEmail, buildResponse = buildLoginResponse,
  verify = verifyPassword, now = () => performance.now(),
} = {}) => async (req, res, next) => {
  // Start before lookup so DB misses and faster legacy hashes share one deadline.
  // This timestamp is server-owned; never accept a deadline from the request.
  const startedAt = now();
  const { password } = req.body;
  const email = normalizeEmail(req.body.email);

  let existingUser;
  let lookupFailed = false;

  try {
    existingUser = await findAccount(email);
  } catch {
    lookupFailed = true;
  }

  let isValidPassword = false;
  try {
    isValidPassword = await verify(password, existingUser?.password, { startedAt });
  } catch {
    return next(new HttpError("Sign-in is temporarily unavailable. Please try again shortly.", 503));
  }

  if (lookupFailed) return next(new HttpError("Sign-in is temporarily unavailable. Please try again shortly.", 503));

  if (!existingUser || !isValidPassword) {
    const error = new HttpError("Invalid credentials", 401);
    return next(error);
  }

  try {
    return res.status(201).json(await buildResponse(existingUser));
  } catch {
    return next(new HttpError("Logging in failed, please try again", 503));
  }
};

export const login = createPasswordLogin();

export const postSendPasswordResetEmail = async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const user = await findUserByEmail(email);
    if (user) {
      const code = await issuePasswordReset(user);
      await sendNewPasswordEmail(email, code);
    }
    // Identical status and body whether the address exists or not.
    return res.status(200).json({ status: true });
  } catch {
    return next(new HttpError("Password reset is temporarily unavailable. Please try again shortly.", 503));
  }
};

export const postVerifyToken = async (req, res, next) => {
  try {
    const user = await findUserByEmail(normalizeEmail(req.body.email));
    await verifyPasswordReset(user, req.body.token);
    return res.status(201).json({ status: true });
  } catch (error) {
    return next(error instanceof HttpError ? error : new HttpError("Password reset is temporarily unavailable. Please try again shortly.", 503));
  }
};

export const patchUserPassword = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return next(new HttpError("Please send valid inputs", 422));
  try {
    const user = await findUserByEmail(normalizeEmail(req.body.email));
    await completePasswordReset(user, req.body.token, req.body.password);
    return res.status(200).json({ status: true });
  } catch (error) {
    return next(error instanceof HttpError ? error : new HttpError("Password reset is temporarily unavailable. Please try again shortly.", 503));
  }
};

export const encryptDataController = async (req, res, next) => {
  const { data } = req.body;
  const encryptedData = encryptData(data);
  return res.status(200).json({ status: true, encryptedData });
};

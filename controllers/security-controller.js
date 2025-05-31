import dotenv from "dotenv";
dotenv.config();
import bcrypt from "bcryptjs";
import { validationResult } from "express-validator";
import HttpError from "../models/Http-error.js";
import User from "../models/User.js";
import {
  sendNewPasswordEmail,
  welcomeEmail,
} from "../services/side-services/email-transporter.js";
import { ACCOUNT_KEYS } from "../util/config/KEYS.js";
import { usersToSpreadsheet } from "../services/side-services/google-spreadsheets.js";
import {
  chooseRandomAvatar,
  compareIntStrings,
  decryptData,
  hasOverlap,
  isBirthdayToday,
  jwtSign,
} from "../util/functions/helpers.js";
import { ADMIN, LIMITLESS_ACCOUNT, MEMBER } from "../util/config/defines.js";
import { forgottenPassTokenCache } from "../util/config/caches.js";
import moment from "moment";
import { calculatePurchaseAndExpireDates } from "../util/functions/dateConvert.js";
import { LOCKED, USER_STATUSES } from "../util/config/enums.js";
import TemporaryCode from "../models/TemporaryCode.js";

export const postCheckEmail = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const error = new HttpError("Invalid inputs passed", 422);
    return next(error);
  }

  const email = req.body.email;

  let existingUser;
  try {
    existingUser = await User.findOne({ email: email });
  } catch (err) {
    const error = new HttpError("Email verifying failed", 500);
    return next(error);
  }

  if (existingUser) {
    const error = new HttpError("Email is already in use", 422);
    return next(error);
  }

  res.status(200).send({ status: true });
};

export const postCheckMemberKey = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const error = new HttpError("No key found", 422);
    return next(error);
  }

  const { email } = req.body;

  const result = ACCOUNT_KEYS.includes(email.toLowerCase());

  res.status(200).send({ status: result });
};

export const signup = async (req, res, next) => {
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
    email,
    university,
    otherUniversityName,
    graduationDate,
    course,
    studentNumber,
    notificationTypeTerms,
  } = req.body;

  const password = decryptData(req.body.password);

  let hashedPassword;
  try {
    hashedPassword = await bcrypt.hash(password, 12);
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
    purchaseDate,
    expireDate,
    image,
    name,
    surname,
    birth: new Date(birth),
    phone,
    email,
    university,
    otherUniversityName,
    graduationDate,
    course,
    studentNumber,
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

  await usersToSpreadsheet(region);
  await usersToSpreadsheet();

  if (isBirthdayToday(birth)) {
    return res
      .status(201)
      .json({ token, region, celebrate: true, roles: [MEMBER] });
  }

  await welcomeEmail(email, name, region);

  res.status(201).json({ token, region, roles: [MEMBER] });
};

export const login = async (req, res, next) => {
  const { email, password } = req.body;

  let existingUser;

  try {
    existingUser = await User.findOne({ email: email });
  } catch (err) {
    console.log(err);
    const error = new HttpError("Logging in failed", 500);
    return next(error);
  }

  if (!existingUser) {
    const error = new HttpError("Invalid credentials", 401);
    return next(error);
  }

  let isValidPassword = false;
  try {
    isValidPassword = await bcrypt.compare(password, existingUser.password);
  } catch (err) {
    console.log(err);
    return next(
      new HttpError("Could not log you in, please check your credentials", 500)
    );
  }

  if (!isValidPassword) {
    const error = new HttpError("Invalid credentials", 401);
    return next(error);
  }

  //check for expired account and lock it if necessary
  const today = new Date();

  if (
    !hasOverlap(LIMITLESS_ACCOUNT, existingUser.roles) &&
    today > existingUser.expireDate
  ) {
    existingUser.status = USER_STATUSES[LOCKED];
    try {
      await existingUser.save();
    } catch (err) {
      console.log(err);
      const error = new HttpError("Logging in failed, please try again", 500);
      return next(error);
    }
  }

  let token;
  try {
    token = await jwtSign(existingUser);
  } catch (err) {
    console.log(err);
    const error = new HttpError("Logging in failed", 500);
    return next(error);
  }

  const isSubscribed = !!(
    existingUser.subscription &&
    existingUser.subscription.id &&
    existingUser.subscription.customerId
  );
  const existingUserData = {
    token,
    isSubscribed,
    region: existingUser.region,
    roles: existingUser.roles,
    status: existingUser.status,
  };

  if (isBirthdayToday(existingUser.birth)) {
    return res.status(201).json({ ...existingUserData, celebrate: true });
  }

  return res.status(201).json(existingUserData);
};

export const postSendPasswordResetEmail = async (req, res, next) => {
  const email = req.body.email;
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!regex.test(email)) {
    return next(new HttpError("Please send a valid email", 422));
  }

  let user;
  try {
    user = await User.findOne({ email: email });
  } catch (err) {
    console.log(err);
  }

  if (!user) {
    return res.status(201).json({ status: true });
  }

  try {
    const resetToken = Math.floor(100000 + Math.random() * 900000);

    const temporaryCode = new TemporaryCode({
      userId: user._id,
      code: resetToken,
      life: 3,
    });

    await temporaryCode.save();

    await sendNewPasswordEmail(email, resetToken);
  } catch (err) {
    console.log(err);
    return next(new HttpError("Something went wrong, please try again", 500));
  }

  return res.status(200).json({ status: true });
};

export const postVerifyToken = async (req, res, next) => {
  const { token, email } = req.body;
  let user;

  try {
    user = await User.findOne({ email: email });
  } catch (err) {
    console.log(err);
    return next(new HttpError("Invalid code, please try again", 400));
  }

  if (!user) {
    return next(new HttpError("Invalid code, please try again", 400));
  }

  try {
    const temporaryCode = await TemporaryCode.findOne({
      userId: user?.id,
    });

    if (temporaryCode.code != token) {
      if (temporaryCode.life < 1) {
        await TemporaryCode.deleteOne({ _id: temporaryCode._id });

        return next(
          new HttpError(
            "You have reached your maximum attempts - please start again",
            400
          )
        );
      }

      temporaryCode.life = temporaryCode.life - 1;
      await temporaryCode.save();

      return next(new HttpError("Invalid code, please try again", 400));
    }
  } catch (err) {
    console.log(err);

    return next(new HttpError("Something went wrong, please try again", 500));
  }

  if (
    !user
    // remove the need for phone and birth verification as it is too complicated
    // ||
    // !compareIntStrings(user.phone, phone) ||
    // !moment(user.birth).format("DD MM YY") === birth
  ) {
    const error = new HttpError("No such user with the provided data", 500);
    return next(error);
  }

  return res.status(201).json({ status: true });
};

export const patchUserPassword = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new HttpError("Please send valid inputs", 422));
  }

  const { email, password, token } = req.body;
  let existingUser;
  let temporaryCode;

  try {
    existingUser = await User.findOne({ email: email });
    temporaryCode = await TemporaryCode.findOne({
      userId: existingUser?._id,
      code: token,
    });
  } catch (err) {
    console.log(err);
    return next(new HttpError("Invalid code, please try again", 400));
  }

  if (!existingUser) {
    const error = new HttpError(
      "Changing password failed, please try again!",
      500
    );
    return next(error);
  }

  if (!existingUser || temporaryCode.life < 1 || temporaryCode.code != token) {
    return next(new HttpError("Service expired, please start again!", 400));
  }

  let hashedPassword;
  try {
    hashedPassword = await bcrypt.hash(password, 12);
  } catch (err) {
    console.log(err);
    return next(
      new HttpError("Changing password failed, please try again!", 500)
    );
  }

  try {
    existingUser.password = hashedPassword;
    await existingUser.save();
    await TemporaryCode.deleteOne({ _id: temporaryCode._id });
  } catch (err) {
    console.log(err);
    return next(new HttpError("Something went wrong, please try again", 500));
  }

  return res.status(200).json({ status: true });
};

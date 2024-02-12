import dotenv from "dotenv";
dotenv.config();
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { validationResult } from "express-validator";
import HttpError from "../models/Http-error.js";
import User from "../models/User.js";
import { sendNewPasswordEmail, welcomeEmail } from "../middleware/email-transporter.js";
import { format } from "date-fns";
import { formatReverseDate } from "../util/dateConvert.js";
import ActiveMembers from "../models/ActiveMembers.js";
import { MEMBER_KEYS } from "../util/KEYS.js";
import { activeMembersToSpreadsheet, usersToSpreadsheet } from "./database-controllers.js";

const getCurrentUser = async (req, res, next) => {
  const userId = req.params.userId;

  let user;
  try {
    user = await User.findById(userId);
  } catch (err) {
    const error = new HttpError("Could not fetch user", 500);
    return next(error);
  }
  res
    .status(201)
    .json({ status: user.status, user: user.toObject({ getters: true }) });
};

const postCheckEmail = async (req, res, next) => {
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

  res.status(200).send({ message: "verified" });
};

const postCheckMemberKey = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const error = new HttpError("No key found", 422);
    return next(error);
  }

  const { email, key } = req.body;

  const result = MEMBER_KEYS.find(
    (obj) => obj.email.toLowerCase().replace(/\s/g, "") === email.toLowerCase() && obj.key.toLowerCase().replace(/\s/g, "") === key.toLowerCase()
  );

  if (result) {
    res.status(201).send({ message: "verifiedKey" });
  } else {
    const error = new HttpError(
      "Invalid key! Please check you email and key and try again!",
      422
    );
    return next(error);
  }
};

const signup = async (req, res, next) => {
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
    password,
    notificationTypeTerms,
  } = req.body;

  let hashedPassword;
  try {
    hashedPassword = await bcrypt.hash(password, 12);
  } catch (err) {
    return next(new HttpError("Could not create a new user", 500));
  }

  let image;
  if (!req.file) {
    image = `/assets/images/avatars/bg_other_avatar_${Math.floor(
      Math.random() * 3 + 1
    )}.jpeg`;
  } else {
    image = req.file.Location;
  }

  const expireYear = new Date().getFullYear() + period

  const createdUser = new User({
    status: "active",
    region,
    purchaseDate: format(new Date(), "dd MMM yyyy"),
    //membership is 1 or 3 year/s
    expireDate: "31 Aug" + expireYear,
    image,
    name,
    surname,
    birth: formatReverseDate(birth),
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
  });

  try {
    await createdUser.save();
  } catch (err) {
    const error = new HttpError("Signing up failed", 500);
    return next(error);
  }

  let token;
  try {
    token = jwt.sign(
      { userId: createdUser.id, email: createdUser.email },
      process.env.JWT_STRING,
      { expiresIn: "1h" }
    );
  } catch (err) {
    const error = new HttpError("Signing up failed", 500);
    return next(error);
  }

  welcomeEmail(email, name)

  usersToSpreadsheet()

  res.status(201).json({ userId: createdUser.id, token: token });
};

const login = async (req, res, next) => {
  const { email, password } = req.body;

  let existingUser;

  try {
    existingUser = await User.findOne({ email: email });
  } catch (err) {
    const error = new HttpError("Logging in failed", 500);
    return next(error);
  }

  if (!existingUser) {
    const error = new HttpError("No such user email", 401);
    return next(error);

  }

  let isValidPassword = false;
  try {
    isValidPassword = await bcrypt.compare(password, existingUser.password);
  } catch (err) {
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

  if (today > new Date(existingUser.expireDate)) {
    existingUser.status = "locked";
    try {
      await existingUser.save();
    } catch (err) {
      const error = new HttpError("Logging in failed, please try again", 500);
      return next(error);
    }
  }

  let token;
  try {
    token = jwt.sign(
      { userId: existingUser.id, email: existingUser.email },
      process.env.JWT_STRING,
      { expiresIn: "1h" }
    );
  } catch (err) {
    const error = new HttpError("Logging in failed", 500);
    return next(error);
  }

  res.status(201).json({ userId: existingUser.id, token: token });
};

const postActiveMember = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new HttpError("Имате невалидни данни или неселектирани полета", 422));
  }

  const { positions, date, email, phone, questions } = req.body;

  const timestamp = new Date();

  const newActiveMember = new ActiveMembers({
    timestamp,
    positions,
    date,
    email,
    phone,
    cv: req.files['cv'] ? req.files['cv'][0].location : null,
    // letter: req.files['letter'][0].location,
    questions: {
      q1: questions[0],
      q2: questions[1],
      q3: questions[2],
      q4: questions[3],
      q5: questions[4],
      q6: questions[5],
      q7: questions[6],
      q8: questions[7],
      q9: questions[8],
      q10: questions[9],
    },
  });

  try {
    await newActiveMember.save();
  } catch (err) {
    const error = new HttpError("Грешка при записването, моля опитайте пак", 500);
    return next(error);
  }

  activeMembersToSpreadsheet();

  res.status(201).json({ message: 'Done' });

}

const postSendPasswordResetEmail = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new HttpError("Please send an email", 422));
  }

  req.app.locals.resetToken = Math.floor(10000000 + Math.random() * 90000000);

  const email = req.body.email;

  let existingUser;

  try {
    existingUser = await User.findOne({ email: email });
  } catch (err) {
    return next(new HttpError("No such user", 500));
  }

  sendNewPasswordEmail(email, req.app.locals.resetToken);

  res.status(201).json({ email: existingUser.email });
};

const patchUserPassword = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new HttpError("Please send valid inputs", 422));
  }

  const resetToken = req.app.locals.resetToken;
  const { email, password, userToken } = req.body;

  if (userToken !== resetToken) {
    return next(new HttpError("Invalid Token", 422));
  }

  let existingUser;

  try {
    existingUser = await User.findOne({ email: email });
  } catch (err) {
    const error = new HttpError("Changing password failed, please try again!", 500);
    return next(error);
  }

  if (!existingUser) {
    const error = new HttpError("Changing password failed, please try again!", 500);
    return next(error);
  }

  let hashedPassword;
  try {
    hashedPassword = await bcrypt.hash(password, 12);
  } catch (err) {
    return next(new HttpError("Changing password failed, please try again!", 500));
  }

  try {
    existingUser.password = hashedPassword;
    await existingUser.save();
  } catch (err) {
    return next(new HttpError("Something went wrong, please try again", 500));
  }

  res.status(200).json({ message: "Password changed!" });
};

const patchUserInfo = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new HttpError("Invalid inputs", 422));
  }

  const {
    name,
    surname,
    phone,
    email,
    university,
    otherUniversityName,
    graduationDate,
    course,
    studentNumber,
    notificationTypeTerms,
  } = req.body;

  const userId = req.params.userId;

  let user;

  try {
    user = await User.findById(userId);
  } catch (err) {
    return next(
      new HttpError("Could not find the current user, please try again", 500)
    );
  }
  if (req.file) {
    user.image = req.file.Location;
  }
  user.name = name;
  user.surname = surname;
  user.phone = phone;
  user.email = email;
  user.university = university;
  user.otherUniversityName = otherUniversityName;
  user.graduationDate = graduationDate;
  user.course = course;
  user.studentNumber = studentNumber;
  user.notificationTypeTerms = notificationTypeTerms;

  try {
    await user.save();
  } catch (err) {
    return next(new HttpError("Something went wrong, please try again", 500));
  }

  usersToSpreadsheet()

  res.status(200).json({ message: "done" });
};

const patchUserStatus = async (req, res, next) => {
  const {userId, itemId} = req.body;

  let user;

  try {
    user = await User.findById(userId);
  } catch (err) {
    return next(
      new HttpError("Could not find the current user, please try again", 500)
    );
  }

  user.status = "active";
  user.purchaseDate = format(new Date(), "dd MMM yyyy");
  //membership is 4 months
  user.expireDate = "31 Aug 2025";

  try {
    await user.save();
  } catch (err) {
    return next(new HttpError("Something went wrong, please try again", 500));
  }

  usersToSpreadsheet()

  res.status(200).json({ message: "done" });
};

export {
  signup,
  login,
  postSendPasswordResetEmail,
  postCheckEmail,
  postCheckMemberKey,
  postActiveMember,
  getCurrentUser,
  patchUserInfo,
  patchUserPassword,
  patchUserStatus,
};

import dotenv from 'dotenv';
dotenv.config();
import bcrypt from 'bcryptjs';
import { validationResult } from 'express-validator';
import HttpError from '../models/Http-error.js';
import User from '../models/User.js';
import ActiveMembers from '../models/ActiveMembers.js';
import { usersToSpreadsheet } from '../services/side-services/google-spreadsheets.js';
import { isBirthdayToday, jwtRefresh } from '../util/functions/helpers.js';
import { extractUserFromRequest } from '../util/functions/security.js';
import { getTokenFromHeader } from '../util/functions/security.js';
import { ACTIVE, USER_STATUSES } from '../util/config/enums.js';

export const refreshToken = async (req, res, next) => {
  let newToken = null;

  try {
    const token = getTokenFromHeader(req);
  
    newToken = jwtRefresh(token);
  } catch {
    newToken = null;
  }

  return res.status(201).json({ token: newToken });
};

export const getCurrentUser = async (req, res, next) => {
  const { userId } = extractUserFromRequest(req);

  const withTickets = req.query.withTickets ?? false;
  const withChristmas = req.query.withChristmas ?? false;

  let user;
  try {
    user = await User.findById(userId);
  } catch (err) {
    const error = new HttpError('Could not fetch user', 500);
    return next(error);
  }

  user = user.toObject({ getters: true });

  delete user.password;
  user.registrationKey && delete user.registrationKey;
  !withTickets && delete user.tickets;
  !withChristmas && delete user.christmas;

  if (user.status !== USER_STATUSES[ACTIVE]) {
    return res
      .status(200)
      .json({ status: user.status, user: {id: user._id, status: user.status, subscription: user.subscription} });
  }

  if (isBirthdayToday(user.birth)) {
    return res
      .status(200)
      .json({ status: user.status, user, celebrate: true });
  }

  return res
    .status(200)
    .json({ status: user.status, user });
};

export const getCurrentUserSubscriptionStatus = async (req, res, next) => {
  const { userId } = extractUserFromRequest(req);

  let user;
  try {
    user = await User.findById(userId);
  } catch (err) {
    const error = new HttpError('Could not fetch user', 500);
    return next(error);
  }

  user = user.toObject({ getters: true });
  const isSubscribed = !!(user.subscription && user.subscription.id && user.subscription.customerId);
  
  return res
    .status(200)
    .json({
      isSubscribed,
      status: user.status,
    });
};

export const getCurrentUserRoles = async (req, res, next) => {
  const { userId } = extractUserFromRequest(req);

  let user;
  try {
    user = await User.findById(userId);
  } catch (err) {
    const error = new HttpError('Could not fetch user', 500);
    return next(error);
  }

  user = user.toObject({ getters: true });

  res
    .status(201)
    .json({ status: user.status, roles: user.roles });
};

export const postActiveMember = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new HttpError('Имате невалидни данни или неселектирани полета', 422));
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
    const error = new HttpError('Грешка при записването, моля опитайте пак', 500);
    return next(error);
  }

  activeMembersToSpreadsheet();

  res.status(201).json({ message: 'Done' });

};

export const patchUserInfo = async (req, res, next) => {
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
    password,
  } = req.body;

  const { userId } = extractUserFromRequest(req);

  let user;

  try {
    user = await User.findById(userId);
  } catch (err) {
    return next(
      new HttpError('Could not find the current user, please try again', 500)
    );
  }
  if (req.file) {
    user.image = req.file.Location;
  }

  if (password) {
    let hashedPassword;
    try {
      hashedPassword = await bcrypt.hash(password, 12);
    } catch (err) {
      return next(new HttpError('Updating user failed, please try again!', 500));
    }

    user.password = hashedPassword;
  }

  name && (user.name = name);
  surname && (user.surname = surname);
  phone && (user.phone = phone);
  email && (user.email = email);
  university && (user.university = university);
  otherUniversityName && (user.otherUniversityName = otherUniversityName);
  graduationDate && (user.graduationDate = graduationDate);
  course && (user.course = course);
  studentNumber && (user.studentNumber = studentNumber);
  notificationTypeTerms && (user.notificationTypeTerms = notificationTypeTerms);

  try {
    await user.save();
  } catch (err) {
    return next(new HttpError('Something went wrong, please try again', 500));
  }

  await usersToSpreadsheet(user.region);
  await usersToSpreadsheet();

  res.status(200).json({ status: true });
};

export const submitCalendarVerification = async (req, res, next) => {
  const { userId } = extractUserFromRequest(req);

  let user;
  let calendarImage;

  try {
    user = await User.findById(userId);
  } catch (err) {
    return next(
      new HttpError("Could not find the current user, please try again", 500)
    );
  }

  if (req.file) {
    calendarImage = req.file.location;
  } else {
    return next(
      new HttpError("Please provide an image!", 500)
    );
  }

  user.mmmCampaign2025.calendarImage = calendarImage;

  try {
    await user.save();
  } catch (err) {
    return next(new HttpError("Something went wrong, please try again", 500));
  }

  res.status(200).json({ status: true });
};

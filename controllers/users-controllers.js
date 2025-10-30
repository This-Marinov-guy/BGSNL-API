import dotenv from "dotenv";
dotenv.config();
import bcrypt from "bcryptjs";
import { validationResult } from "express-validator";
import HttpError from "../models/Http-error.js";
import ActiveMembers from "../models/ActiveMembers.js";
import { usersToSpreadsheet } from "../services/background-services/google-spreadsheets.js";
import { isBirthdayToday, jwtRefresh } from "../util/functions/helpers.js";
import { extractUserFromRequest } from "../util/functions/security.js";
import { getTokenFromHeader } from "../util/functions/security.js";
import {
  ACTIVE,
  ALUMNI_MIGRATED,
  USER_STATUSES,
  MEMBERSHIP_ACTIVE,
} from "../util/config/enums.js";
import { generateAnonymizedUserStatsXls } from "../services/main-services/user-stats-service.js";
import fs from "fs/promises";
import path from "path";
import {
  findUserById,
  findUserByEmail,
} from "../services/main-services/user-service.js";
import AlumniUser from "../models/AlumniUser.js";
import User from "../models/User.js";
import mongoose from "mongoose";
import { ALUMNI } from "../util/config/defines.js";

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
    user = await findUserById(userId);
  } catch (err) {
    const error = new HttpError("Could not fetch user", 500);
    return next(error);
  }

  if (!user) {
    const error = new HttpError("User not found", 404);
    return next(error);
  }

  user = user.toObject({ getters: true });

  delete user.password;
  user.registrationKey && delete user.registrationKey;
  !withTickets && delete user.tickets;
  !withChristmas && delete user.christmas;

  if (user.status !== USER_STATUSES[ACTIVE]) {
    return res.status(200).json({
      status: user.status,
      user: {
        id: user._id,
        status: user.status,
        subscription: user.subscription,
      },
    });
  }

  if (isBirthdayToday(user.birth)) {
    return res.status(200).json({ status: user.status, user, celebrate: true });
  }

  return res.status(200).json({ status: user.status, user });
};

export const getCurrentUserSubscriptionStatus = async (req, res, next) => {
  const { userId } = extractUserFromRequest(req);

  let user;
  try {
    user = await findUserById(userId);
  } catch (err) {
    const error = new HttpError("Could not fetch user", 500);
    return next(error);
  }

  if (!user) {
    const error = new HttpError("Could not fetch user", 500);
    return next(error);
  }

  user = user.toObject({ getters: true });

  const isAlumni = user?.tier !== undefined;
  const alumniData = isAlumni
    ? {
        tier: user.tier,
      }
    : {};

  const isSubscribed = !!(
    user.subscription &&
    user.subscription.id &&
    user.subscription.customerId
  );

  return res.status(200).json({
    isSubscribed,
    isAlumni,
    ...alumniData,
    status: user.status,
  });
};

export const getCurrentUserRoles = async (req, res, next) => {
  const { userId } = extractUserFromRequest(req);

  let user;
  try {
    user = await findUserById(userId);
  } catch (err) {
    const error = new HttpError("Could not fetch user", 500);
    return next(error);
  }

  if (!user) {
    const error = new HttpError("User not found", 404);
    return next(error);
  }

  user = user.toObject({ getters: true });

  res.status(201).json({ status: user.status, roles: user.roles });
};

export const postActiveMember = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(
      new HttpError("Имате невалидни данни или неселектирани полета", 422)
    );
  }

  const { positions, date, email, phone, questions } = req.body;

  const timestamp = new Date();

  const newActiveMember = new ActiveMembers({
    timestamp,
    positions,
    date,
    email,
    phone,
    cv: req.files["cv"] ? req.files["cv"][0].location : null,
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
    const error = new HttpError(
      "Грешка при записването, моля опитайте пак",
      500
    );
    return next(error);
  }

  activeMembersToSpreadsheet();

  res.status(201).json({ message: "Done" });
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
    user = await findUserById(userId);
  } catch (err) {
    return next(
      new HttpError("Could not find the current user, please try again", 500)
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
      return next(
        new HttpError("Updating user failed, please try again!", 500)
      );
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
    return next(new HttpError("Something went wrong, please try again", 500));
  }

  usersToSpreadsheet(user.region);
  usersToSpreadsheet();

  res.status(200).json({ status: true });
};

export const submitCalendarVerification = async (req, res, next) => {
  const { userId } = extractUserFromRequest(req);

  let user;
  let calendarImage;

  try {
    user = await findUserById(userId);
  } catch (err) {
    return next(
      new HttpError("Could not find the current user, please try again", 500)
    );
  }

  if (req.file) {
    calendarImage = req.file.location;
  } else {
    return next(new HttpError("Please provide an image!", 500));
  }

  user.mmmCampaign2025.calendarImage = calendarImage;

  try {
    await user.save();
  } catch (err) {
    return next(new HttpError("Something went wrong, please try again", 500));
  }

  res.status(200).json({ status: true });
};

export const exportVitalStatsXls = async (req, res, next) => {
  try {
    const { region } = req.query;
    const filter = region ? { region } : {};

    const { buffer, filename, mime } = await generateAnonymizedUserStatsXls(
      filter
    );

    // Save report to local 'reports' folder
    if (process.env.APP_ENV !== "prod") {
      const reportsDir = path.resolve(process.cwd(), "reports");
      await fs.mkdir(reportsDir, { recursive: true });
      const filePath = path.join(reportsDir, filename);
      await fs.writeFile(filePath, buffer);
    }

    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(buffer);
  } catch (err) {
    console.log(err);
    return next(new HttpError("Failed to generate statistics", 500));
  }
};

/**
 * Creates or updates an alumni user record based on a regular user
 * POST /api/user/convert-to-alumni
 * @param {string} email - Email of the user to convert
 * @returns {object} - Information about the created/updated alumni user
 */
export const convertUserToAlumni = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new HttpError("Invalid inputs passed", 422));
  }

  const { userId } = extractUserFromRequest(req);

  // Find the regular user
  let regularUser;
  try {
    regularUser = await User.findOne({ _id: userId });

    if (!regularUser) {
      return next(new HttpError("User not found with provided email", 404));
    }
  } catch (err) {
    console.error(err);
    return next(new HttpError("Error finding user", 500));
  }

  // Extract the ObjectId part if the user already has a prefixed ID
  let objectIdPart;
  if (
    typeof regularUser._id === "string" &&
    regularUser._id.includes("member_")
  ) {
    const idMatch = regularUser._id.match(/member_(.*)/);
    if (idMatch && idMatch[1]) {
      objectIdPart = idMatch[1];
    } else {
      return next(new HttpError("User ID format is invalid", 400));
    }
  } else {
    // If the user has a regular ObjectId, convert it to string
    objectIdPart = regularUser._id.toString();
  }

  // Create the alumni ID with the same ObjectId part
  const alumniId = `alumni_${objectIdPart}`;

  // Check if an alumni user already exists with this ID or email
  let existingAlumni;
  try {
    existingAlumni = await AlumniUser.findOne({
      $or: [{ _id: alumniId }, { email: regularUser.email }],
    });
  } catch (err) {
    console.error(err);
    return next(new HttpError("Error checking for existing alumni user", 500));
  }

  let result;

  try {
    if (existingAlumni) {
      // Update existing alumni user with data from regular user
      existingAlumni.name = regularUser.name;
      existingAlumni.surname = regularUser.surname;
      existingAlumni.email = regularUser.email;
      existingAlumni.image = regularUser.image;
      existingAlumni.password = regularUser.password;
      existingAlumni.status = regularUser.status || "active";
      existingAlumni.purchaseDate = regularUser.purchaseDate || new Date();
      existingAlumni.expireDate =
        regularUser.expireDate ||
        new Date(new Date().setFullYear(new Date().getFullYear() + 1));

      // Make sure the alumni role is set
      if (!existingAlumni.roles.includes(ALUMNI)) {
        existingAlumni.roles.push(ALUMNI);
      }

      await existingAlumni.save();
      result = {
        action: "updated",
        alumniId: existingAlumni._id,
        userId: regularUser._id,
        email: regularUser.email,
      };
    } else {
      // Create new alumni user with data from regular user
      const newAlumniUser = new AlumniUser({
        _id: alumniId,
        name: regularUser.name,
        surname: regularUser.surname,
        email: regularUser.email,
        password: regularUser.password,
        image: regularUser.image || "",
        status: regularUser.status || "active",
        tier: 0, // Default tier
        roles: [ALUMNI],
        purchaseDate: regularUser.purchaseDate || new Date(),
        expireDate:
          regularUser.expireDate ||
          new Date(new Date().setFullYear(new Date().getFullYear() + 1)),
        tickets: regularUser.tickets || [],
        christmas: regularUser.christmas || [],
      });

      await newAlumniUser.save();
      result = {
        action: "created",
        alumniId: newAlumniUser._id,
        userId: regularUser._id,
        email: regularUser.email,
      };
    }

    regularUser.status = USER_STATUSES[ALUMNI_MIGRATED];
    await regularUser.save();

    return res.status(200).json({
      message: `User successfully ${result.action} as alumni`,
      result,
    });
  } catch (err) {
    console.error(err);
    return next(new HttpError("Error converting user to alumni", 500));
  }
};

/**
 * Retrieves a list of active alumni members with limited fields
 * GET /api/user/active-alumni
 * @returns {array} - Array of active alumni users with selected fields
 */
export const getActiveAlumniMembers = async (req, res, next) => {
  try {
    // Find all alumni users with 'active' status
    const alumniMembers = await AlumniUser.find()
      .select("name surname image tier quote joinDate")
      .sort({ name: 1, surname: 1 }); // Sort by name and surname alphabetically

    // Format the response to include only the required fields
    const formattedMembers = alumniMembers.map((member) => {
      const memberObj = member.toObject({ getters: true });

      // Create a clean object with only the fields we need
      return {
        id: memberObj.id || memberObj._id,
        name: memberObj.name,
        surname: memberObj.surname,
        image: memberObj.image,
        tier: memberObj.tier,
        joinDate: memberObj.joinDate,
        // Include quote only if it exists
        ...(memberObj.quote && { quote: memberObj.quote }),
      };
    });

    return res.status(200).json({
      count: formattedMembers.length,
      alumniMembers: formattedMembers,
    });
  } catch (err) {
    console.error(err);
    return next(new HttpError("Error fetching alumni members", 500));
  }
};

/**
 * Updates an alumni user's quote
 * PATCH /api/user/alumni-quote
 * @param {string} quote - The new quote text
 * @returns {object} - Success message and updated quote
 */
export const updateAlumniQuote = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new HttpError("Invalid inputs passed", 422));
  }

  const { userId } = extractUserFromRequest(req);
  const { quote } = req.body;

  // Find the alumni user
  let alumniUser;
  try {
    alumniUser = await AlumniUser.findOne({ _id: userId });

    if (!alumniUser) {
      return next(new HttpError("Alumni user not found", 404));
    }
  } catch (err) {
    console.error(err);
    return next(new HttpError("Error finding alumni user", 500));
  }

  // Update the quote
  try {
    alumniUser.quote = quote;
    await alumniUser.save();

    return res.status(200).json({
      status: true,
      quote: alumniUser.quote,
    });
  } catch (err) {
    console.error(err);
    return next(new HttpError("Error updating quote", 500));
  }
};

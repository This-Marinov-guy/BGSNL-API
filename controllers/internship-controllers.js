import { validationResult } from "express-validator";
import HttpError from "../models/Http-error.js";
import InternshipApplication from "../models/InternshipApplication.js";
import Internship from "../models/Internship.js";
import Document from "../models/Document.js";
import { extractUserFromRequest } from "../util/functions/security.js";
import { internshipApplicationsToSpreadsheet } from "../services/background-services/google-spreadsheets.js";
import { findUserById } from "../services/main-services/user-service.js";
import mongoose from "mongoose";
import { DOCUMENT_TYPES } from "../util/config/enums.js";

export const getInternshipsList = async (req, res, next) => {
  try {
    const internships = await Internship.find({ isActive: true }).sort({ createdAt: -1 });
    return res.status(200).json({ status: true, internships });
  } catch (err) {
    return next(new HttpError("Failed to fetch internships", 500));
  }
};

export const getAllInternshipsAdmin = async (req, res, next) => {
  try {
    const internships = await Internship.find().sort({ createdAt: -1 });
    return res.status(200).json({ status: true, internships });
  } catch (err) {
    return next(new HttpError("Failed to fetch internships", 500));
  }
};

export const addInternship = async (req, res, next) => {
  const {
    company, specialty, location, label, duration, description,
    bonuses, requirements, languages, contactMail, website, applyLink,
  } = req.body;

  if (!company || !specialty || !location || !label) {
    return next(new HttpError("company, specialty, location and label are required", 422));
  }

  const logo = req.file
    ? (req.file.location || req.file.Location || "")
    : (req.body.existingLogoUrl || "");

  const internship = new Internship({
    company, specialty, location, label, duration, description,
    bonuses, requirements, languages, contactMail, website, applyLink, logo,
  });

  try {
    await internship.save();
    return res.status(201).json({ status: true, internship });
  } catch (err) {
    console.log(err);
    return next(new HttpError("Failed to create internship", 500));
  }
};

export const editInternship = async (req, res, next) => {
  const { id } = req.params;

  const updates = { ...req.body, updatedAt: new Date() };
  delete updates.existingLogoUrl;

  if (req.file) {
    updates.logo = req.file.location || req.file.Location || "";
  } else if (req.body.existingLogoUrl) {
    updates.logo = req.body.existingLogoUrl;
  }

  try {
    const internship = await Internship.findByIdAndUpdate(id, updates, { new: true, runValidators: true });
    if (!internship) {
      return next(new HttpError("Internship not found", 404));
    }
    return res.status(200).json({ status: true, internship });
  } catch (err) {
    console.log(err);
    return next(new HttpError("Failed to update internship", 500));
  }
};

export const deleteInternship = async (req, res, next) => {
  const { id } = req.params;

  try {
    const internship = await Internship.findByIdAndDelete(id);
    if (!internship) {
      return next(new HttpError("Internship not found", 404));
    }
    return res.status(200).json({ status: true, message: "Internship deleted successfully" });
  } catch (err) {
    console.log(err);
    return next(new HttpError("Failed to delete internship", 500));
  }
};

export const postMemberApply = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new HttpError("Invalid inputs passed", 422));
  }

  const { companyId, companyName, position, internshipId } = req.body;
  const { userId } = extractUserFromRequest(req);

  let user;
  try {
    user = await findUserById(userId);
  } catch (err) {
    const error = new HttpError("Could not find user", 500);
    return next(error);
  }

  if (!user) {
    const error = new HttpError("User not found", 404);
    return next(error);
  }

  // Populate documents if user has documents
  if (user.documents && user.documents.length > 0) {
    await user.populate('documents');
  }

  // Get the most recent CV
  const cvDocuments = user.documents
    .filter((document) => document.type === DOCUMENT_TYPES.CV)
    .sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated));

  const cv = cvDocuments.length > 0 ? cvDocuments[0].content : null;

  // Handle cover letter file upload if provided
  let coverLetter = null;
  let coverLetterDocument = null;

  if (req.files && req.files["coverLetter"] && req.files["coverLetter"][0]) {
    const coverLetterFile = req.files["coverLetter"][0];
    const coverLetterLocation =
      coverLetterFile.location || coverLetterFile.Location;
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, -5);
    const coverLetterName =
      user.name +
      " " +
      user.surname +
      " - " +
      timestamp +
      " - " +
      coverLetterFile.originalname;

    coverLetterDocument = new Document({
      type: DOCUMENT_TYPES.COVER_LETTER,
      name: coverLetterName,
      content: coverLetterLocation,
    });
    coverLetter = coverLetterLocation;
  }

  const applicationData = {
    userId,
    email: user.email,
    name: user.name + " " + user.surname,
    phone: user.phone || null,
    companyId,
    companyName,
    position,
    cv,
    coverLetter,
  };

  if (internshipId) {
    applicationData.internshipId = internshipId;
  }

  const internshipApplication = new InternshipApplication(applicationData);

  try {
    const sess = await mongoose.startSession();
    sess.startTransaction();

    try {
      await internshipApplication.save({ session: sess });

      // Save cover letter document if provided and add to user's documents
      if (coverLetterDocument) {
        await coverLetterDocument.save({ session: sess });

        if (!user.documents) {
          user.documents = [];
        }
        user.documents.push(coverLetterDocument._id);
      }

      if (!user.internshipApplications) {
        user.internshipApplications = [];
      }
      user.internshipApplications.push(internshipApplication._id);
      await user.save({ session: sess });

      await sess.commitTransaction();

      // Update Google Spreadsheet in background (outside transaction)
      internshipApplicationsToSpreadsheet();
    } catch (err) {
      await sess.abortTransaction();
      throw err;
    } finally {
      sess.endSession();
    }
  } catch (err) {
    console.log(err);
    const error = new HttpError("Failed to submit internship application", 500);
    return next(error);
  }

  return res.status(201).json({
    status: true,
    message: "Internship application submitted successfully",
  });
};

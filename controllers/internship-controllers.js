import { validationResult } from "express-validator";
import HttpError from "../models/Http-error.js";
import InternshipApplication from "../models/InternshipApplication.js";
import { extractUserFromRequest } from "../util/functions/security.js";
import { internshipApplicationsToSpreadsheet } from "../services/background-services/google-spreadsheets.js";

export const postMemberApply = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new HttpError("Invalid inputs passed", 422));
  }

  const { email, name, phone, companyId, companyName, position } = req.body;
  const { userId } = extractUserFromRequest(req);

  // Get file locations if uploaded
  const cvLocation = req.files && req.files["cv"] && req.files["cv"][0] 
    ? req.files["cv"][0].location || req.files["cv"][0].Location 
    : null;
  
  const coverLetterLocation = req.files && req.files["coverLetter"] && req.files["coverLetter"][0]
    ? req.files["coverLetter"][0].location || req.files["coverLetter"][0].Location
    : null;

  const internshipApplication = new InternshipApplication({
    userId: userId || null,
    email,
    name,
    phone,
    companyId,
    companyName,
    position,
    cv: cvLocation,
    coverLetter: coverLetterLocation,
  });

  try {
    await internshipApplication.save();
    
    // Update Google Spreadsheet in background
    internshipApplicationsToSpreadsheet();
  } catch (err) {
    console.log(err);
    const error = new HttpError("Failed to submit internship application", 500);
    return next(error);
  }

  return res.status(201).json({ 
    status: true, 
    message: "Internship application submitted successfully" 
  });
};

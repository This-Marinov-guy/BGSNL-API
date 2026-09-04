import express from "express";
import {
  getInternshipsList,
  getAllInternshipsAdmin,
  addInternship,
  editInternship,
  deleteInternship,
  reorderInternships,
  postMemberApply,
} from "../controllers/internship-controllers.js";
import { authMiddleware, adminMiddleware } from "../middleware/authorization.js";
import multiFileUpload from "../middleware/multiple-file-upload.js";
import logoUpload from "../middleware/logo-upload.js";
import { ACCESS_1 } from "../util/config/defines.js";
import dotenv from "dotenv";
import { validateRequest } from "../middleware/validate-request.js";
import {
  addInternshipValidators,
  deleteInternshipValidators,
  editInternshipValidators,
  internshipApplicationValidators,
  reorderInternshipsValidators,
} from "../validation/form-validators.js";
dotenv.config();

const internshipRouter = express.Router();

// Public list
internshipRouter.get("/list", getInternshipsList);

// Admin: full list including inactive
internshipRouter.get("/admin-list", adminMiddleware(ACCESS_1), getAllInternshipsAdmin);

// Admin CRUD
internshipRouter.post(
  "/add",
  adminMiddleware(ACCESS_1),
  logoUpload(process.env.BUCKET_DOCUMENTS).single("logo"),
  addInternshipValidators,
  validateRequest,
  addInternship
);

internshipRouter.patch(
  "/edit/:id",
  adminMiddleware(ACCESS_1),
  logoUpload(process.env.BUCKET_DOCUMENTS).single("logo"),
  editInternshipValidators,
  validateRequest,
  editInternship
);

internshipRouter.patch(
  "/reorder",
  adminMiddleware(ACCESS_1),
  reorderInternshipsValidators,
  validateRequest,
  reorderInternships
);

internshipRouter.delete(
  "/delete/:id",
  adminMiddleware(ACCESS_1),
  deleteInternshipValidators,
  validateRequest,
  deleteInternship
);

// Member apply
internshipRouter.post(
  "/member-apply",
  authMiddleware,
  multiFileUpload(process.env.BUCKET_DOCUMENTS).fields([
    { name: "coverLetter", maxCount: 1 },
  ]),
  internshipApplicationValidators,
  validateRequest,
  postMemberApply
);

export default internshipRouter;

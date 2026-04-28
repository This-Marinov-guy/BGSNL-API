import express from "express";
import { check } from "express-validator";
import {
  getInternshipsList,
  getAllInternshipsAdmin,
  addInternship,
  editInternship,
  deleteInternship,
  postMemberApply,
} from "../controllers/internship-controllers.js";
import { authMiddleware, adminMiddleware } from "../middleware/authorization.js";
import multiFileUpload from "../middleware/multiple-file-upload.js";
import logoUpload from "../middleware/logo-upload.js";
import { ACCESS_1 } from "../util/config/defines.js";
import dotenv from "dotenv";
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
  addInternship
);

internshipRouter.patch(
  "/edit/:id",
  adminMiddleware(ACCESS_1),
  logoUpload(process.env.BUCKET_DOCUMENTS).single("logo"),
  editInternship
);

internshipRouter.delete("/delete/:id", adminMiddleware(ACCESS_1), deleteInternship);

// Member apply
internshipRouter.post(
  "/member-apply",
  authMiddleware,
  multiFileUpload(process.env.BUCKET_DOCUMENTS).fields([
    { name: "coverLetter", maxCount: 1 },
  ]),
  [
    check("companyId").notEmpty().withMessage("Company ID is required"),
    check("companyName").notEmpty().withMessage("Company name is required"),
    check("position").notEmpty().withMessage("Position is required"),
  ],
  postMemberApply
);

export default internshipRouter;

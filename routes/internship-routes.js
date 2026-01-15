import express from "express";
import { check } from "express-validator";
import { postMemberApply } from "../controllers/internship-controllers.js";
import { authMiddleware } from "../middleware/authorization.js";
import multiFileUpload from "../middleware/multiple-file-upload.js";
import dotenv from "dotenv";
dotenv.config();

const internshipRouter = express.Router();

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

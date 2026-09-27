import express from "express";
import dotenv from "dotenv";
import {
  acceptMarketingEmail,
  getAboutUsData,
  getActiveMemberCount,
  getMemberCount,
  getTotalMemberCount,
  validateContactForm,
} from "../controllers/common-controllers.js";
import { validateRequest } from "../middleware/validate-request.js";
import {
  contactFormValidators,
  marketingEmailValidators,
} from "../validation/form-validators.js";
dotenv.config();

const commonRouter = express.Router();

commonRouter.get("/get-total-member-count", getTotalMemberCount);

commonRouter.get("/get-member-count", getMemberCount);

commonRouter.get("/get-active-member-count", getActiveMemberCount);

commonRouter.get("/get-about-data", getAboutUsData);

commonRouter.post(
  "/marketing-email",
  marketingEmailValidators,
  validateRequest,
  acceptMarketingEmail
);

commonRouter.post(
  "/contact/validate",
  contactFormValidators,
  validateRequest,
  validateContactForm
);

export default commonRouter;

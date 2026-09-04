import express from "express";
import dotenv from "dotenv";
import { postAddParticipant } from "../controllers/contest-controllers.js";
import { validateRequest } from "../middleware/validate-request.js";
import { contestRegistrationValidators } from "../validation/form-validators.js";
dotenv.config();

const contestRouter = express.Router();

contestRouter.post(
  "/register",
  contestRegistrationValidators,
  validateRequest,
  postAddParticipant
);


export default contestRouter;

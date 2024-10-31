import express from "express";
import dotenv from "dotenv";
import { getAboutUsData, getActiveMemberCount, getMemberCount, getTotalMemberCount } from "../controllers/common-controllers.js";
dotenv.config();

const commonRouter = express.Router();

commonRouter.get("/get-total-member-count", getTotalMemberCount);

commonRouter.get("/get-member-count", getMemberCount);

commonRouter.get("/get-active-member-count", getActiveMemberCount);

commonRouter.get("/get-about-data", getAboutUsData);

export default commonRouter;

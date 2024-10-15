import express from "express";
import dotenv from "dotenv";
import { getActiveMemberCount, getMemberCount, getTotalMemberCount } from "../controllers/common-controllers.js";
dotenv.config();

const commonRouter = express.Router();

commonRouter.get("/get-total-member-count", getTotalMemberCount);

commonRouter.get("/get-member-count", getMemberCount);

commonRouter.get("/get-active-member-count", getActiveMemberCount);

export default commonRouter;

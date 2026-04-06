import express from "express";
import { getMembers, getEventsAnalytics } from "../controllers/dashboard-controllers.js";
import { adminMiddleware } from "../middleware/authorization.js";
import { ACCESS_2, BOARD_MEMBER, COMMITTEE_MEMBER } from "../util/config/defines.js";

const dashboardRouter = express.Router();

// Board + committee + admins (matches frontend ACCESS_3)
const DASHBOARD_ACCESS = [...ACCESS_2, BOARD_MEMBER, COMMITTEE_MEMBER];

dashboardRouter.get("/members", adminMiddleware(DASHBOARD_ACCESS), getMembers);
dashboardRouter.get("/events-analytics", adminMiddleware(DASHBOARD_ACCESS), getEventsAnalytics);

export default dashboardRouter;

import express from "express";
import { getMembers, getEventsAnalytics } from "../controllers/dashboard-controllers.js";
import { adminMiddleware } from "../middleware/authorization.js";
import { ALL_MEMBER_REGIONS_ACCESS, BOARD_MEMBER, COMMITTEE_MEMBER } from "../util/config/defines.js";
import { monthlySummaryControllers } from "../controllers/monthly-summary-controller.js";

const dashboardRouter = express.Router();

dashboardRouter.get("/monthly-summary/:month", adminMiddleware(ALL_MEMBER_REGIONS_ACCESS), monthlySummaryControllers.get);
dashboardRouter.patch("/monthly-summary/:month", adminMiddleware(ALL_MEMBER_REGIONS_ACCESS), monthlySummaryControllers.save);

// Board + committee + admins (matches frontend ACCESS_3)
const DASHBOARD_ACCESS = [...ALL_MEMBER_REGIONS_ACCESS, BOARD_MEMBER, COMMITTEE_MEMBER, "board_member", "committee_member"];

dashboardRouter.get("/members", adminMiddleware(DASHBOARD_ACCESS), getMembers);
dashboardRouter.get("/events-analytics", adminMiddleware(DASHBOARD_ACCESS), getEventsAnalytics);

export default dashboardRouter;

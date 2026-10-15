import express from "express";
import { getMembers, getEventsAnalytics, getMemberStatistics, getEventStatistics } from "../controllers/dashboard-controllers.js";
import { adminMiddleware } from "../middleware/authorization.js";
import { ALL_MEMBER_REGIONS_ACCESS, BOARD_MEMBER, COMMITTEE_MEMBER, DASHBOARD_ACCESS } from "../util/config/defines.js";
import { monthlySummaryControllers } from "../controllers/monthly-summary-controller.js";

const dashboardRouter = express.Router();

dashboardRouter.get("/monthly-summary/:month", adminMiddleware(ALL_MEMBER_REGIONS_ACCESS), monthlySummaryControllers.get);

// Board + committee + admins (matches frontend ACCESS_3)
const MANAGEMENT_STATISTICS_ACCESS = [...ALL_MEMBER_REGIONS_ACCESS, BOARD_MEMBER, COMMITTEE_MEMBER, "board_member", "committee_member"];

dashboardRouter.get("/members", adminMiddleware(MANAGEMENT_STATISTICS_ACCESS), getMembers);
dashboardRouter.get("/events-analytics", adminMiddleware(MANAGEMENT_STATISTICS_ACCESS), getEventsAnalytics);
dashboardRouter.get("/member-statistics", adminMiddleware(DASHBOARD_ACCESS), getMemberStatistics);
dashboardRouter.get("/event-statistics", adminMiddleware(DASHBOARD_ACCESS), getEventStatistics);

export default dashboardRouter;

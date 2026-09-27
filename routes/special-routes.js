import express from "express";
import { postCard } from "../controllers/special-controller.js";
import { validateRequest } from "../middleware/validate-request.js";
import { christmasCardValidators } from "../validation/form-validators.js";

const specialEventsRouter = express.Router();

specialEventsRouter.post(
  "/add-card",
  christmasCardValidators,
  validateRequest,
  postCard
);

export default specialEventsRouter;

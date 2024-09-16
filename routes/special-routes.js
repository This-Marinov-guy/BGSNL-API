import express from "express";
import { check } from "express-validator";
import { postCard } from "../controllers/special-controller.js";

const specialEventsRouter = express.Router();

specialEventsRouter.post("/add-card", postCard)

export default specialEventsRouter
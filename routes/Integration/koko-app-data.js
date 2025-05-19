import express from "express";
import dotenv from "dotenv";
import { passSecured } from "../../middleware/pass-secure.js";
import { getCityData } from "../../controllers/Integration/koko-app-data-controllers.js";
dotenv.config();

const kokoAppRouter = express.Router();

kokoAppRouter.get("/:city", passSecured, getCityData);

export default kokoAppRouter;

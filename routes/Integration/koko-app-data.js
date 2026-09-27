import express from "express";
import dotenv from "dotenv";
import { requireServiceKey } from "../../middleware/pass-secure.js";
import { getCityData } from "../../controllers/Integration/koko-app-data-controllers.js";
dotenv.config();

const kokoAppRouter = express.Router();

kokoAppRouter.get("/:city", requireServiceKey("KOKO_APP_PASS"), getCityData);

export default kokoAppRouter;

import express from "express";
import dotenv from "dotenv";
import { readDatabaseCollection } from "../../controllers/Integration/google-scripts-controllers.js";
import { requireServiceKey } from "../../middleware/pass-secure.js";
dotenv.config();

const googleScriptsRouter = express.Router();

googleScriptsRouter.get("/collections/:collection", requireServiceKey("GOOGLE_SCRIPTS_PASS"), readDatabaseCollection);

export default googleScriptsRouter;

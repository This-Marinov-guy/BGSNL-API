import express from "express";
import dotenv from "dotenv";
import { readDatabaseCollection } from "../../controllers/Integration/google-scripts-controllers.js";
import { passSecured } from "../../middleware/pass-secure.js";
dotenv.config();

const googleScriptsRouter = express.Router();

googleScriptsRouter.get("/collections/:collection", passSecured ,readDatabaseCollection);

export default googleScriptsRouter;

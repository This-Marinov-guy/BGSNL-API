import express from "express";
import { eventToSpreadsheet } from "../controllers/database-controllers.js";
import { searchInDatabase } from "../controllers/database-controllers.js";


const databaseRouter = express.Router();

databaseRouter.get("/:sheetName/:eventName", eventToSpreadsheet);

databaseRouter.get("/:eventName", searchInDatabase);

export default databaseRouter;
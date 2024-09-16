import express from "express";
import { check } from "express-validator";
import dotenv from "dotenv";
dotenv.config();

const commonRouter = express.Router();

export default commonRouter;

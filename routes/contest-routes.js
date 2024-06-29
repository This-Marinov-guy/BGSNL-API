import express from "express";
import { check } from "express-validator";
import dotenv from "dotenv";
import { postAddParticipant } from "../controllers/contest-controllers.js";
dotenv.config();

const contestRouter = express.Router();

contestRouter.post(
    "/register",
    [check("name").notEmpty(),
    check("surname").notEmpty(),
    check("email").notEmpty()
    ],
    postAddParticipant
);


export default contestRouter;

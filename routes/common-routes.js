import express from "express";
import { check } from "express-validator";
import dotenv from "dotenv";
dotenv.config();

const commonRouter = express.Router();

commonRouter.post(
    "/register",
    [check("name").notEmpty(),
    check("surname").notEmpty(),
    check("email").notEmpty()
    ],
    postAddParticipant
);


export default commonRouter;

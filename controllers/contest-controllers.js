import mongoose from "mongoose";
import { validationResult } from "express-validator";
import HttpError from "../models/Http-error.js";
import Contest from "../models/Contest.js";
import { sendContestMaterials } from "../services/side-services/email-transporter.js";

export const postAddParticipant = async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return next(new HttpError("Invalid inputs passed", 422));
    }
    const { contestName, name, surname, email, comments } = req.body;

    let contest;
    try {
        contest = await Contest.findOneOrCreate(
            { contestName: contestName },
            { contestName, registered: [] }
        );
    } catch (err) {
        return next(
            new HttpError("Could not add you to the contest, please try again!", 500)
        );
    }

    if (!contest) {
        return next(new HttpError("Could not find such contest", 404));
    }

    let participant = {
        timestamp: new Date().toString(),
        name,
        surname,
        email,
        comments
    };

    try {
        const sess = await mongoose.startSession();
        sess.startTransaction();
        contest.registered.push(participant);
        await contest.save();
        await sess.commitTransaction();
    } catch (err) {
        console.log(err);
        return next(
            new HttpError("Adding guest to the event failed, please try again", 500)
        );
    }

    sendContestMaterials(email);

    res.status(201).json({ message: "Success" });
};

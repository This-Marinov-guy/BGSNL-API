import mongoose from "mongoose";
import Event from "../models/Event.js";
import NonSocietyEvent from "../models/NonSocietyEvent.js";
import User from "../models/User.js";
import { validationResult } from "express-validator";
import HttpError from "../models/Http-error.js";
import { sendTicketEmail } from "../middleware/email-transporter.js";
import moment from 'moment'
import { eventToSpreadsheet } from "../util/searchInDatabase.js";
import uploadToCloudinary from "../util/cloudinary.js";

const addEvent = async (req, res, next) => {
    try {
        const response = await uploadToCloudinary(req.files['thumbnail'][0]);

        res.status(201).json({ message: response });
    } catch (err) {
        console.log(err);
        res.status(201).json({ message: 'done' });
    }

}

export { addEvent }
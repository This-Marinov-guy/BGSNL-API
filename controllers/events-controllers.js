import mongoose from "mongoose";
import Event from "../models/Event.js";
import NonSocietyEvent from "../models/NonSocietyEvent.js";
import User from "../models/User.js";
import { validationResult } from "express-validator";
import HttpError from "../models/Http-error.js";
import { sendTicketEmail } from "../middleware/email-transporter.js";
import moment from 'moment'
import { eventToSpreadsheet } from "../util/searchInDatabase.js";

const postSoldTicketQuantity = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new HttpError("Invalid inputs passed", 422));
  }

  try {
    const { eventName, region, date } = req.body
    const event = await Event.findOne({ eventName, region, date });

    let ticketsSold;

    if (event) {
      ticketsSold = event.guestList.length;
    } else {
      ticketsSold = 0;
    }
    res.status(201).json({ ticketsSold: ticketsSold });

  } catch (error) {
    new HttpError("Something got wrong, please contact support", 500);
  }

}

const postAddMemberToEvent = async (req, res, next) => {
  const { eventName, region, eventDate, userId, preferences } = req.body;
  let societyEvent;
  try {
    societyEvent = await Event.findOneOrCreate(
      { event: eventName, region, date: eventDate },
      { status: 'open', event: eventName, region, date: eventDate, guestList: [] }
    );
  } catch (err) {
    return next(
      new HttpError("Could not add you to the event, please try again!", 500)
    );
  }

  if (!societyEvent) {
    return next(new HttpError("Could not find such event", 404));
  }

  let targetUser;
  try {
    targetUser = await User.findById(userId);
  } catch (err) {
    new HttpError("Could not find a user with provided id", 404);
  }
  try {
    const sess = await mongoose.startSession();
    sess.startTransaction();
    societyEvent.guestList.push({
      type: "member",
      timestamp: moment(new Date()).format("D MMM YYYY"),
      name: targetUser.name + " " + targetUser.surname,
      email: targetUser.email,
      phone: targetUser.phone,
      preferences,
      ticket: req.file.location,
    });
    targetUser.tickets.push({
      event: eventName,
      purchaseDate: moment(new Date()).format("D MMM YYYY"),
      image: req.file.location,
    });
    await societyEvent.save();
    await targetUser.save();
    await sess.commitTransaction();
  } catch (err) {
    return next(
      new HttpError("Adding user to the event failed, please try again", 500)
    );
  }

  sendTicketEmail(
    "member",
    targetUser.email,
    eventName,
    eventDate,
    targetUser.name,
    req.file.location
  );

  eventToSpreadsheet(societyEvent.id, eventName, region)

  res.status(201).json({ message: "Success" });
};

const postAddGuestToEvent = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new HttpError("Invalid inputs passed", 422));
  }
  const { eventName, eventDate, region, guestName, guestEmail, guestPhone, preferences, marketing } = req.body;

  let societyEvent;
  try {
    societyEvent = await Event.findOneOrCreate(
      { event: eventName, region, date: eventDate },
      { status: 'open', event: eventName, region, date: eventDate, guestList: [] }
    );
  } catch (err) {
    return next(
      new HttpError("Could not add you to the event, please try again!", 500)
    );
  }

  if (!societyEvent) {
    return next(new HttpError("Could not find such event", 404));
  }

  let guest = {
    type: "guest",
    timestamp: moment(new Date()).format("D MMM YYYY"),
    name: guestName,
    email: guestEmail,
    phone: guestPhone,
    preferences,
    marketing,
    ticket: req.file.location,
  };

  try {
    const sess = await mongoose.startSession();
    sess.startTransaction();
    societyEvent.guestList.push(guest);
    await societyEvent.save();
    await sess.commitTransaction();
  } catch (err) {
    console.log(err);
    return next(
      new HttpError("Adding guest to the event failed, please try again", 500)
    );
  }

  sendTicketEmail(
    "guest",
    guestEmail,
    eventName,
    eventDate,
    guestName,
    req.file.location
  );

  eventToSpreadsheet(societyEvent.id, eventName, region)

  res.status(201).json({ message: "Success" });
};

const postNonSocietyEvent = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new HttpError("Invalid inputs passed", 422));
  }
  const { event, date, user, name, email, phone, notificationTypeTerms } =
    req.body;

  let nonSocietyEvent;
  try {
    nonSocietyEvent = await NonSocietyEvent.findOneOrCreate(
      { event: event },
      { status: 'open', event: event, date: date, guestList: [] }
    );
  } catch (err) {
    return next(
      new HttpError("Could not add you to the event, please try again!", 500)
    );
  }

  if (!nonSocietyEvent) {
    return next(new HttpError("Could not find such event", 404));
  }

  let guest = {
    user,
    timestamp: moment(new Date()).format("D MMM YYYY"),
    name,
    email,
    phone,
    notificationTypeTerms,
  };

  try {
    nonSocietyEvent.guestList.push(guest);
    await nonSocietyEvent.save();
  } catch (err) {
    return next(
      new HttpError("Adding user to the event failed, please try again", 500)
    );
  }

  res.status(201).json({ message: "Success" });
};

export { postAddMemberToEvent, postAddGuestToEvent, postNonSocietyEvent, postSoldTicketQuantity };

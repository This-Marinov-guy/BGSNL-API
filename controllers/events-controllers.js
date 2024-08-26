import mongoose from "mongoose";
import Event from "../models/Event.js";
import NonSocietyEvent from "../models/NonSocietyEvent.js";
import User from "../models/User.js";
import { validationResult } from "express-validator";
import HttpError from "../models/Http-error.js";
import { sendTicketEmail } from "../services/email-transporter.js";
import { eventToSpreadsheet } from "../services/google-spreadsheets.js";
import { decodeFromURL, isEventTimerFinished, removeModelProperties } from "../util/functions/helpers.js";
import { dateConvertor } from "../util/functions/dateConvert.js";

const getEventPurchaseAvailability = async (req, res, next) => {
  try {
    const { eventId } = req.params;

    if (!eventId) {
      return next(new HttpError("Invalid inputs passed", 422));
    }

    const event = await Event.findById(eventId);

    if (!event) {
      return next(new HttpError("No event was found", 404));
    }

    let status = true;
    const ticketsRemaining = event.ticketLimit - event.guestList.length;
    const expired = dateConvertor(event.date, event.time, true) < new Date().toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" }) || isEventTimerFinished(event.ticketTimer);

    if (ticketsRemaining <= 0 || expired) {
      status = false;
    }

    res.status(200).json({ status });

  } catch (error) {
    return next(new HttpError("Something got wrong, please contact support", 500));
  }
}

const getEventById = async (req, res, next) => {
  const eventId = req.params.eventId;

  if (eventId === undefined || !eventId) {
    return next(new HttpError("No event was found", 404));
  }

  try {
    let event = await Event.findById(eventId);

    if (!event) {
      return next(new HttpError("No event was found", 404));
    }

    let status = true;

    const ticketsRemaining = event.ticketLimit - event.guestList.length;
    const expired = dateConvertor(event.date, event.time, true) < new Date().toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" }) || isEventTimerFinished(event.ticketTimer);

    if (ticketsRemaining <= 0 || expired) {
      status = false;
    }

    event = removeModelProperties(event, ['guestList', 'discountPass', 'freePass']);

    res.status(200).json({ event, status });

  } catch (err) {
    console.log(err);
    return next(new HttpError("Fetching event failed", 500));
  }
}

const getEvent = async (req, res, next) => {
  try {
    const eventName = decodeFromURL(req.params.eventName);
    const region = req.params.region;
    const today = new Date().toISOString();

    if (!(eventName && region)) {
      return next(new HttpError("Invalid inputs passed", 422));
    }

    let event = await Event.findOne({
      title: eventName,
      region: region,
      date: { $gte: today }
    });

    if (!event) {
      return next(new HttpError("No event was found", 404));
    }

    let status = true;

    const ticketsRemaining = event.ticketLimit - event.guestList.length;
    const expired = dateConvertor(event.date, event.time, true) < new Date().toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam" }) || isEventTimerFinished(event.ticketTimer);

    if (ticketsRemaining <= 0 || expired) {
      status = false;
    }

    event = removeModelProperties(event, ['guestList', 'discountPass', 'freePass']);

    res.status(200).json({ event, status });

  } catch (error) {
    return next(new HttpError("Something got wrong, please contact support", 500));
  }
}

const getSoldTicketQuantity = async (req, res, next) => {
  try {
    const { eventId } = req.params;

    if (!eventId) {
      return next(new HttpError("Invalid inputs passed", 422));
    }

    const event = await Event.findById(eventId);

    let ticketsSold;

    if (event) {
      ticketsSold = event.guestList.length;
    } else {
      ticketsSold = 0;
    }
    res.status(200).json({ ticketsSold: ticketsSold });

  } catch (error) {
    return next(new HttpError("Something got wrong, please contact support", 500));
  }

}

const checkEligibleMemberForPurchase = async (req, res, next) => {
  const { userId, eventId } = req.params;
  let status = true;

  if (!eventId) {
    return next(new HttpError("Invalid inputs passed", 422));
  }

  let event = await Event.findById(eventId);

  if (!event) {
    return next(new HttpError("No event was found", 404));
  }

  let member = await User.findById(userId);

  if (!member) {
    return next(new HttpError("Could not find a user with provided id", 404));
  }

  const memberName = `${member.name} ${member.surname}`;

  for (const guest of event.guestList) {
    if (guest.name === memberName && guest.email === member.email) {
      status = false;
      break;
    }
  }

  res.status(200).json({ status });
}

const checkEligibleGuestForDiscount = async (req, res, next) => {
  const { email, name, surname, eventId } = req.params;
  const {withError} = req.query;
  const guestName = `${name} ${surname}`;
  let status = true;

  if (!eventId) {
    return next(new HttpError("Invalid inputs passed", 422));
  }

  let event = await Event.findById(eventId);

  if (!event) {
    return next(new HttpError("No event was found", 404));
  }

  if (!event.freePass || !event.freePass.includes(guestName) || !event.freePass.includes(email)) {
      return res.status(200).json({ status });
  }

  for (const guest of event.guestList) {
    if (guest.name === guestName || guest.email === email) {
      status = false;
      break;
    }
  }

  res.status(200).json({ status });
}

const postAddMemberToEvent = async (req, res, next) => {
  const { userId, eventId, preferences } = req.body;
  let societyEvent;

  try {
    societyEvent = await Event.findById(eventId);
  } catch (err) {
    return next(
      new HttpError("Could not add you to the event, please try again!", 500)
    );
  }

  if (!societyEvent) {
    return next(new HttpError("Could not find such event", 404));
  }

  const ticketsRemaining = societyEvent.ticketLimit - societyEvent.guestList.length;

  if (ticketsRemaining <= 0) {
    return next(new HttpError("Tickets are sold out", 500));
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
      name: targetUser.name + " " + targetUser.surname,
      email: targetUser.email,
      phone: targetUser.phone,
      preferences,
      ticket: req.file.location,
    });
    targetUser.tickets.push({
      event: societyEvent.title + ' | ' + dateConvertor(societyEvent.date, societyEvent.time),
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
    societyEvent.title,
    dateConvertor(societyEvent.date, societyEvent.time),
    targetUser.name,
    req.file.location
  );

  eventToSpreadsheet(societyEvent.id);

  res.status(201).json({ message: "Success" });
};

const postAddGuestToEvent = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new HttpError("Invalid inputs passed", 422));
  }
  const { quantity, eventId, guestName, guestEmail, guestPhone, preferences } = req.body;

  let societyEvent;
  try {
    societyEvent = await Event.findById(eventId);
  } catch (err) {
    return next(
      new HttpError("Could not add you to the event, please try again!", 500)
    );
  }

  if (!societyEvent) {
    return next(new HttpError("Could not find such event", 404));
  }

  const ticketsRemaining = societyEvent.ticketLimit - societyEvent.guestList.length;

  if (ticketsRemaining <= 0) {
    return next(new HttpError("Tickets are sold out", 500));
  }

  let guest = {
    type: "guest",
    name: guestName,
    email: guestEmail,
    phone: guestPhone,
    preferences,
    ticket: req.file.location,
  };

  for (let i = 0; i < quantity; i++) {
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
  }

  sendTicketEmail(
    "guest",
    guestEmail,
    societyEvent.title,
    dateConvertor(societyEvent.date, societyEvent.time),
    guestName,
    req.file.location
  );

  eventToSpreadsheet(societyEvent.id);

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

// status 0 = noting to update
// status 1 = success
// status 2 = count is required as more than 1 guest was found
const updatePresence = async (req, res, next) => {
  const { eventId, name, email } = req.body;
  let { count } = req.body; 
  let societyEvent;

  try {
    societyEvent = await Event.findById(eventId);
  } catch (err) {
    return next(new HttpError("Could not find such event, please try again!", 500));
  }

  if (!societyEvent) {
    return next(new HttpError("Could not find such event - for further help best contact support", 404));
  }

  const targetGuests = societyEvent.guestList.filter(
    (guest) => guest.email === email && guest.name === name
  );

  if (targetGuests.length === 0) {
    return next(new HttpError("Guest/s were not found in the list - for further help best contact support", 404));
  }

  if (targetGuests.length > 1 && !count) {
    return res.status(200).json({ status: 2, event: societyEvent.title });
  }

  // If count is not provided but there is only one guest, set count to 1
  if (!count) {
    count = 1;
  }

  let updatedCount = 0; 

  for (let i = 0; i < societyEvent.guestList.length; i++) {
    const guest = societyEvent.guestList[i];

    if (guest.name === name && guest.email === email && guest.status === 0 && count > 0) {
      societyEvent.guestList[i].status = 1;
      count--;
      updatedCount++;
    }

    if (count === 0) break; 
  }

  if (updatedCount === 0) {
    return res.status(200).json({ status: 0, event: societyEvent.title });
  }

  try {
    await societyEvent.save();
  } catch (err) {
    return next(new HttpError("Updating guest list failed, please try again", 500));
  }

  eventToSpreadsheet(eventId);

  res.status(201).json({ status: 1, event: societyEvent.title });
};

export { postAddMemberToEvent, postAddGuestToEvent, postNonSocietyEvent, getEvent, getEventPurchaseAvailability, getSoldTicketQuantity, getEventById, checkEligibleMemberForPurchase, checkEligibleGuestForDiscount, updatePresence };

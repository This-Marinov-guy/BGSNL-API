import mongoose from "mongoose";
import Event from "../models/Event.js";
import NonSocietyEvent from "../models/NonSocietyEvent.js";
import User from "../models/User.js";
import { validationResult } from "express-validator";
import HttpError from "../models/Http-error.js";
import { sendTicketEmail } from "../middleware/email-transporter.js";
import moment from 'moment'
import { eventToSpreadsheet } from "../util/functions/searchInDatabase.js";
import { calculateTimeRemaining, removeModelProperties } from "../util/functions/helpers.js";

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
    const ticketTimer = calculateTimeRemaining(event.ticketTimer);

    if (ticketsRemaining <= 0 || ticketTimer <= 0) {
      status = false;
    }

    res.status(200).json({ status });

  } catch (error) {
    return next(new HttpError("Something got wrong, please contact support", 500));
  }
}

const getEvent = async (req, res, next) => {
  try {
    const { eventName, region } = req.params;

    if (!(eventName && region)) {
      return next(new HttpError("Invalid inputs passed", 422));
    }

    let event = await Event.findOne({
      title: eventName, region, date: { $gt: moment() }});

    if (!event) {
      return next(new HttpError("No event was found", 404));
    }

    let status = true;

    const ticketsRemaining = event.ticketLimit - event.guestList.length;
    const ticketTimer = calculateTimeRemaining(event.ticketTimer);

    if (ticketsRemaining <= 0 || ticketTimer <= 0) {
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

  let member = await member.findById(userId);

  if (!member) {
    new HttpError("Could not find a user with provided id", 404);
  }

  for (const guest of event.guestList) {
    const memberName = `${member.name} ${member.surname}`;

    if (guest.name === memberName && guest.email === member.email ) {
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
  const { quantity, eventId, guestName, guestEmail, guestPhone, preferences, marketing } = req.body;

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
    timestamp: moment(new Date()).format("D MMM YYYY"),
    name: guestName,
    email: guestEmail,
    phone: guestPhone,
    preferences,
    marketing,
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

// status 0 = noting to update
// status 1 = success
// status 2 = count is required as more than 1 guest was found
const updatePresence = async (req, res, next) => {
  const { event, name, email } = req.body;
  let count = req.body.count;
  let initCount = count;
  let societyEvent;

  try {
    societyEvent = await Event.findById(event);
  } catch (err) {
    return next(
      new HttpError("Could not add you to the event, please try again!", 500)
    );
  }

  if (!societyEvent) {
    return next(new HttpError("Could not find such event - for further help best contact support", 404));
  }

  const targetGuests = societyEvent.guestList.filter((guest) => guest.email === email && guest.name === name);

  if (targetGuests.length === 0) {
    return next(new HttpError("Guest/s were not found in list - for further help best contact support", 404));
  }

  if (targetGuests.length > 1 && !count) {
    // require count 
    return res.status(200).json({ status: 2, event: societyEvent.title });
  } else {
    count = 1;
    initCount = count;
  }

  for (let j = 0; j < societyEvent.guestList.length; j++) {
    if (count === 0) {
      break;
    }

    const guest = societyEvent.guestList[j];

    if (guest.name !== name && guest.email !== email) {
      continue;
    }

    if (guest.status === 0) {
      societyEvent.guestList[j].status = 1;
      count--;
    }
  }

  if (initCount === count) {
    return res.status(200).json({ status: 0, event: societyEvent.title });
  }

  try {
    await societyEvent.save();
  } catch (err) {
    return next(
      new HttpError("Updating guest list failed, please try again", 500)
    );
  }

  res.status(201).json({ status: 1, event: societyEvent.title });
};

export { postAddMemberToEvent, postAddGuestToEvent, postNonSocietyEvent, getEvent, getEventPurchaseAvailability, getSoldTicketQuantity, checkEligibleMemberForPurchase, updatePresence };

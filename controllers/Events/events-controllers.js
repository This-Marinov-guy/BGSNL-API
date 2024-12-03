import mongoose from "mongoose";
import Event from "../../models/Event.js";
import NonSocietyEvent from "../../models/NonSocietyEvent.js";
import User from "../../models/User.js";
import { validationResult } from "express-validator";
import { syncEvents } from "../../services/side-services/calendar-integration/sync.js";
import HttpError from "../../models/Http-error.js";
import { sendTicketEmail } from "../../services/side-services/email-transporter.js";
import { eventToSpreadsheet } from "../../services/side-services/google-spreadsheets.js";
import {
  decodeFromURL,
  isEventTimerFinished,
  removeModelProperties,
} from "../../util/functions/helpers.js";
import { MOMENT_DATE_YEAR } from "../../util/functions/dateConvert.js";
import moment from "moment";
import { checkDiscountsOnEvents } from "../../services/main-services/event-action-service.js";
import { extractUserFromRequest } from "../../util/functions/security.js";

export const getEventPurchaseAvailability = async (req, res, next) => {
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
    const expired = isEventTimerFinished(event.ticketTimer);

    if (ticketsRemaining <= 0 || expired) {
      status = false;
    }

    res.status(200).json({ status });
  } catch (error) {
    return next(
      new HttpError("Something got wrong, please contact support", 500)
    );
  }
};

export const getEventById = async (req, res, next) => {
  const eventId = req.params.eventId;

  if (eventId === undefined || !eventId) {
    return res.status(200).json({
      status: false,
    });
  }

  try {
    let event = await Event.findById(eventId);

    if (!event) {
      return res.status(200).json({
        status: false,
      });
    }

    let status = true;

    const ticketsRemaining = event.ticketLimit - event.guestList.length;
    const expired = isEventTimerFinished(event.ticketTimer);

    if (ticketsRemaining <= 0 || expired) {
      status = false;
    }

    event = checkDiscountsOnEvents(event);
    event = removeModelProperties(event, [
      "guestList",
      "discountPass",
      "freePass",
      "earlyBird",
      "lateBird",
      "promotion",
    ]);

    res.status(200).json({ event, status });
  } catch (err) {
    console.log(err);
    return next(new HttpError("Fetching event failed", 500));
  }
};

export const getEvents = async (req, res, next) => {
  const region = req.query.region;

  let events;

  try {
    if (region) {
      events = await Event.find({ region, hidden: false });
    } else {
      events = await Event.find({ hidden: false });
    }
  } catch (err) {
    return next(new HttpError("Fetching events failed", 500));
  }

  const formattedEvents = events.map((event) =>
    removeModelProperties(event, [
      "guestList",
      "discountPass",
      "freePass",
      "earlyBird",
      "lateBird",
      "promotion",
    ])
  );

  res.status(200).json({ events: formattedEvents });
};

export const getSoldTicketQuantity = async (req, res, next) => {
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
    return next(
      new HttpError("Something got wrong, please contact support", 500)
    );
  }
};

export const checkEligibleMemberForPurchase = async (req, res, next) => {
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
};

export const checkEligibleGuestForDiscount = async (req, res, next) => {
  const { email, name, surname, eventId } = req.params;
  const { withError } = req.query;
  const guestName = `${name} ${surname}`;
  let status = true;

  if (!eventId) {
    return next(new HttpError("Invalid inputs passed", 422));
  }

  let event = await Event.findById(eventId);

  if (!event) {
    return next(new HttpError("No event was found", 404));
  }

  if (
    !event.freePass ||
    !event.freePass.includes(guestName) ||
    !event.freePass.includes(email)
  ) {
    return res.status(200).json({ status });
  }

  for (const guest of event.guestList) {
    if (guest.name === guestName || guest.email === email) {
      status = false;
      break;
    }
  }

  res.status(200).json({ status });
};

export const postAddMemberToEvent = async (req, res, next) => {
  const { userId, eventId, code, type, preferences } = req.body;
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

  const ticketsRemaining =
    societyEvent.ticketLimit - societyEvent.guestList.length;

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
      type: type ?? "member",
      code,
      name: targetUser.name + " " + targetUser.surname,
      email: targetUser.email,
      phone: targetUser.phone,
      preferences,
      ticket: req.file.location,
    });
    targetUser.tickets.push({
      event:
        societyEvent.title +
        " | " +
        moment(societyEvent.date).format(MOMENT_DATE_YEAR),
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
    societyEvent.date,
    targetUser.name,
    req.file.location
  );

  await eventToSpreadsheet(societyEvent.id);

  res.status(201).json({ status: true, message: "Success" });
};

export const postAddGuestToEvent = async (req, res, next) => {
  const {
    quantity,
    eventId,
    guestName,
    code,
    guestEmail,
    guestPhone,
    preferences,
    type,
  } = req.body;

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

  const ticketsRemaining =
    societyEvent.ticketLimit - societyEvent.guestList.length;

  if (ticketsRemaining <= 0) {
    return next(new HttpError("Tickets are sold out", 500));
  }

  let guest = {
    type: type ?? "guest",
    code,
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
    societyEvent.date,
    guestName,
    req.file.location
  );

  await eventToSpreadsheet(societyEvent.id);

  return res.status(201).json({ status: true, message: "Success" });
};

// TODO: migrate for both user and member
export const postNonSocietyEvent = async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(new HttpError("Invalid inputs passed", 422));
  }

  const {
    event,
    date,
    user,
    name,
    email,
    phone,
    notificationTypeTerms,
    extraData,
  } = req.body;

  let nonSocietyEvent;
  try {
    nonSocietyEvent = await NonSocietyEvent.findOneOrCreate(
      { event: event },
      { status: "open", event: event, date: date, guestList: [] }
    );
  } catch (err) {
    return next(
      new HttpError("Could not add you to the event, please try again!", 500)
    );
  }

  if (!nonSocietyEvent) {
    return next(new HttpError("Could not find such event", 404));
  }

  const { userId } = extractUserFromRequest(req);

  let targetUser;

  try {
    targetUser = await User.findById(userId);
  } catch (err) {
    return next(
      new HttpError("Could not find the current user, please try again", 500)
    );
  }

  if (!targetUser) {
    return next(new HttpError("Could not find a user with provided id", 404));
  }

  let guest = {
    user,
    name,
    email,
    phone,
    ticket: req.file.location,
    extraData,
    notificationTypeTerms,
  };

  const memberName = `${targetUser.name} ${targetUser.surname}`;
  let status = true;

  for (const guest of nonSocietyEvent.guestList) {
    if (guest.name === memberName && guest.email === targetUser.email) {
      status = false;
      break;
    }
  }

  if (!status) {
    return next(new HttpError("This account has already purchased a ticket for the event!", 401));
  }

  try {
    nonSocietyEvent.guestList.push(guest);
    targetUser.tickets.push({
      event: event + " | " + moment(date).format(MOMENT_DATE_YEAR),
      image: req.file.location,
    });
    await nonSocietyEvent.save();
    await targetUser.save();
  } catch (err) {
    return next(
      new HttpError("Adding user to the event failed, please try again", 500)
    );
  }

  sendTicketEmail("member", email, event, date, name, req.file.location);

  res.status(201).json({ status: true });
};

// status 0 = noting to update
// status 1 = success
// status 2 = count is required as more than 1 guest was found
export const updatePresence = async (req, res, next) => {
  const { eventId, code } = req.body;
  let { count } = req.body;
  let societyEvent;

  try {
    societyEvent = await Event.findById(eventId);
  } catch (err) {
    return next(
      new HttpError("Could not find such event, please try again!", 500)
    );
  }

  if (!societyEvent) {
    return next(
      new HttpError(
        "Could not find such event - for further help best contact support",
        404
      )
    );
  }

  if (societyEvent.guestList.length < 1) {
    return next(new HttpError("This events has no guests!", 404));
  }

  const targetGuests = societyEvent.guestList.filter(
    (guest) => guest.code && guest.code == code
  );

  let guestName, guestEmail;

  if (targetGuests.length > 0) {
    guestName = targetGuests[0].name;
    guestEmail = targetGuests[0].email;
  }

  if (targetGuests.length === 0) {
    return next(new HttpError("Guest/s were not found in the list", 404));
  }

  if (targetGuests.length > 1 && !count) {
    return res.status(200).json({
      status: 2,
      event: societyEvent.title,
      name: guestName,
      email: guestEmail,
    });
  }

  // If count is not provided but there is only one guest, set count to 1
  if (!count) {
    count = 1;
  }

  let updatedCount = 0;

  for (let i = 0; i < societyEvent.guestList.length; i++) {
    const guest = societyEvent.guestList[i];

    if (
      guest.name === guestName &&
      guest.email === guestEmail &&
      guest.status === 0 &&
      count > 0
    ) {
      societyEvent.guestList[i].status = 1;
      count--;
      updatedCount++;
    }

    if (count === 0) break;
  }

  if (updatedCount === 0) {
    return res.status(200).json({
      status: 0,
      event: societyEvent.title,
      name: guestName,
      email: guestEmail,
    });
  }

  try {
    await societyEvent.save();
  } catch (err) {
    return next(
      new HttpError("Updating guest list failed, please try again", 500)
    );
  }

  await eventToSpreadsheet(societyEvent.id);

  res.status(201).json({
    status: 1,
    event: societyEvent.title,
    name: guestName,
    email: guestEmail,
  });
};

export const postSyncEventsCalendar = async (req, res, next) => {
  console.log("Syncing events...");
  await syncEvents();
};

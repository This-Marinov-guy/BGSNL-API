import mongoose from "mongoose";
import Event from "../../models/Event.js";
import NonSocietyEvent from "../../models/NonSocietyEvent.js";
import User from "../../models/User.js";
import { validationResult } from "express-validator";
import { syncEvents } from "../../services/side-services/calendar-integration/sync.js";
import HttpError from "../../models/Http-error.js";
import { sendTicketEmail } from "../../services/background-services/email-transporter.js";
import {
  eventToSpreadsheet,
  specialEventsToSpreadsheet,
} from "../../services/background-services/google-spreadsheets.js";
import {
  decodeFromURL,
  isEventTimerFinished,
  removeModelProperties,
} from "../../util/functions/helpers.js";
import { MOMENT_DATE_YEAR } from "../../util/functions/dateConvert.js";
import moment from "moment";
import { checkDiscountsOnEvents } from "../../services/main-services/event-action-service.js";
import { extractUserFromRequest } from "../../util/functions/security.js";
import { findUserById } from "../../services/main-services/user-service.js";
import { ACCESS_4 } from "../../util/config/defines.js";
import { generateAndUploadEventTicket } from "../../services/side-services/ticket-generator.js";

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
    let event = await Event.findOne({
      _id: eventId,
      status: { $ne: "archived" },
    });

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
      "earlyBird",
      "lateBird",
      "promotion",
      "addOns",
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
      events = await Event.find({
        region,
        hidden: false,
        status: { $ne: "archived" },
      });
    } else {
      events = await Event.find({ hidden: false, status: { $ne: "archived" } });
    }
  } catch (err) {
    return next(new HttpError("Fetching events failed", 500));
  }

  const formattedEvents = events.map((event) =>
    removeModelProperties(event, [
      "guestList",
      "earlyBird",
      "lateBird",
      "promotion",
      "addOns",
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

  let member = await User.findOne({ _id: userId });

  if (!member) {
    res.status(200).json({ status: false });
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

// Determines whether a ticket is free or paid, and returns the correct priceId.
// Called by both guest and member purchase flows before checkout.
export const checkTicketEligibility = async (req, res, next) => {
  const { eventId, userId, normalTicket } = req.body;

  if (!eventId) {
    return next(new HttpError("Invalid inputs passed", 422));
  }

  let event;
  try {
    event = await Event.findById(eventId);
  } catch (err) {
    return next(new HttpError("Could not find event", 500));
  }

  if (!event) {
    return next(new HttpError("No event was found", 404));
  }

  const ticketsRemaining = event.ticketLimit - event.guestList.length;
  const expired = isEventTimerFinished(event.ticketTimer);
  if (ticketsRemaining <= 0 || expired) {
    return next(new HttpError("Ticket sale is closed", 400));
  }

  // --- Member path ---
  if (userId) {
    let member;
    try {
      member = await User.findById(userId);
    } catch (err) {
      return next(new HttpError("Could not find user", 500));
    }
    if (!member) {
      return next(new HttpError("User not found", 404));
    }

    const memberName = `${member.name} ${member.surname}`;
    const alreadyRegistered = event.guestList.some(
      (g) => g.name === memberName && g.email === member.email
    );

    // First-time check: warn the member they already have a ticket
    if (alreadyRegistered && !normalTicket) {
      return res.status(200).json({ alreadyRegistered: true });
    }

    // Free for all members
    if (event.isFree || event.isMemberFree) {
      return res.status(200).json({ type: "free" });
    }

    // Active members (ACCESS_4 roles) get the discounted/activeMember price
    const isActiveMember = ACCESS_4.includes(member.role);

    let priceId;
    if (normalTicket) {
      // Already has a member ticket — falls back to guest price
      priceId = event.product?.guest?.priceId;
    } else if (isActiveMember && event.product?.activeMember?.priceId) {
      priceId = event.product.activeMember.priceId;
    } else {
      priceId = event.product?.member?.priceId;
    }

    if (!priceId) {
      return next(new HttpError("No price configured for this event", 500));
    }

    return res.status(200).json({ type: "paid", priceId });
  }

  // --- Guest path ---
  if (event.isFree) {
    return res.status(200).json({ type: "free" });
  }

  const priceId = event.product?.guest?.priceId;
  if (!priceId) {
    return next(new HttpError("No price configured for this event", 500));
  }

  return res.status(200).json({ type: "paid", priceId });
};

export const postAddMemberToEvent = async (req, res, next) => {
  const { userId, eventId, code, type, preferences } = req.body;
  const addOns = req.body?.addOns ? JSON.parse(req.body?.addOns) : [];

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
    targetUser = await User.findOne({ _id: userId });
  } catch (err) {
    new HttpError("Could not find a user with provided id", 404);
  }
  try {
    const sess = await mongoose.startSession();
    sess.startTransaction();
    societyEvent.guestList.push({
      type: "free member",
      code,
      name: targetUser.name + " " + targetUser.surname,
      email: targetUser.email,
      phone: targetUser.phone,
      preferences,
      addOns,
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

  eventToSpreadsheet(societyEvent.id);

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

  const addOns = req.body?.addOns ? JSON.parse(req.body?.addOns) : [];

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

  const safeQuantity = Number(quantity) > 0 ? Number(quantity) : 1;

  let ticketLocation = req.file?.location ?? "";

  if (!ticketLocation) {
    try {
      ticketLocation = await generateAndUploadEventTicket({
        event: societyEvent,
        checkoutType: "guest",
        bucketName: process.env.BUCKET_GUEST_TICKETS,
        originUrl: req.body?.origin_url || req.body?.originUrl || "",
        code,
        quantity: safeQuantity,
        guestName,
      });
    } catch (err) {
      console.log(err);
      return next(
        new HttpError("Ticket generation failed, please try again", 500)
      );
    }
  }

  let guest = {
    type: "free guest",
    code,
    name: guestName,
    email: guestEmail,
    phone: guestPhone,
    preferences,
    addOns,
    ticket: ticketLocation,
  };

  for (let i = 0; i < safeQuantity; i++) {
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

  const tickets = Array.from({ length: safeQuantity }, () => ticketLocation);

  sendTicketEmail(
    "guest",
    guestEmail,
    societyEvent.title,
    societyEvent.date,
    guestName,
    tickets
  );

  eventToSpreadsheet(societyEvent.id);

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
    ticketImg,
    origin_url,
    originUrl,
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

  // Try to extract an authenticated user — guests won't have one
  const { userId } = extractUserFromRequest(req) ?? {};

  let targetUser = null;
  if (userId) {
    try {
      targetUser = await findUserById(userId);
    } catch (err) {
      return next(
        new HttpError("Could not find the current user, please try again", 500)
      );
    }

    if (!targetUser) {
      return next(
        new HttpError("Could not find the current user, please try again", 404)
      );
    }
  }

  // Resolve identity: prefer DB user, fall back to request body
  const memberName = targetUser
    ? `${targetUser?.name} ${targetUser?.surname}`
    : name;
  const memberEmail = targetUser ? targetUser?.email : email;
  const memberPhone = (targetUser?.phone ?? phone ?? "").trim();

  // Duplicate check
  let status = true;
  for (const guestCheck of nonSocietyEvent.guestList) {
    if (guestCheck.name === memberName && guestCheck.email === memberEmail) {      
      status = false;
      break;
    }
  }

  if (!status) {
    return next(
      new HttpError(
        "This account has already purchased a ticket for the event!",
        401
      )
    );
  }  

  let ticketLocation = req.file?.location ?? "";

  if (!ticketLocation) {
    const normalizedTicketImg = String(ticketImg || "").trim();
    const normalizedOriginUrl = String(origin_url || originUrl || "").trim();

    if (!normalizedTicketImg) {
      return next(new HttpError("Missing ticket template image", 422));
    }

    const absoluteTicketImg = /^https?:\/\//i.test(normalizedTicketImg)
      ? normalizedTicketImg
      : `${normalizedOriginUrl.replace(/\/$/, "")}${normalizedTicketImg.startsWith("/") ? "" : "/"}${normalizedTicketImg}`;

    try {
      ticketLocation = await generateAndUploadEventTicket({
        event: {
          id: nonSocietyEvent.id || nonSocietyEvent._id?.toString() || event,
          ticketImg: absoluteTicketImg,
          ticketName: true,
          ticketQR: false,
          ticketColor: "#faf9f6",
        },
        checkoutType: targetUser ? "member" : "guest",
        bucketName: process.env.BUCKET_MEMBER_TICKETS,
        originUrl: normalizedOriginUrl,
        code: Date.now(),
        quantity: 1,
        guestName: memberName,
        userId: userId ?? "",
        memberUser: targetUser,
      });
    } catch (err) {
      console.log(err);
      return next(
        new HttpError("Ticket generation failed, please try again", 500)
      );
    }
  }

  // Build guest — mirrors postAddGuestToEvent shape for non-member path
  let guest = {
    user,
    userId: userId ?? "-",
    name: memberName,
    email: memberEmail,
    phone: memberPhone,
    ticket: ticketLocation,
    course: targetUser?.course ?? "-",
    extraData,
    notificationTypeTerms,
  };

  try {
    nonSocietyEvent.guestList.push(guest);

    // Only push to user.tickets if we have an authenticated member
    if (targetUser) {
      targetUser.tickets.push({
        event: event + " | " + moment(date).format(MOMENT_DATE_YEAR),
        image: ticketLocation,
      });
      await targetUser.save();
    }

    await nonSocietyEvent.save();
  } catch (err) {
    console.log(err);
    
    return next(
      new HttpError("Adding user to the event failed, please try again", 500)
    );
  }

  sendTicketEmail("member", memberEmail, event, date, memberName, ticketLocation);

  specialEventsToSpreadsheet(nonSocietyEvent.id);

  return res.status(201).json({ status: true });
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

  eventToSpreadsheet(societyEvent.id);

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

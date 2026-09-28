import { findPublicEvent } from "../../services/public-content/find-public-event.js";
import { logIntegrationError } from "../../middleware/axiom-logger.js";
import mongoose from "mongoose";
import Event from "../../models/Event.js";
import NonSocietyEvent from "../../models/NonSocietyEvent.js";
import MemberUser from "../../models/MemberUser.js";
import { validationResult } from "express-validator";
import { syncEvents } from "../../services/side-services/calendar-integration/sync.js";
import HttpError from "../../models/Http-error.js";
import {
  sendMailtrapTemplateEmail,
  sendResendTemplateEmail,
  sendTicketEmail,
} from "../../services/background-services/email-transporter.js";
import {
  eventToSpreadsheet,
  specialEventsToSpreadsheet,
} from "../../services/background-services/google-spreadsheets.js";
import {
  decodeFromURL,
  isTicketSaleClosed,
  removeModelProperties,
} from "../../util/functions/helpers.js";
import {
  MOMENT_DATE_TIME_YEAR,
  MOMENT_DATE_YEAR,
} from "../../util/functions/dateConvert.js";
import moment from "moment-timezone";
import { checkDiscountsOnEvents } from "../../services/main-services/event-action-service.js";
import { accountEntitlements } from "../../util/subscriptions/policy.js";
import { reconcileAccount } from "../../services/subscriptions/reconcile.js";
import { extractUserFromRequest } from "../../util/functions/security.js";
import { findUserById } from "../../services/main-services/user-service.js";
import {
  ACCESS_4,
  ALL_EVENT_REGIONS_ACCESS,
  EVENT_MANAGEMENT_ACCESS,
  DEFAULT_REGION,
  NON_SOCIETY_EVENT_FINAL_REMINDER_EVENT_ID,
  NON_SOCIETY_EVENT_FINAL_REMINDER_TEMPLATE,
  NON_SOCIETY_EVENT_FINAL_REMINDER_TEST_EMAILS,
  NON_SOCIETY_EVENT_RESEND_EVENT_ID,
  NON_SOCIETY_EVENT_RESEND_TEST_EMAILS,
  NON_SOCIETY_EVENT_RESEND_TEMPLATE,
} from "../../util/config/defines.js";
import { generateAndUploadEventTicket } from "../../services/side-services/ticket-generator.js";
import { mintTicketToken, reserveTicketToken, resolveTicketToken } from "../../services/tickets/qr-link.js";
import { uploadCustomEventTicket } from "../../services/side-services/ticket-generator.js";
import { planCheckIn, checkInMutation } from "../../services/tickets/check-in.js";
import { futureEventDateFilter, publicEventQuery, serializePublicEvent } from "../../services/public-content/event-publication.js";


const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const serializeGuestListEntry = (guest) => ({
  id: String(guest._id),
  name: guest.name,
  email: guest.email,
  phone: guest.phone,
  ticket: guest.ticket,
  transactionId: guest.transactionId,
  type: guest.type,
  status: guest.status,
  timestamp: guest.timestamp,
  refunded: Boolean(guest.refunded),
  preferences: guest.preferences || {},
  addOns: (guest.addOns || []).map((addOn) => ({
    title: addOn.title,
    price: addOn.price,
  })),
});

const guestListColumns = (event) => ({
  addOns: Boolean(event.addOns?.isEnabled && event.addOns.items?.length),
  preferences: Array.isArray(event.extraInputsForm) && event.extraInputsForm.length > 0,
});

const canManageEventGuestList = (req, event) => {
  const { roles, region } = extractUserFromRequest(req);
  return roles.some((role) => ALL_EVENT_REGIONS_ACCESS.includes(role)) || region === event.region;
};

const addEmailRecipient = (recipientsByEmail, invalidEmails, email, name = "") => {
  const normalizedEmail = String(email || "").trim().toLowerCase();

  if (!normalizedEmail) return;

  if (!EMAIL_REGEX.test(normalizedEmail)) {
    invalidEmails.push(email);
    return;
  }

  if (!recipientsByEmail.has(normalizedEmail)) {
    recipientsByEmail.set(normalizedEmail, {
      email: normalizedEmail,
      name: String(name || "").trim(),
    });
  }
};

const getNonSocietyEventEmailRecipients = ({
  nonSocietyEvent,
  testOnly,
  testEmails,
  customEmails,
}) => {
  const invalidEmails = [];
  const recipientsByEmail = new Map();

  if (testOnly) {
    for (const email of testEmails) {
      addEmailRecipient(
        recipientsByEmail,
        invalidEmails,
        email,
        "Bulgarian Society Netherlands"
      );
    }
  } else {
    for (const guest of nonSocietyEvent.guestList || []) {
      addEmailRecipient(
        recipientsByEmail,
        invalidEmails,
        guest.email,
        guest.name
      );
    }
  }

  for (const email of customEmails) {
    addEmailRecipient(recipientsByEmail, invalidEmails, email);
  }

  return {
    recipients: [...recipientsByEmail.values()],
    invalidEmails,
  };
};

const formatNonSocietyEventDate = (
  date,
  timezone = "Europe/Amsterdam"
) => {
  if (!date) return "";

  return `${moment(date)
    .tz(timezone)
    .format(MOMENT_DATE_TIME_YEAR)} (${timezone} time)`;
};

export const getEventPurchaseAvailability = async (req, res, next) => {
  try {
    const { eventId } = req.params;

    if (!eventId) {
      return next(new HttpError("Invalid inputs passed", 422));
    }

    const event = await findPublicEvent(Event, eventId, req.query?.region);

    if (!event) {
      return next(new HttpError("No event was found", 404));
    }

    const status = !isTicketSaleClosed(event);

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
    return next(new HttpError("No event was found", 404));
  }

  try {
    const event = await findPublicEvent(Event, eventId, req.query?.region);

    if (!event) {
      return next(new HttpError("No event was found", 404));
    }

    if (event.region === DEFAULT_REGION) {
      return next(new HttpError("No event was found", 404));
    }

    const status = !isTicketSaleClosed(event);

    return res.status(200).json({ event: serializePublicEvent(event), status });
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
      if (region === DEFAULT_REGION) {
        return res.status(200).json({ events: [] });
      }

      events = await Event.find({
        region,
        ...publicEventQuery,
        ...futureEventDateFilter(),
      });
    } else {
      events = await Event.find({
        region: { $ne: DEFAULT_REGION },
        ...publicEventQuery,
        ...futureEventDateFilter(),
      });
    }
  } catch (err) {
    return next(new HttpError("Fetching events failed", 500));
  }

  const formattedEvents = events.map((event) => serializePublicEvent(event));

  res.status(200).json({ events: formattedEvents });
};

export const getSoldTicketQuantity = async (req, res, next) => {
  try {
    const { eventId } = req.params;

    if (!eventId) {
      return next(new HttpError("Invalid inputs passed", 422));
    }

    const event = await findPublicEvent(Event, eventId, req.query?.region);
    if (!event) {
      return next(new HttpError("No event was found", 404));
    }

    return res.status(200).json({ ticketsSold: event.guestList.length });
  } catch (error) {
    return next(
      new HttpError("Something got wrong, please contact support", 500)
    );
  }
};

export const checkEligibleMemberForPurchase = async (req, res, next) => {
  const { eventId } = req.params;
  const userId = req.user.userId;
  let status = true;

  if (!eventId) {
    return next(new HttpError("Invalid inputs passed", 422));
  }

  let event = await Event.findById(eventId);

  if (!event || event.status === "draft") {
    return next(new HttpError("No event was found", 404));
  }

  let member = await findUserById(userId);

  if (!member) {
    return res.status(200).json({ status: false });
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
  const { eventId, normalTicket } = req.body;
  const userId = req.user?.userId;
  if (req.body.userId && !userId) return next(new HttpError("Please sign in to check member eligibility", 401));

  if (!eventId) {
    return next(new HttpError("Invalid inputs passed", 422));
  }

  let event;
  try {
    event = await Event.findById(eventId);
  } catch (err) {
    return next(new HttpError("Could not find event", 500));
  }

  if (!event || event.status === "draft") {
    return next(new HttpError("No event was found", 404));
  }

  if (isTicketSaleClosed(event)) {
    return next(new HttpError("Ticket sale is closed", 400));
  }

  // --- Member path ---
  if (userId) {
    let member;
    try {
      member = (await reconcileAccount(req.account))?.user;
      if (!member || !accountEntitlements(member).memberDiscount) return next(new HttpError("An active member subscription is required", 403));
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
    if (event.isFree || (!normalTicket && event.isMemberFree)) {
      return res.status(200).json({ type: "free" });
    }

    // Active members (ACCESS_4 roles) get the discounted/activeMember price
    const isActiveMember = member.roles?.some((role) => ACCESS_4.includes(role));

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

  if (!societyEvent || societyEvent.status === "draft") {
    return next(new HttpError("Could not find such event", 404));
  }

  if (isTicketSaleClosed(societyEvent)) {
    return next(new HttpError("Ticket sale is closed", 400));
  }

  let targetUser;
  try {
    targetUser = await MemberUser.findOne({ _id: userId });
  } catch (err) {
    return next(new HttpError("Could not find a user with provided id", 404));
  }
  if (!targetUser) return next(new HttpError("Could not find a user with provided id", 404));
  if (!req.file?.buffer) return next(new HttpError("A ticket image is required", 400));
  let ticketLocation;
  try {
    const ticketToken = await reserveTicketToken(societyEvent, code);
    ticketLocation = await uploadCustomEventTicket({
      buffer: req.file.buffer, eventId: String(societyEvent._id), ticketToken,
      checkoutType: "member", bucketName: process.env.BUCKET_MEMBER_TICKETS,
    });
    societyEvent.guestList.push({
      type: "free member",
      code,
      ticketToken,
      name: targetUser.name + " " + targetUser.surname,
      email: targetUser.email,
      phone: targetUser.phone,
      preferences,
      addOns,
      ticket: ticketLocation,
    });
    targetUser.tickets.push({
      event:
        societyEvent.title +
        " | " +
        moment(societyEvent.date).format(MOMENT_DATE_YEAR),
      image: ticketLocation,
    });
    await mongoose.connection.transaction(async session => {
      await societyEvent.save({ session });
      await targetUser.save({ session });
    });
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
    ticketLocation
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

  if (!societyEvent || societyEvent.status === "draft") {
    return next(new HttpError("Could not find such event", 404));
  }

  if (isTicketSaleClosed(societyEvent)) {
    return next(new HttpError("Ticket sale is closed", 400));
  }

  const safeQuantity = Number(quantity) > 0 ? Number(quantity) : 1;

  let ticketLocation;
  let ticketToken;

  {
    try {
      // Reserved before the guest rows exist; stored on each of them below.
      ticketToken = await reserveTicketToken(societyEvent, code);
      ticketLocation = await generateAndUploadEventTicket({
        event: societyEvent,
        checkoutType: "guest",
        bucketName: process.env.BUCKET_GUEST_TICKETS,
        originUrl: req.body?.origin_url || req.body?.originUrl || "",
        ticketToken,
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
    ticketToken,
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
    university,
    course,
    questions,
    referenceCode,
    timezone = "Europe/Amsterdam",
    ticketImg,
    origin_url,
    originUrl,
  } = req.body;

  let nonSocietyEvent;
  try {
    nonSocietyEvent =
      (await NonSocietyEvent.findOne({ event, region: DEFAULT_REGION })) ||
      (await NonSocietyEvent.findOne({
        event,
        $or: [{ region: { $exists: false } }, { region: "" }, { region: null }],
      }));

    if (nonSocietyEvent && nonSocietyEvent.region !== DEFAULT_REGION) {
      nonSocietyEvent.region = DEFAULT_REGION;
      await nonSocietyEvent.save();
    }

    if (!nonSocietyEvent) {
      nonSocietyEvent = await NonSocietyEvent.create({
        status: "open",
        event,
        referenceCode,
        region: DEFAULT_REGION,
        date,
        timezone,
        guestList: [],
      });
    } else {
      nonSocietyEvent.referenceCode = referenceCode || nonSocietyEvent.referenceCode;
      nonSocietyEvent.timezone = timezone || nonSocietyEvent.timezone;
    }
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

  // Member fields arrive pre-filled, but remain editable for this registration.
  const memberName =
    name || (targetUser ? `${targetUser?.name} ${targetUser?.surname}` : "");
  const memberEmail = email || targetUser?.email;
  const memberPhone = (targetUser?.phone ?? phone ?? "").trim();
  const memberUniversity =
    targetUser?.university === "working"
      ? targetUser?.profession
      : targetUser?.university === "other"
        ? targetUser?.otherUniversityName
        : targetUser?.university;

  // Duplicate check
  let status = true;
  for (const guestCheck of nonSocietyEvent.guestList) {
    if (
      (userId && guestCheck.userId === userId) ||
      (guestCheck.name === memberName && guestCheck.email === memberEmail)
    ) {
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

  let ticketLocation = "";
  const ticketToken = mintTicketToken();

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
        ticketToken,
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
    ticketToken,
    userId: userId ?? "-",
    name: memberName,
    email: memberEmail,
    phone: memberPhone,
    ticket: ticketLocation,
    course: course || targetUser?.course || "-",
    university: university || memberUniversity || "-",
    questions: questions || "",
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

  sendTicketEmail(
    targetUser ? "member" : "guest",
    memberEmail,
    event,
    date,
    memberName,
    ticketLocation,
    timezone
  );

  specialEventsToSpreadsheet(nonSocietyEvent.id);

  return res.status(201).json({ status: true });
};

export const sendNonSocietyEventResendEmail = async ({
  customEmails = [],
  testOnly = false,
} = {}) => {
  if (!NON_SOCIETY_EVENT_RESEND_TEMPLATE) {
    throw new HttpError("Missing non-society event email template UUID", 500);
  }

  if (!mongoose.Types.ObjectId.isValid(NON_SOCIETY_EVENT_RESEND_EVENT_ID)) {
    throw new HttpError("Invalid non-society event id", 500);
  }

  let nonSocietyEvent;
  try {
    nonSocietyEvent = await NonSocietyEvent.findById(
      NON_SOCIETY_EVENT_RESEND_EVENT_ID
    ).select("event guestList.email guestList.name");
  } catch (err) {
    throw new HttpError(
      "Could not find the non-society event, please try again",
      500
    );
  }

  if (!nonSocietyEvent) {
    throw new HttpError("Could not find such non-society event", 404);
  }

  const { recipients, invalidEmails } = getNonSocietyEventEmailRecipients({
    nonSocietyEvent,
    testOnly,
    testEmails: NON_SOCIETY_EVENT_RESEND_TEST_EMAILS,
    customEmails,
  });

  console.log(
    `[nonSocietyEventResendEmail] Queuing emails for "${nonSocietyEvent.event}" | testOnly=${testOnly}`
  );

  for (const recipient of recipients) {
    console.log(
      `[nonSocietyEventResendEmail] ${recipient.email}${recipient.name ? ` | ${recipient.name}` : ""}`
    );

    sendResendTemplateEmail(
      NON_SOCIETY_EVENT_RESEND_TEMPLATE,
      recipient.email,
      recipient.name
    );
  }

  if (invalidEmails.length > 0) {
    console.log(
      `[nonSocietyEventResendEmail] Skipped invalid emails: ${invalidEmails.join(", ")}`
    );
  }

  console.log(
    `[nonSocietyEventResendEmail] Total queued: ${recipients.length}`
  );

  return {
    status: true,
    message: "Non-society event emails queued",
    eventId: NON_SOCIETY_EVENT_RESEND_EVENT_ID,
    event: nonSocietyEvent.event,
    testOnly,
    queued: recipients.length,
    invalidEmails,
  };
};

export const sendNonSocietyEventFinalReminderEmail = async ({
  customEmails = [],
  testOnly = false,
  templateVariablesOverride = null,
} = {}) => {
  if (!NON_SOCIETY_EVENT_FINAL_REMINDER_TEMPLATE) {
    throw new HttpError("Missing non-society event final reminder template UUID", 500);
  }

  if (!mongoose.Types.ObjectId.isValid(NON_SOCIETY_EVENT_FINAL_REMINDER_EVENT_ID)) {
    throw new HttpError("Invalid non-society event final reminder event id", 500);
  }

  let nonSocietyEvent;
  try {
    nonSocietyEvent = await NonSocietyEvent.findById(
      NON_SOCIETY_EVENT_FINAL_REMINDER_EVENT_ID
    ).select("event date timezone guestList.email guestList.name");
  } catch (err) {
    throw new HttpError(
      "Could not find the non-society event, please try again",
      500
    );
  }

  if (!nonSocietyEvent) {
    throw new HttpError("Could not find such non-society event", 404);
  }

  const { recipients, invalidEmails } = getNonSocietyEventEmailRecipients({
    nonSocietyEvent,
    testOnly,
    testEmails: NON_SOCIETY_EVENT_FINAL_REMINDER_TEST_EMAILS,
    customEmails,
  });

  const eventDate = formatNonSocietyEventDate(
    nonSocietyEvent.date,
    nonSocietyEvent.timezone
  );

  console.log(
    `[nonSocietyEventFinalReminderEmail] Queuing emails for "${nonSocietyEvent.event}" | testOnly=${testOnly}`
  );

  for (const recipient of recipients) {
    const templateVariables =
      templateVariablesOverride || {
        template_variables: {
          eventName: nonSocietyEvent.event,
          guestName: recipient.name,
          eventDate,
        },
      };

    console.log(
      `[nonSocietyEventFinalReminderEmail] ${recipient.email}${recipient.name ? ` | ${recipient.name}` : ""}`
    );

    sendMailtrapTemplateEmail(
      NON_SOCIETY_EVENT_FINAL_REMINDER_TEMPLATE,
      recipient.email,
      templateVariables
    );
  }

  if (invalidEmails.length > 0) {
    console.log(
      `[nonSocietyEventFinalReminderEmail] Skipped invalid emails: ${invalidEmails.join(", ")}`
    );
  }

  console.log(
    `[nonSocietyEventFinalReminderEmail] Total queued: ${recipients.length}`
  );

  return {
    status: true,
    message: "Non-society event final reminder emails queued",
    eventId: NON_SOCIETY_EVENT_FINAL_REMINDER_EVENT_ID,
    event: nonSocietyEvent.event,
    testOnly,
    queued: recipients.length,
    invalidEmails,
  };
};

export const postSendNonSocietyEventResendEmail = async (req, res, next) => {
  const testOnly = req.body?.testOnly === true || req.query?.testOnly === "true";
  const customEmails = Array.isArray(req.body?.customEmails)
    ? req.body.customEmails
    : [];

  try {
    const result = await sendNonSocietyEventResendEmail({
      customEmails,
      testOnly,
    });

    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
};

export const postSendNonSocietyEventFinalReminderEmail = async (req, res, next) => {
  const testOnly = req.body?.testOnly === true || req.query?.testOnly === "true";
  const customEmails = Array.isArray(req.body?.customEmails)
    ? req.body.customEmails
    : [];
  const templateVariablesOverride = req.body?.templateVariables || null;

  try {
    const result = await sendNonSocietyEventFinalReminderEmail({
      customEmails,
      testOnly,
      templateVariablesOverride,
    });

    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
};


export const getEventGuestList = async (req, res, next) => {
  try {
    const event = await Event.findById(req.params.eventId).select("region title status guestList extraInputsForm addOns");
    if (!event) return next(new HttpError("No event was found", 404));
    if (!canManageEventGuestList(req, event)) return next(new HttpError("No access to this event guest list", 403));
    // Read-only committee access matches the existing analytics scope; it does
    // not grant access to drafts/archives or permission to change attendance.
    const { roles = [] } = extractUserFromRequest(req);
    if (!roles.some(role => EVENT_MANAGEMENT_ACCESS.includes(role)) && ["draft", "archived"].includes(event.status)) return next(new HttpError("No access to this event guest list", 403));
    if (req.path?.endsWith("/stream")) {
      const { streamGuestList } = await import("../../services/tickets/guest-list-live.js");
      await streamGuestList(req, res, event.id);
      return;
    }
    res.set("Cache-Control", "private, no-store");
    return res.status(200).json({
      eventId: event.id,
      title: event.title,
      columns: guestListColumns(event),
      guestList: event.guestList.map(serializeGuestListEntry),
    });
  } catch {
    return next(new HttpError("The guest list could not be loaded", 500));
  }
};

export const updateGuestPresence = async (req, res, next) => {
  const { eventId, guestId, present } = req.body;
  try {
    const event = await Event.findById(eventId);
    if (!event) return next(new HttpError("No event was found", 404));
    if (!canManageEventGuestList(req, event)) return next(new HttpError("No access to this event guest list", 403));
    const guest = event.guestList.id(guestId);
    if (!guest) return next(new HttpError("This guest is no longer in the list", 404));
    if (guest.refunded) return next(new HttpError("A refunded ticket cannot be checked in", 422));
    const result = await Event.updateOne({ _id: event._id, region: event.region,
      guestList: { $elemMatch: { _id: guest._id, refunded: { $ne: true } } } },
    { $set: { "guestList.$.status": present ? 1 : 0, "guestList.$.checkedInAt": present ? new Date() : null } });
    if (result.matchedCount !== 1) return next(new HttpError("This ticket changed. Reload the guest list.", 409));
    guest.status = present ? 1 : 0;
    Promise.resolve().then(() => eventToSpreadsheet(event.id)).catch((error) => {
      logIntegrationError("google-sheets", error, "guest-presence-sync");
    });
    return res.status(200).json({
      status: true,
      guest: serializeGuestListEntry(guest),
      sheetSync: "queued",
    });
  } catch {
    return next(new HttpError("Updating guest presence failed", 500));
  }
};

// Legacy numeric statuses remain compatible: 0 duplicate, 1 admitted, 2 choose count.
export const updatePresence = async (req, res, next) => {
  let { eventId, code } = req.body;
  const { count, token } = req.body;
  try {
    if (token) {
      const ticket = await resolveTicketToken(token);
      if (!ticket) return next(new HttpError("Ticket not found", 404));
      eventId = ticket.eventId;
      code = ticket.code;
    }
    if (req.body.expectedEventId && String(eventId) !== req.body.expectedEventId) return next(new HttpError("This ticket is for a different event", 422));
    const event = await Event.findById(eventId).select("region title guestList");
    if (!event) return next(new HttpError("Event not found", 404));
    if (!canManageEventGuestList(req, event)) return next(new HttpError("No access to this event guest list", 403));
    const includeDetails = req.body.includeDetails === true;
    const plan = planCheckIn(event.guestList, code, count, { preview: req.body.preview === true || includeDetails });
    const messages = { not_found: "Ticket not found for this event", refunded: "This ticket has been refunded", invalid_quantity: "Choose a count within the remaining tickets" };
    if (plan.statusCode) return next(new HttpError(messages[plan.outcome], plan.statusCode));
    if (plan.ids) {
      const { filter, update, options } = checkInMutation(event, plan);
      const result = await Event.updateOne(filter, update, options);
      if (result.modifiedCount !== 1) return next(new HttpError("This ticket changed or was just checked in by another scanner. Check it again before admitting anyone.", 409));
      // Spreadsheet failure must not turn a committed check-in into an error.
      Promise.resolve().then(() => eventToSpreadsheet(event.id)).catch((error) => {
        logIntegrationError("google-sheets", error, "guest-presence-sync");
      });
    }
    const details = { ...plan };
    delete details.ids;
    delete details.statusCode;
    res.set("Cache-Control", "private, no-store");
    return res.status(200).json({ ...details, event: event.title, eventId: event.id,
      ...(includeDetails ? { ticketDetails: event.guestList.filter(guest => guest.code != null && String(guest.code) === String(code)).map(serializeGuestListEntry) } : {}),
      guests: event.guestList.filter(guest => guest.code != null && String(guest.code) === String(code) && !guest.refunded).map(guest => ({
        id: String(guest._id), name: guest.name,
        present: Number(guest.status) === 1 || Boolean(plan.ids?.some(id => String(id) === String(guest._id))),
      })),
      remaining: plan.remaining - (plan.admitted || 0) });
  } catch {
    return next(new HttpError("Check-in could not be confirmed. Please try again.", 500));
  }
};

export const postSyncEventsCalendar = async (req, res, next) => {
  try {
    await syncEvents();
    return res.status(202).json({ status: true });
  } catch {
    return next(new HttpError("Calendar synchronization could not be started", 503));
  }
};

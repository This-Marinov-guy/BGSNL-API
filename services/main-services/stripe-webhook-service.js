import { hashPassword } from "../authentication/passwords.js";
import HttpError from "../../models/Http-error.js";
import mongoose from "mongoose";
import Event from "../../models/Event.js";
import MemberUser from "../../models/MemberUser.js";
import AlumniUser from "../../models/AlumniUser.js";
import { sendTicketEmail, welcomeEmail, alumniWelcomeEmail } from "../background-services/email-transporter.js";
import { alumniToSpreadsheet, eventToSpreadsheet, usersToSpreadsheet } from "../background-services/google-spreadsheets.js";
import { findUserById, normalizeEmail } from "./user-service.js";
import { chooseRandomAvatar, decryptData } from "../../util/functions/helpers.js";
import { MOMENT_DATE_YEAR, calculatePurchaseAndExpireDates } from "../../util/functions/dateConvert.js";
import { ALUMNI, DEFAULT_REGION } from "../../util/config/defines.js";
import moment from "moment";
import { ACTIVE, PAYMENT_AWAITING, USER_STATUSES } from "../../util/config/enums.js";
import { recountMemberStatistics, recountAlumniStatistics } from "../background-services/statistics-service.js";
import { getStripeSubscriptionCreatedDate } from "../side-services/stripe.js";
import {
  isMemberPriceCheckout,
  isRestrictedTicketAccount,
  memberTicketClaimKey,
  memberTicketDuplicateMatcher,
} from "../tickets/member-ticket-policy.js";
import { refundDuplicateMemberTicket } from "../tickets/member-ticket-refund.js";

const resolveJoinDateFromSubscription = async (
  subscriptionId,
  preferredRegions = []
) => {
  const stripeSubscription = await getStripeSubscriptionCreatedDate(
    subscriptionId,
    preferredRegions
  );

  return stripeSubscription?.createdAt || new Date();
};

/**
 * Handle alumni signup checkout session
 */
export const handleAlumniSignup = async (metadata, paymentData, {
  resolveJoinDate = resolveJoinDateFromSubscription, notify = alumniWelcomeEmail,
  sync = alumniToSpreadsheet, recount = recountAlumniStatistics,
} = {}) => {
  const { subscriptionId, customerId, paymentStatus, stripeRegion } = paymentData;
  const {
    tier,
    period,
    name,
    surname,
    phone,
    email: rawEmail,
    notificationTypeTerms,
  } = metadata;
  const notificationTerms =
    metadata.notificationTerms === true || metadata.notificationTerms === "true";
  const email = normalizeEmail(rawEmail);
  if (!email) {
    throw new HttpError("Please send a valid email", 422);
  }

  const password = decryptData(metadata.password);

  let hashedPassword;
  try {
    hashedPassword = await hashPassword(password, { legacyCheckout: true });
  } catch (err) {
    throw new HttpError("Could not create a new user", 500);
  }

  let image;
  if (!metadata.file) {
    image = chooseRandomAvatar();
  } else {
    image = metadata.file;
  }

  const { purchaseDate, expireDate } = calculatePurchaseAndExpireDates(1);
  const joinDate = await resolveJoinDate(subscriptionId, [
    stripeRegion,
    DEFAULT_REGION,
  ]);

  const createdUser = new AlumniUser({
    status:
      paymentStatus === "unpaid"
        ? USER_STATUSES[PAYMENT_AWAITING]
        : USER_STATUSES[ACTIVE],
    subscription: {
      period,
      id: subscriptionId,
      customerId,
      stripeRegion,
    },
    tier,
    joinDate,
    purchaseDate,
    expireDate,
    image,
    name,
    surname,
    phone,
    email,
    password: hashedPassword,
    notificationTerms,
    notificationTypeTerms: notificationTerms
      ? notificationTypeTerms || "whatsapp & email"
      : undefined,
    tickets: [],
    roles: [ALUMNI],
  });

  try {
    await createdUser.save();
  } catch (err) {
    throw new HttpError("Signing up failed", 500);
  }

  sync();
  notify(email, name);

  // Update alumni statistics (background job, non-blocking)
  recount();

  return { success: true };
};

/**
 * Handle regular user signup checkout session
 */
export const handleUserSignup = async (metadata, paymentData, {
  resolveJoinDate = resolveJoinDateFromSubscription, notify = welcomeEmail,
  sync = usersToSpreadsheet, recount = recountMemberStatistics,
} = {}) => {
  const { subscriptionId, customerId, paymentStatus, stripeRegion } = paymentData;
  const {
    name,
    region,
    period,
    surname,
    birth,
    phone,
    email: rawEmail,
    university,
    otherUniversityName,
    graduationDate,
    course,
    studentNumber,
    profession,
    notificationTypeTerms,
  } = metadata;
  const email = normalizeEmail(rawEmail);
  if (!email) {
    throw new HttpError("Please send a valid email", 422);
  }

  const password = decryptData(metadata.password);

  let hashedPassword;
  try {
    hashedPassword = await hashPassword(password, { legacyCheckout: true });
  } catch (err) {
    throw new HttpError(err.message, 500);
  }

  let image;
  if (!metadata.file) {
    image = chooseRandomAvatar();
  } else {
    image = metadata.file;
  }

  const { purchaseDate, expireDate } = calculatePurchaseAndExpireDates(period);
  const joinDate = await resolveJoinDate(subscriptionId, [
    stripeRegion,
    region,
    DEFAULT_REGION,
  ]);

  const createdUser = new MemberUser({
    status:
      paymentStatus === "unpaid"
        ? USER_STATUSES[PAYMENT_AWAITING]
        : USER_STATUSES[ACTIVE],
    subscription: {
      period,
      id: subscriptionId,
      customerId,
      stripeRegion,
    },
    region,
    joinDate,
    purchaseDate,
    expireDate,
    image,
    name,
    surname,
    birth: new Date(birth),
    phone,
    email,
    university,
    otherUniversityName: university === "other" ? otherUniversityName : undefined,
    graduationDate: university === "working" ? undefined : graduationDate,
    course: university === "working" ? undefined : course,
    studentNumber: university === "working" ? undefined : studentNumber,
    profession: university === "working" ? profession : undefined,
    password: hashedPassword,
    notificationTypeTerms,
    tickets: [],
  });

  try {
    await createdUser.save();
  } catch (err) {
    throw new HttpError(err.message, 500);
  }

  notify(email, name, region);
  sync(region);
  sync();

  // Update member statistics (background job, non-blocking)
  recount();

  return { success: true };
};

/**
 * Handle account unlock checkout session
 */
/**
 * Handle guest ticket purchase checkout session
 */
export const handleGuestTicketPurchase = async (metadata, paymentData) => {
  const { transactionId } = paymentData;
  let {
    quantity,
    eventId,
    code,
    guestName,
    guestEmail,
    guestPhone,
    preferences,
    addOns,
    type,
  } = metadata;

  let societyEvent;
  try {
    societyEvent = await Event.findById(eventId);
  } catch (err) {
    throw new HttpError(err.message, 500);
  }

  addOns = addOns !== undefined ? JSON.parse(addOns) : [];

  let guest = {
    type: type ?? "guest",
    code,
    // Every row of this purchase carries the QR token printed on its image.
    ticketToken: metadata.ticketToken,
    transactionId,
    name: guestName,
    email: guestEmail,
    phone: guestPhone,
    preferences,
    addOns,
    ticket: metadata.file,
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
      throw new HttpError(err.message, 500);
    }
  }

  const tickets = Array.from({ length: quantity }, () => metadata.file);

  sendTicketEmail(
    "guest",
    guestEmail,
    societyEvent.title,
    societyEvent.date,
    guestName,
    tickets
  );

  eventToSpreadsheet(societyEvent.id);

  return { success: true };
};

/**
 * Handle member ticket purchase checkout session
 */
export const handleMemberTicketPurchase = async (metadata, paymentData) => {
  const { transactionId, stripeRegion } = paymentData;
  const { eventId, userId, code, preferences } = metadata;
  let societyEvent;
  try {
    societyEvent = await Event.findById(eventId);
  } catch (err) {
    throw new HttpError(err.message, 500);
  }

  if (!societyEvent) {
    throw new HttpError("Could not find such event", 404);
  }

  let targetUser;
  try {
    targetUser = await findUserById(userId);
  } catch (err) {
    throw new HttpError(err.message, 500);
  }

  if (!targetUser) {
    throw new HttpError("Could not find ticket account", 404);
  }

  // A checkout may complete after an administrator or billing reconciliation
  // restricts the account. Fulfil it as a guest so no member benefit or member
  // ticket record is retained for a non-active account.
  if (isRestrictedTicketAccount(targetUser)) {
    return handleGuestTicketPurchase({
      ...metadata,
      method: "buy_guest_ticket",
      type: "guest",
      userId: "",
      memberPriceApplied: "false",
      guestName: [targetUser?.name, targetUser?.surname].filter(Boolean).join(" ") || "Guest",
      guestEmail: targetUser?.email || "",
      guestPhone: targetUser?.phone || "Not provided",
    }, paymentData);
  }

  const addOns = metadata?.addOns ? JSON.parse(metadata?.addOns) : [];
  const memberPriceApplied = isMemberPriceCheckout(metadata);
  const guest = {
    type: memberPriceApplied ? "member" : "guest",
    userId: String(userId),
    memberPriceApplied,
    code,
    ticketToken: metadata.ticketToken,
    transactionId,
    name: targetUser.name + " " + targetUser.surname,
    email: targetUser.email,
    phone: targetUser.phone,
    preferences,
    addOns,
    ticket: metadata.file,
  };
  const userTicket = {
    event:
      societyEvent.title +
      " | " +
      moment(societyEvent.date).format(MOMENT_DATE_YEAR),
    image: metadata.file,
  };

  const eventQuery = { _id: eventId };
  if (memberPriceApplied) {
    eventQuery.guestList = {
      $not: {
        $elemMatch: memberTicketDuplicateMatcher({
          userId,
          userIds: targetUser.accountAliases,
          email: targetUser.email,
        }),
      },
    };
  }

  let updatedEvent = null;
  const databaseSession = await mongoose.startSession();
  try {
    await databaseSession.withTransaction(async () => {
      updatedEvent = await Event.findOneAndUpdate(
        eventQuery,
        { $push: { guestList: guest } },
        { new: true, session: databaseSession }
      );

      if (!updatedEvent) return;

      await targetUser.constructor.updateOne(
        { _id: targetUser._id },
        { $push: { tickets: userTicket } },
        { session: databaseSession }
      );


    });
  } catch (err) {
    throw new HttpError(err.message, 500);
  } finally {
    await databaseSession.endSession();
  }

  if (!updatedEvent) {
    const refunded = memberPriceApplied
      ? await refundDuplicateMemberTicket({
        transactionId,
        eventId,
        userId,
        region: stripeRegion || societyEvent.region,
      })
      : false;

    return { success: true, duplicate: true, refunded };
  }

  societyEvent = updatedEvent;

  sendTicketEmail(
    "member",
    targetUser.email,
    societyEvent.title,
    societyEvent.date,
    targetUser.name,
    metadata.file
  );

  eventToSpreadsheet(societyEvent.id);

  return { success: true };
};

/**
 * Handle alumni migration checkout session
 */
// Subscription lifecycle and account changes are reconciled centrally in
// services/subscriptions. No customer-only fallback or date arithmetic here.

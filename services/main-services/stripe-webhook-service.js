import bcrypt from "bcryptjs";
import HttpError from "../../models/Http-error.js";
import mongoose from "mongoose";
import Event from "../../models/Event.js";
import User from "../../models/User.js";
import AlumniUser from "../../models/AlumniUser.js";
import {
  paymentFailedEmail,
  sendTicketEmail,
  welcomeEmail,
  alumniWelcomeEmail,
} from "../background-services/email-transporter.js";
import {
  alumniToSpreadsheet,
  eventToSpreadsheet,
  usersToSpreadsheet,
} from "../background-services/google-spreadsheets.js";
import { findUserByQuery, findUserById } from "./user-service.js";
import {
  chooseRandomAvatar,
  decryptData,
  hasOverlap,
} from "../../util/functions/helpers.js";
import {
  MOMENT_DATE_YEAR,
  calculatePurchaseAndExpireDates,
} from "../../util/functions/dateConvert.js";
import {
  ADMIN,
  ALUMNI,
  DEFAULT_REGION,
  LIMITLESS_ACCOUNT,
  SUBSCRIPTION_PERIOD_BY_ID,
  USER_URL,
  ALUMNI_TIER_BY_PRICE_ID,
  ALUMNI_PRICE_TIER_1,
  ALUMNI_PRICE_TIER_1_OLD,
  ALUMNI_PRICE_TIER_2,
  ALUMNI_PRICE_TIER_2_OLD,
  ALUMNI_PRICE_TIER_3,
  ALUMNI_PRICE_TIER_3_OLD,
  ALUMNI_PRICE_TIER_4,
  ALUMNI_PRICE_TIER_4_OLD,
  SUBSCRIPTION_PRICE_YEAR_1,
  SUBSCRIPTION_PRICE_MONTHS_6,
  SUBSCRIPTIONS,
} from "../../util/config/defines.js";
import moment from "moment";
import {
  ACTIVE,
  ALUMNI_MIGRATED,
  LOCKED,
  PAYMENT_AWAITING,
  USER_STATUSES,
} from "../../util/config/enums.js";
import { createStripeClient } from "../../util/config/stripe.js";

/**
 * Handle alumni signup checkout session
 */
export const handleAlumniSignup = async (metadata, paymentData) => {
  const { subscriptionId, customerId, paymentStatus } = paymentData;
  const { tier, period, name, surname, email } = metadata;

  const password = decryptData(metadata.password);

  let hashedPassword;
  try {
    hashedPassword = await bcrypt.hash(password, 12);
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

  const createdUser = new AlumniUser({
    status:
      paymentStatus === "unpaid"
        ? USER_STATUSES[PAYMENT_AWAITING]
        : USER_STATUSES[ACTIVE],
    subscription: {
      period,
      id: subscriptionId,
      customerId,
    },
    tier,
    purchaseDate,
    expireDate,
    image,
    name,
    surname,
    email,
    password: hashedPassword,
    tickets: [],
    roles: [ADMIN],
  });

  try {
    await createdUser.save();
  } catch (err) {
    throw new HttpError("Signing up failed", 500);
  }

  alumniToSpreadsheet();
  alumniWelcomeEmail(email, name);

  return { success: true };
};

/**
 * Handle regular user signup checkout session
 */
export const handleUserSignup = async (metadata, paymentData) => {
  const { subscriptionId, customerId, paymentStatus } = paymentData;
  const {
    longTerm,
    name,
    region,
    period,
    surname,
    birth,
    phone,
    email,
    university,
    otherUniversityName,
    graduationDate,
    course,
    studentNumber,
    notificationTypeTerms,
  } = metadata;

  const password = decryptData(metadata.password);

  let hashedPassword;
  try {
    hashedPassword = await bcrypt.hash(password, 12);
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

  const createdUser = new User({
    status:
      paymentStatus === "unpaid"
        ? USER_STATUSES[PAYMENT_AWAITING]
        : USER_STATUSES[ACTIVE],
    subscription: {
      period,
      id: subscriptionId,
      customerId,
    },
    region,
    purchaseDate,
    expireDate,
    image,
    name,
    surname,
    birth: new Date(birth),
    phone,
    email,
    university,
    otherUniversityName,
    graduationDate,
    course,
    studentNumber,
    password: hashedPassword,
    notificationTypeTerms,
    tickets: [],
  });

  try {
    await createdUser.save();
  } catch (err) {
    throw new HttpError(err.message, 500);
  }

  welcomeEmail(email, name, region);
  usersToSpreadsheet(region);
  usersToSpreadsheet();

  return { success: true };
};

/**
 * Handle account unlock checkout session
 */
export const handleAccountUnlock = async (metadata, paymentData) => {
  const { subscriptionId, customerId, paymentStatus } = paymentData;
  const userId = metadata.userId;
  const period = metadata.period;

  let user;
  try {
    user = await findUserById(userId);
  } catch (err) {
    throw new HttpError(err.message, 500);
  }

  user.status =
    paymentStatus === "unpaid"
      ? USER_STATUSES[PAYMENT_AWAITING]
      : USER_STATUSES[ACTIVE];

  user.subscription = {
    period,
    id: subscriptionId,
    customerId,
  };

  const { purchaseDate, expireDate } = calculatePurchaseAndExpireDates(period);

  user.purchaseDate = purchaseDate;
  user.expireDate = expireDate;

  try {
    await user.save();
  } catch (err) {
    throw new HttpError(err.message, 500);
  }

  usersToSpreadsheet(user.region);
  usersToSpreadsheet();

  return { success: true };
};

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

  sendTicketEmail(
    "guest",
    guestEmail,
    societyEvent.title,
    societyEvent.date,
    guestName,
    metadata.file
  );

  eventToSpreadsheet(societyEvent.id);

  return { success: true };
};

/**
 * Handle member ticket purchase checkout session
 */
export const handleMemberTicketPurchase = async (metadata, paymentData) => {
  const { transactionId } = paymentData;
  const { eventId, userId, code, preferences, type } = metadata;
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
    targetUser = await findUserByQuery({ _id: userId });
  } catch (err) {
    throw new HttpError(err.message, 500);
  }

  const addOns = metadata?.addOns ? JSON.parse(metadata?.addOns) : [];

  try {
    const sess = await mongoose.startSession();
    sess.startTransaction();
    societyEvent.guestList.push({
      type: type ?? "member",
      code,
      transactionId,
      name: targetUser.name + " " + targetUser.surname,
      email: targetUser.email,
      phone: targetUser.phone,
      preferences,
      addOns,
      ticket: metadata.file,
    });

    targetUser.tickets.push({
      event:
        societyEvent.title +
        " | " +
        moment(societyEvent.date).format(MOMENT_DATE_YEAR),
      image: metadata.file,
    });

    await societyEvent.save();
    await targetUser.save();
    await sess.commitTransaction();
  } catch (err) {
    throw new HttpError(err.message, 500);
  }

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
export const handleAlumniMigration = async (metadata, paymentData) => {
  const { subscriptionId, customerId, paymentStatus } = paymentData;
  const { userId, tier, period } = metadata;

  // Find the regular user
  let regularUser;
  try {
    regularUser = await findUserById(userId);

    if (!regularUser) {
      console.error(`No user found with ID: ${userId}`);
      return {
        success: false,
        message: "User not found for migration",
      };
    }

    if (regularUser?.subscription?.id !== undefined) {
      return {
        success: false,
        message: "User already has a subscription",
      };
    }
  } catch (err) {
    console.error(`Error finding user: ${err.message}`);
    return {
      success: false,
      message: "Error finding user for migration",
    };
  }

  // Extract the ObjectId part if the user already has a prefixed ID
  let objectIdPart;
  if (
    typeof regularUser._id === "string" &&
    regularUser._id.includes("member_")
  ) {
    const idMatch = regularUser._id.match(/member_(.*)/);
    if (idMatch && idMatch[1]) {
      objectIdPart = idMatch[1];
    } else {
      console.error(`ID format invalid: ${regularUser._id}`);
      return {
        success: false,
        message: "Invalid user ID format for migration",
      };
    }
  } else {
    // If the user has a regular ObjectId, convert it to string
    objectIdPart = regularUser._id.toString();
  }

  // Create the alumni ID with the same ObjectId part
  const alumniId = `alumni_${objectIdPart}`;

  // Check if we need to cancel an existing subscription
  let oldSubscriptionId = null;
  if (regularUser.subscription && regularUser.subscription.id) {
    oldSubscriptionId = regularUser.subscription.id;

    // Cancel old subscription
    try {
      const stripeClient = createStripeClient(
        regularUser.region || DEFAULT_REGION
      );
      await stripeClient.subscriptions.cancel(oldSubscriptionId);
      console.log(
        `Cancelled subscription ${oldSubscriptionId} for user ${userId}`
      );
    } catch (err) {
      console.error(`Error cancelling subscription: ${err.message}`);
      // Continue with the migration even if cancellation fails
    }
  }

  const { purchaseDate, expireDate } = calculatePurchaseAndExpireDates(
    period || 12
  );

  // Check if an alumni user already exists
  let existingAlumni;
  try {
    existingAlumni = await AlumniUser.findOne({
      $or: [{ _id: alumniId }, { email: regularUser.email }],
    });
  } catch (err) {
    console.error(`Error checking existing alumni: ${err.message}`);
  }

  let alumniUser;

  try {
    if (existingAlumni) {
      // Update existing alumni user
      existingAlumni.status =
        paymentStatus === "unpaid"
          ? USER_STATUSES[PAYMENT_AWAITING]
          : USER_STATUSES[ACTIVE];
      existingAlumni.name = regularUser.name;
      existingAlumni.surname = regularUser.surname;
      existingAlumni.email = regularUser.email;
      existingAlumni.image = regularUser.image || "";
      existingAlumni.status = USER_STATUSES[ACTIVE];
      existingAlumni.tier = tier || 0;
      existingAlumni.subscription = {
        period,
        id: subscriptionId,
        customerId,
      };
      existingAlumni.purchaseDate = purchaseDate;
      existingAlumni.expireDate = expireDate;
      existingAlumni.joinDate = existingAlumni.joinDate || new Date();

      // Make sure the alumni role is set
      if (!existingAlumni.roles.includes(ALUMNI)) {
        existingAlumni.roles.push(ALUMNI);
      }

      await existingAlumni.save();
      alumniUser = existingAlumni;
      console.log(`Updated alumni user ${alumniId} for migration`);
    } else {
      // Create new alumni user
      const newAlumniUser = new AlumniUser({
        _id: alumniId,
        name: regularUser.name,
        surname: regularUser.surname,
        email: regularUser.email,
        password: regularUser.password,
        image: regularUser.image || "",
        status:
          paymentStatus === "unpaid"
            ? USER_STATUSES[PAYMENT_AWAITING]
            : USER_STATUSES[ACTIVE],
        tier: tier || 0,
        roles: [ALUMNI],
        subscription: {
          period,
          id: subscriptionId,
          customerId,
        },
        joinDate: new Date(),
        purchaseDate,
        expireDate,
        tickets: regularUser.tickets || [],
        christmas: regularUser.christmas || [],
      });

      await newAlumniUser.save();
      alumniUser = newAlumniUser;
      console.log(`Created new alumni user ${alumniId} for migration`);
    }

    // Update regular user status to alumni
    regularUser.status = USER_STATUSES[ALUMNI_MIGRATED];
    await regularUser.save();

    // Update spreadsheets
    alumniToSpreadsheet();
    usersToSpreadsheet(regularUser.region);
    usersToSpreadsheet();

    // Send welcome email
    alumniWelcomeEmail(regularUser.email, regularUser.name);

    return {
      success: true,
      message: "User successfully migrated to alumni",
      details: {
        userId: regularUser._id,
        alumniId: alumniUser._id,
        oldSubscription: oldSubscriptionId,
        newSubscription: subscriptionId,
      },
    };
  } catch (err) {
    console.error(`Error during migration: ${err.message}`);
    return {
      success: false,
      error: `Migration failed: ${err.message}`,
    };
  }
};

/**
 * Handle invoice paid event
 */
export const handleInvoicePaid = async (paymentData, event) => {
  const { subscriptionId, customerId } = paymentData;
  console.log(
    `handleInvoicePaid - SubscriptionId: ${subscriptionId}, CustomerId: ${customerId}`
  );

  if (!subscriptionId || !customerId) {
    console.log("Missing subscriptionId or customerId in invoice.paid event");
    return {
      success: false,
      message: "No user to update",
      debug: {
        subscriptionId,
        customerId,
        eventType: "invoice.paid",
        priceId:
          event?.data?.object?.lines?.data?.[0]?.price?.id || "not found",
      },
    };
  }

  let user;
  try {
    user = await findUserByQuery({ "subscription.id": subscriptionId });
    console.log(`Found user by subscription.id: ${user ? user.email : "none"}`);
  } catch (err) {
    console.error(`Error finding user by subscription.id: ${err.message}`);
    return {
      success: false,
      message: "Error finding user by subscription ID",
      debug: {
        subscriptionId,
        customerId,
        error: err.message,
        searchMethod: "subscription.id",
      },
    };
  }

  if (!user) {
    try {
      user = await findUserByQuery({ "subscription.customerId": customerId });
      console.log(
        `Found user by subscription.customerId: ${user ? user.email : "none"}`
      );
    } catch (err) {
      console.error(
        `Error finding user by subscription.customerId: ${err.message}`
      );
      return {
        success: false,
        message: "Error finding user by customer ID",
        debug: {
          subscriptionId,
          customerId,
          error: err.message,
          searchMethod: "subscription.customerId",
        },
      };
    }
  }

  if (!user) {
    console.log("No user found with either subscription ID or customer ID");
    return {
      success: false,
      message: "No user found with provided subscription or customer ID",
      debug: {
        subscriptionId,
        customerId,
        searchAttempts: ["subscription.id", "subscription.customerId"],
      },
    };
  }

  const priceId = event.data.object.lines.data[0].price.id || "";
  const period = user.subscription.period ?? 12;

  const { purchaseDate, expireDate } = calculatePurchaseAndExpireDates(period);

  user.status = USER_STATUSES[ACTIVE];
  user.purchaseDate = purchaseDate;
  user.expireDate = expireDate;

  try {
    await user.save();
  } catch (err) {
    throw new HttpError(err.message, 500);
  }

  usersToSpreadsheet(user.region);
  usersToSpreadsheet();

  console.log(`Successfully processed invoice.paid for user: ${user.email}`);
  return {
    success: true,
    debug: {
      userId: user._id,
      userEmail: user.email,
      userRegion: user.region,
      priceId,
      period,
      purchaseDate,
      expireDate,
    },
  };
};

/**
 * Handle invoice payment failed event
 */
export const handleInvoicePaymentFailed = async (paymentData) => {
  const { subscriptionId, customerId } = paymentData;
  console.log(
    `handleInvoicePaymentFailed - SubscriptionId: ${subscriptionId}, CustomerId: ${customerId}`
  );

  if (!subscriptionId || !customerId) {
    console.log(
      "Missing subscriptionId or customerId in invoice.payment_failed event"
    );
    return { success: false, message: "No user to update" };
  }

  let user;
  try {
    user = await findUserByQuery({ "subscription.id": subscriptionId });
  } catch (err) {
    return { success: false, message: "No user to update" };
  }

  if (!user) {
    try {
      user = await findUserByQuery({ "subscription.customerId": customerId });
    } catch (err) {
      return { success: false, message: "No user to update" };
    }
  }

  if (!user) {
    return { success: false, message: "No user to update" };
  }

  const today = new Date();
  const isUserLocked = user.status === USER_STATUSES[LOCKED];

  if (
    !isUserLocked &&
    !hasOverlap(LIMITLESS_ACCOUNT, user?.roles) &&
    today > user.expireDate
  ) {
    user.status = USER_STATUSES[LOCKED];

    try {
      await user.save();
    } catch (err) {
      throw new HttpError(err.message, 500);
    }

    try {
      usersToSpreadsheet(user.region);
      usersToSpreadsheet();
      paymentFailedEmail(user.email, USER_URL);
    } catch (err) {
      console.log(err);
    }
  }

  return { success: true };
};

/**
 * Handle customer subscription updated event
 */
export const handleSubscriptionUpdated = async (paymentData, event) => {
  const { subscriptionId, customerId } = paymentData;
  console.log(
    `handleSubscriptionUpdated - SubscriptionId: ${subscriptionId}, CustomerId: ${customerId}`
  );

  if (!subscriptionId || !customerId) {
    console.log(
      "Missing subscriptionId or customerId in customer.subscription.updated event"
    );
    return { success: false, message: "No subscription to update" };
  }

  // Get the new price ID from the subscription
  const newPriceId = event.data.object.items.data[0]?.price?.id;

  if (!newPriceId) {
    return { success: false, message: "No price ID found in subscription" };
  }

  switch (newPriceId) {
    // alumni update
    case ALUMNI_PRICE_TIER_1:
    case ALUMNI_PRICE_TIER_1_OLD:
    case ALUMNI_PRICE_TIER_2:
    case ALUMNI_PRICE_TIER_2_OLD:
    case ALUMNI_PRICE_TIER_3:
    case ALUMNI_PRICE_TIER_3_OLD:
    case ALUMNI_PRICE_TIER_4:
    case ALUMNI_PRICE_TIER_4_OLD:
      const newTier = ALUMNI_TIER_BY_PRICE_ID[newPriceId];

      if (!newTier) {
        return {
          success: false,
          message: "Price ID not found in alumni mapping",
        };
      }

      // Find the alumni user by subscription ID or customer ID
      let alumniUser;
      try {
        alumniUser = await AlumniUser.findOne({
          $or: [
            { "subscription.id": subscriptionId },
            { "subscription.customerId": customerId },
          ],
        });
      } catch (err) {
        console.error(`Error finding alumni user: ${err.message}`);
        return { success: false, message: "Error finding alumni user" };
      }

      if (!alumniUser) {
        return {
          success: false,
          message: "No alumni user found for this subscription",
        };
      }

      // Update the tier
      const oldTier = alumniUser.tier;
      alumniUser.tier = newTier;

      try {
        await alumniUser.save();
        console.log(
          `Updated alumni user ${alumniUser._id} tier from ${oldTier} to ${newTier}`
        );

        // Update spreadsheets
        alumniToSpreadsheet();

        return {
          success: true,
          message: `Alumni tier updated from ${oldTier} to ${newTier}`,
          details: {
            alumniId: alumniUser._id,
            oldTier,
            newTier,
            priceId: newPriceId,
          },
        };
      } catch (err) {
        console.error(`Error updating alumni user tier: ${err.message}`);
        return { success: false, message: "Error updating alumni user tier" };
      }

    case SUBSCRIPTION_PRICE_MONTHS_6:
    case SUBSCRIPTION_PRICE_YEAR_1:
      const newSubscription = SUBSCRIPTIONS.find(
        (subscription) => subscription.id === newPriceId
      );

      if (!newSubscription) {
        return {
          success: false,
          message: "Price ID not found in subscription mapping",
        };
      }

      // Find the member user by subscription ID or customer ID
      let user;
      try {
        user = await User.findOne({
          $or: [
            { "subscription.id": subscriptionId },
            { "subscription.customerId": customerId },
          ],
        });
      } catch (err) {
        console.error(`Error finding member user: ${err.message}`);
        return { success: false, message: "Error finding member user" };
      }

      if (!user) {
        return {
          success: false,
          message: "No member user found for this subscription",
        };
      }

      // Update the period
      const oldPeriod = user.subscription.period;
      user.subscription.period = newSubscription.period;

      try {
        await user.save();
        console.log(
          `Updated member user ${user._id} tier from ${oldPeriod} to ${newSubscription.period}`
        );

        // Update spreadsheets
        usersToSpreadsheet();

        return {
          success: true,
          message: `Member tier updated from ${oldPeriod} to ${newSubscription.period}`,
          details: {
            userId: user._id,
            oldPeriod,
            newPeriod: newSubscription.period,
            priceId: newPriceId,
          },
        };
      } catch (err) {
        console.error(`Error updating member user tier: ${err.message}`);
        return { success: false, message: "Error updating member user tier" };
      }

    default:
      return {
        success: false,
        message: "Price ID not found in mapping for subscription update",
      };
  }
};

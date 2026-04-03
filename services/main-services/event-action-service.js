import moment from "moment";
import mongoose from "mongoose";
import HttpError from "../../models/Http-error.js";
import Event from "../../models/Event.js";
import User from "../../models/User.js";
import AlumniUser from "../../models/AlumniUser.js";
import { addPrice, addProduct, refundStripePayment } from "../side-services/stripe.js";
import { MOMENT_DATE_YEAR } from "../../util/functions/dateConvert.js";
import { DEFAULT_REGION } from "../../util/config/defines.js";

export const createEventProductWithPrice = async (
  data,
  guestPrice = 0,
  memberPrice = 0,
  activeMemberPrice = 0
) => {
  const productId = await addProduct({
    name: data["name"],
    image: data["image"],
    region: data["region"],
    date: data["date"],
  });

  if (!productId) {
    return false;
  }

  const guestPriceId = await addPrice(
    data["region"],
    productId,
    guestPrice,
    "guest"
  );
  const memberPriceId = await addPrice(
    data["region"],
    productId,
    memberPrice,
    "member"
  );
  const activeMemberPriceId = await addPrice(
    data["region"],
    productId,
    activeMemberPrice,
    "active member"
  );

  const product = {
    id: productId,
  };

  if (guestPriceId) {
    product.guest = {
      price: guestPrice,
      priceId: guestPriceId,
    };
  }

  if (memberPriceId) {
    product.member = {
      price: memberPrice,
      priceId: memberPriceId,
    };
  }

  if (activeMemberPriceId) {
    product.activeMember = {
      price: activeMemberPrice,
      priceId: activeMemberPriceId,
    };
  }

  // no prices
  if (Object.keys(product).length === 1) {
    return false;
  }

  return product;
};

export const updateEventPrices = async (
  region,
  product,
  guestPrice = 0,
  memberPrice = 0,
  activeMemberPrice = 0
) => {
  if (guestPrice && (!product.guest || product.guest?.price != guestPrice)) {
    const guestPriceId = await addPrice(
      region,
      product.id,
      guestPrice,
      "guest"
    );

    if (guestPriceId) {
      product.guest = {
        price: guestPrice,
        priceId: guestPriceId,
      };
    }
  }

  if (
    memberPrice > 0 &&
    (!product.member || product.member.price != memberPrice)
  ) {
    const memberPriceId = await addPrice(
      region,
      product.id,
      memberPrice,
      "member"
    );

    if (memberPriceId) {
      product.member = {
        price: memberPrice,
        priceId: memberPriceId,
      };
    }
  }

  if (
    activeMemberPrice > 0 &&
    (!product.activeMember || product.activeMember.price != activeMemberPrice)
  ) {
    const activeMemberPriceId = await addPrice(
      region,
      product.id,
      activeMemberPrice,
      "active member"
    );

    if (activeMemberPriceId) {
      product.activeMember = {
        price: activeMemberPrice,
        priceId: activeMemberPriceId,
      };
    }
  }

  return product;
};

export const checkDiscountsOnEvents = (event) => {
  if (!event.product) {
    return event;
  }

  let guestDiscounted = false;
  let memberDiscounted = false;

  if (
    event?.promotion &&
    event?.promotion?.guest?.isEnabled &&
    event?.promotion?.guest?.startTimer < new Date() &&
    event?.promotion?.guest?.endTimer > new Date()
  ) {
    guestDiscounted = true;

    const discountedPrice =
      Math.round(
        event.product.guest.price * (100 - event.promotion.guest.discount)
      ) / 100;

    event.product["guest"] = {
      discount: event.promotion.guest.discount,
      originalPrice: event.product.guest.price,
      price: discountedPrice,
      priceId: event.promotion.guest.priceId,
    };
  }

  if (
    event?.promotion &&
    event?.promotion?.member?.isEnabled &&
    event?.promotion?.member?.startTimer < new Date() &&
    event?.promotion?.member?.endTimer > new Date()
  ) {
    memberDiscounted = true;

    const discountedPrice =
      Math.round(
        event.product.member.price * (100 - event.promotion.member.discount)
      ) / 100;

    event.product["member"] = {
      discount: event.promotion.member.discount,
      originalPrice: event.product.member.price,
      price: discountedPrice,
      priceId: event.promotion.member.priceId,
    };
  }

  if (guestDiscounted && memberDiscounted) {
    return event;
  }

  // Helper function to check if a bird condition is met
  const checkBirdCondition = (bird, event) => {
    if (!bird || !bird.isEnabled) {
      return false;
    }

    // Calculate guest count (considering excludeMembers)
    let guestCount = event?.guestList?.length ?? 0;
    if (bird.excludeMembers && guestCount > 0) {
      guestCount = event.guestList.filter((g) => g.type !== "member").length;
    }

    // Check timer condition
    const startTimer = bird.startTimer;
    const ticketTimer = bird.ticketTimer; // This is the end timer
    const now = moment();

    // Check if both timers are empty/null/undefined
    const hasStartTimer =
      startTimer && startTimer !== "" && startTimer !== null;
    const hasTicketTimer =
      ticketTimer && ticketTimer !== null && ticketTimer !== undefined;
    const hasNoTimerValues = !hasStartTimer && !hasTicketTimer;

    // Check if timer condition is met
    let timerMet = false;
    if (hasNoTimerValues) {
      // If both timers have no values, timer condition is met (no restrictions)
      timerMet = true;
    } else {
      let startTimerMet = false; // Default to true if not provided
      let ticketTimerMet = false; // Default to true if not provided

      if (hasStartTimer) {
        // startTimer should be in the past (event has started)
        startTimerMet = moment(startTimer).isBefore(now);
      }

      if (hasTicketTimer) {
        // ticketTimer (end timer) should be in the future (event hasn't ended)
        ticketTimerMet = moment(ticketTimer).isAfter(now);
      }

      // At least one timer conditions must be met
      timerMet = startTimerMet || ticketTimerMet;
    }

    // Check limit condition
    const ticketLimit = bird.ticketLimit;
    const hasNoLimitValue =
      ticketLimit === null || ticketLimit === undefined || ticketLimit === "";

    // Check if limit condition is met
    let limitMet = false;
    if (hasNoLimitValue) {
      // If no limit value, limit condition is met (no restrictions)
      limitMet = true;
    } else if (ticketLimit > guestCount) {
      // If limit exists and is greater than guest count, condition is met
      limitMet = true;
    }

    // Special case: If both timer and limit have no values, condition is NOT met
    if (hasNoTimerValues && hasNoLimitValue) {
      return false;
    }

    // Both conditions must be met
    return timerMet && limitMet;
  };

  // Check early bird first (priority if both are met)
  let earlyBirdMet = false;
  let lateBirdMet = false;

  if (event?.earlyBird) {
    earlyBirdMet = checkBirdCondition(event.earlyBird, event);
  }

  if (event?.lateBird) {
    lateBirdMet = checkBirdCondition(event.lateBird, event);
  }

  // Apply early bird if condition is met (priority over late bird)
  if (earlyBirdMet) {
    const earlyBird = event.earlyBird;
    event.product["earlyBird"] = true;
    event.product["lateBird"] = false;

    event.product["guest"] = {
      price: earlyBird.price,
      priceId: earlyBird.priceId,
    };
    event.product["member"] = {
      price: earlyBird.memberPrice,
      priceId: earlyBird.memberPriceId,
    };

    return event;
  }

  // Apply late bird if condition is met
  if (lateBirdMet) {
    const lateBird = event.lateBird;
    event.product["earlyBird"] = false;
    event.product["lateBird"] = true;

    event.product["guest"] = {
      price: lateBird.price,
      priceId: lateBird.priceId,
    };
    event.product["member"] = {
      price: lateBird.memberPrice,
      priceId: lateBird.memberPriceId,
    };

    return event;
  }

  // Neither condition is met
  event.product["earlyBird"] = false;
  event.product["lateBird"] = false;

  return event;
};

/**
 * Validates if a promocode can be applied to a purchase
 * @param {object} promocode - The promocode object from the event
 * @param {number} totalAmount - The purchase amount in euros
 * @returns {object} - { valid: boolean, reason: string, discountedAmount: number }
 */
export const validatePromocodeForPurchase = (promocode, totalAmount) => {
  // Check if promocode is active
  if (!promocode.active) {
    return {
      valid: false,
      reason: "This promocode is no longer active",
      discountedAmount: totalAmount,
    };
  }

  // Check if promocode has expired
  if (promocode.timeLimit) {
    const now = new Date();
    const expirationDate = new Date(promocode.timeLimit);
    if (now > expirationDate) {
      return {
        valid: false,
        reason: "This promocode has expired",
        discountedAmount: totalAmount,
      };
    }
  }

  // Check minimum amount requirement
  if (promocode.minAmount && totalAmount < promocode.minAmount) {
    return {
      valid: false,
      reason: `This promocode requires a minimum purchase of €${promocode.minAmount}`,
      discountedAmount: totalAmount,
    };
  }

  // Calculate discounted amount
  let discountedAmount = totalAmount;
  if (promocode.discountType === 1) {
    // Fixed amount discount
    discountedAmount = Math.max(0, totalAmount - promocode.discount);
  } else if (promocode.discountType === 2) {
    // Percentage discount
    discountedAmount = totalAmount * (1 - promocode.discount / 100);
  }

  return {
    valid: true,
    reason: "",
    discountedAmount: Math.round(discountedAmount * 100) / 100, // Round to 2 decimals
    discountAmount: Math.round((totalAmount - discountedAmount) * 100) / 100,
  };
};

/**
 * Finds a promocode by code string in an event's promocodes array
 * @param {object} event - The event object
 * @param {string} code - The promocode string to find
 * @returns {object|null} - The promocode object or null if not found
 */
export const findPromocodeByCode = (event, code) => {
  if (!event?.product?.promoCodes || event.product.promoCodes.length === 0) {
    return null;
  }

  const upperCode = code.trim().toUpperCase();
  return event.product.promoCodes.find(
    (promo) => promo.code === upperCode && promo.active !== false
  ) || null;
};

/**
 * Gets the applicable price for a user type, considering active discounts
 * This includes early bird, late bird, and promotion discounts
 * @param {object} event - The event object (after checkDiscountsOnEvents)
 * @param {string} userType - 'guest', 'member', or 'activeMember'
 * @returns {object} - { price: number, priceId: string, discountInfo: object }
 */
export const getApplicablePrice = (event, userType = 'guest') => {
  if (!event?.product) {
    return null;
  }

  const product = event.product;
  
  // Map userType to product properties
  const typeMapping = {
    guest: 'guest',
    member: 'member',
    activeMember: 'activeMember',
  };

  const priceType = typeMapping[userType] || 'guest';
  const priceInfo = product[priceType];

  if (!priceInfo) {
    return null;
  }

  return {
    price: priceInfo.price,
    priceId: priceInfo.priceId,
    discountInfo: {
      hasDiscount: priceInfo.discount ? true : false,
      originalPrice: priceInfo.originalPrice,
      discountPercentage: priceInfo.discount,
      isEarlyBird: product.earlyBird || false,
      isLateBird: product.lateBird || false,
    },
  };
};

/**
 * Calculates final price after applying promocode
 * @param {object} event - The event object
 * @param {string} userType - 'guest', 'member', or 'activeMember'
 * @param {string} promocodeString - The promocode to apply (optional)
 * @returns {object} - Complete pricing information
 */
export const calculateFinalPrice = (event, userType = 'guest', promocodeString = null) => {
  // Get the base price (with early bird / late bird / promotion applied)
  const eventWithDiscounts = checkDiscountsOnEvents(event);
  const priceInfo = getApplicablePrice(eventWithDiscounts, userType);

  if (!priceInfo) {
    return {
      valid: false,
      error: "Price not available for this user type",
    };
  }

  let finalPrice = priceInfo.price;
  let priceId = priceInfo.priceId;
  let promocodeInfo = null;

  // Apply promocode if provided
  if (promocodeString) {
    const promocode = findPromocodeByCode(eventWithDiscounts, promocodeString);
    
    if (!promocode) {
      return {
        valid: false,
        error: "Invalid promocode",
        basePrice: priceInfo.price,
        priceId: priceInfo.priceId,
        discountInfo: priceInfo.discountInfo,
      };
    }

    const validation = validatePromocodeForPurchase(promocode, priceInfo.price);
    
    if (!validation.valid) {
      return {
        valid: false,
        error: validation.reason,
        basePrice: priceInfo.price,
        priceId: priceInfo.priceId,
        discountInfo: priceInfo.discountInfo,
      };
    }

    finalPrice = validation.discountedAmount;
    promocodeInfo = {
      code: promocode.code,
      id: promocode.id,
      couponId: promocode.couponId,
      discountType: promocode.discountType,
      discount: promocode.discount,
      discountAmount: validation.discountAmount,
    };
  }

  return {
    valid: true,
    basePrice: priceInfo.price,
    finalPrice: finalPrice,
    priceId: priceId,
    discountInfo: priceInfo.discountInfo,
    promocodeInfo: promocodeInfo,
    currency: 'EUR',
  };
};

/**
 * Refunds tickets for an event by issuing Stripe refunds and marking guests as refunded.
 * Also removes the ticket from User/AlumniUser.tickets for member-type guests (best-effort).
 *
 * @param {string} eventId - The MongoDB ID of the event
 * @param {string|null} reason - Optional reason for the refund (stored in Stripe metadata and DB)
 * @param {string|null} region - Optional Stripe region to use; defaults to the Netherlands region
 * @param {string[]|null} ids - Optional array of guestList entry IDs to refund; if omitted, all non-refunded guests are processed
 * @returns {{ eventId, summary: { total, refunded, skipped, failed }, results: { success, skipped, failed } }}
 */
export const refundEventTickets = async (eventId, reason = null, region = null, ids = null) => {
  const stripeRegion = region || DEFAULT_REGION;
  console.log(
    `[refundEventTickets] Start | eventId=${eventId} | reason=${reason ?? "none"} | region=${stripeRegion} | targets=${ids ? `[${ids.join(", ")}]` : "all"}`
  );

  let event;
  try {
    event = await Event.findById(eventId);
  } catch (err) {
    console.error(`[refundEventTickets] DB error fetching event ${eventId}:`, err.message);
    throw new HttpError("Could not fetch event", 500);
  }

  if (!event) {
    console.error(`[refundEventTickets] Event not found: ${eventId}`);
    throw new HttpError("Event not found", 404);
  }

  console.log(`[refundEventTickets] Event found: "${event.title}" | event.region=${event.region} | stripeRegion=${stripeRegion} | guestList size=${event.guestList.length}`);

  // Determine which guests to process
  const candidates = ids
    ? event.guestList.filter((g) => ids.includes(g._id.toString()))
    : event.guestList;

  const guestsToRefund = candidates.filter((g) => !g.refunded);
  const alreadyRefunded = candidates.length - guestsToRefund.length;

  if (alreadyRefunded > 0) {
    console.log(`[refundEventTickets] Skipping ${alreadyRefunded} guest(s) already marked as refunded`);
  }

  console.log(`[refundEventTickets] Processing ${guestsToRefund.length} ticket(s)`);

  const results = { success: [], skipped: [], failed: [] };

  for (const guest of guestsToRefund) {
    const guestId = guest._id.toString();

    if (!guest.transactionId || guest.transactionId === "-") {
      // Free or manually added ticket — no Stripe charge to reverse
      console.log(`[refundEventTickets] Guest ${guestId} (${guest.name}) has no transaction — marking refunded without Stripe call`);
      guest.refunded = true;
      if (reason) guest.refundReason = reason;
      results.skipped.push({ id: guestId, name: guest.name, email: guest.email, reason: "no_transaction" });
      continue;
    }

    console.log(`[refundEventTickets] Refunding guest ${guestId} (${guest.name}) | transactionId=${guest.transactionId}`);

    const refundResult = await refundStripePayment(stripeRegion, guest.transactionId, reason);

    if (refundResult.success) {
      console.log(`[refundEventTickets] Stripe refund OK | guest=${guestId} (${guest.name}) | refundId=${refundResult.refundId} | status=${refundResult.status}`);
      guest.refunded = true;
      if (reason) guest.refundReason = reason;
      results.success.push({ id: guestId, name: guest.name, email: guest.email, refundId: refundResult.refundId });
    } else {
      console.error(`[refundEventTickets] Stripe refund FAILED | guest=${guestId} (${guest.name}) | error=${refundResult.error}`);
      results.failed.push({ id: guestId, name: guest.name, email: guest.email, error: refundResult.error });
    }
  }

  // Persist refund status on the event
  try {
    await event.save();
    console.log(`[refundEventTickets] Event ${eventId} saved with updated refund statuses`);
  } catch (err) {
    console.error(`[refundEventTickets] Failed to save event ${eventId}:`, err.message);
    throw new HttpError("Failed to persist refund status", 500);
  }

  // Best-effort: remove tickets from User/AlumniUser.tickets for member-type guests
  const refundedMemberGuests = [...results.success, ...results.skipped].filter((r) => {
    const guest = event.guestList.find((g) => g._id.toString() === r.id);
    return guest && guest.type === "member";
  });

  if (refundedMemberGuests.length > 0) {
    const eventTicketLabel =
      event.title + " | " + moment(event.date).format(MOMENT_DATE_YEAR);

    console.log(`[refundEventTickets] Removing tickets from user profiles for ${refundedMemberGuests.length} member(s) | label="${eventTicketLabel}"`);

    for (const r of refundedMemberGuests) {
      try {
        const sess = await mongoose.startSession();
        sess.startTransaction();

        // Try regular User first, then AlumniUser
        let targetUser = await User.findOne({ email: r.email }).session(sess);
        if (!targetUser) {
          targetUser = await AlumniUser.findOne({ email: r.email }).session(sess);
        }

        if (targetUser) {
          const before = targetUser.tickets.length;
          targetUser.tickets = targetUser.tickets.filter(
            (t) => t.event !== eventTicketLabel
          );
          const removed = before - targetUser.tickets.length;
          await targetUser.save({ session: sess });
          await sess.commitTransaction();
          console.log(`[refundEventTickets] Removed ${removed} ticket(s) from user profile | email=${r.email}`);
        } else {
          await sess.abortTransaction();
          console.log(`[refundEventTickets] No user profile found for email=${r.email} — skipping ticket removal`);
        }

        sess.endSession();
      } catch (err) {
        console.error(`[refundEventTickets] Failed to remove ticket from user profile | email=${r.email}:`, err.message);
        // Non-fatal — Stripe refund already succeeded
      }
    }
  }

  const summary = {
    total: guestsToRefund.length,
    refunded: results.success.length,
    skipped: results.skipped.length,
    failed: results.failed.length,
  };

  console.log(
    `[refundEventTickets] Done | eventId=${eventId} | refunded=${summary.refunded} | skipped=${summary.skipped} | failed=${summary.failed}`
  );

  return { eventId, summary, results };
};

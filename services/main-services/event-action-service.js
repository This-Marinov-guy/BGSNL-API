import { audiencesForPromo } from "../tickets/event-promo-codes.js";
import moment from "moment";
import mongoose from "mongoose";
import HttpError from "../../models/Http-error.js";
import Event from "../../models/Event.js";
import MemberUser from "../../models/MemberUser.js";
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

const ticketPriceValue = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
};

const money = (value) => Math.round(Number(value) * 100) / 100;

const ticketTierKeys = ["guest", "member"];

const birdStagePriority = ["lateBird", "earlyBird"];

const birdStageTierFields = {
  guest: { price: "price", priceId: "priceId" },
  member: { price: "memberPrice", priceId: "memberPriceId" },
};

const cleanTicketTier = (tier) => {
  const price = ticketPriceValue(tier?.price);
  if (price === null) return null;

  return {
    price: tier.price,
    ...(tier.priceId ? { priceId: tier.priceId } : {}),
  };
};

const pricesMatch = (left, right) => {
  const leftValue = ticketPriceValue(left);
  const rightValue = ticketPriceValue(right);
  return leftValue !== null && rightValue !== null && money(leftValue) === money(rightValue);
};

const discountedPrice = (price, discount) => {
  const numericPrice = ticketPriceValue(price);
  const numericDiscount = Number(discount);
  if (numericPrice === null || !Number.isFinite(numericDiscount)) return null;
  return money(numericPrice * (100 - numericDiscount) / 100);
};

const isPromotionActive = (promotion, now) =>
  promotion?.isEnabled === true &&
  promotion.startTimer &&
  promotion.endTimer &&
  new Date(promotion.startTimer) < now &&
  new Date(promotion.endTimer) > now;

const applyPromotionToTier = ({ tier, baseTier, promotion }) => {
  const price = discountedPrice(tier?.price, promotion?.discount);
  if (price === null) return tier;

  const result = {
    discount: promotion.discount,
    originalPrice: tier.price,
    price,
  };

  if (pricesMatch(tier.price, baseTier?.price) && promotion.priceId) {
    result.priceId = promotion.priceId;
  }

  return result;
};

const birdTier = (bird, tierKey) => {
  const fields = birdStageTierFields[tierKey];
  if (!fields) return null;

  return cleanTicketTier({
    price: bird?.[fields.price],
    priceId: bird?.[fields.priceId],
  });
};

const checkBirdCondition = (bird, event, now) => {
  if (!bird || !bird.isEnabled) {
    return false;
  }

  let guestCount = event?.guestList?.length ?? 0;
  if (bird.excludeMembers && guestCount > 0) {
    guestCount = event.guestList.filter((guest) => guest.type !== "member").length;
  }

  const startTimer = bird.startTimer;
  const ticketTimer = bird.ticketTimer;
  const hasStartTimer = Boolean(startTimer);
  const hasTicketTimer = Boolean(ticketTimer);
  const hasNoTimerValues = !hasStartTimer && !hasTicketTimer;
  const hasNoLimitValue =
    bird.ticketLimit === null || bird.ticketLimit === undefined || bird.ticketLimit === "";

  if (hasNoTimerValues && hasNoLimitValue) {
    return false;
  }

  const timerMet =
    hasNoTimerValues ||
    ((!hasStartTimer || new Date(startTimer) <= now) &&
      (!hasTicketTimer || new Date(ticketTimer) > now));
  const limitMet =
    hasNoLimitValue || Number(bird.ticketLimit) > guestCount;

  return timerMet && limitMet;
};

const activeBirdStage = (event, now) => {
  for (const key of birdStagePriority) {
    if (checkBirdCondition(event[key], event, now)) {
      return { key, config: event[key] };
    }
  }
  return null;
};

export const resolveEventTicketPricing = (event, { now = new Date() } = {}) => {
  const product = event?.product;
  if (!product) {
    return {
      stage: "standard",
      flags: { earlyBird: false, lateBird: false },
      tiers: {},
    };
  }

  const stage = activeBirdStage(event, now);
  const tiers = {};

  for (const tierKey of ticketTierKeys) {
    const baseTier = cleanTicketTier(product[tierKey]);
    if (!baseTier) continue;

    const stageTier = stage ? birdTier(stage.config, tierKey) : null;
    const activeTier = stageTier ?? baseTier;
    const promotion = event.promotion?.[tierKey];

    tiers[tierKey] = isPromotionActive(promotion, now)
      ? applyPromotionToTier({ tier: activeTier, baseTier, promotion })
      : activeTier;
  }

  const activeMemberTier = cleanTicketTier(product.activeMember);
  if (activeMemberTier) {
    tiers.activeMember = activeMemberTier;
  }

  return {
    stage: stage?.key ?? "standard",
    flags: {
      earlyBird: stage?.key === "earlyBird",
      lateBird: stage?.key === "lateBird",
    },
    tiers,
  };
};

export const checkDiscountsOnEvents = (event, options = {}) => {
  if (!event?.product) return event;

  const pricing = resolveEventTicketPricing(event, options);
  event.product = {
    ...event.product,
    earlyBird: pricing.flags.earlyBird,
    lateBird: pricing.flags.lateBird,
  };

  for (const [tierKey, tier] of Object.entries(pricing.tiers)) {
    event.product[tierKey] = tier;
  }

  return event;
};

/**
 * Validates if a promocode can be applied to a purchase
 * @param {object} promocode - The promocode object from the event
 * @param {number} totalAmount - The purchase amount in euros
 * @returns {object} - { valid: boolean, reason: string, discountedAmount: number }
 */
export const validatePromocodeForPurchase = (promocode, totalAmount, audience = "guest") => {
  if (!audiencesForPromo(promocode).includes(audience) || promocode.exhausted) {
    return { valid: false, reason: "This promo code is not available for this ticket", discountedAmount: totalAmount };
  }
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
    if (now >= expirationDate) {
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
  const typeMapping = {
    guest: 'guest',
    member: 'member',
    activeMember: 'activeMember',
  };

  const priceType = typeMapping[userType] || 'guest';
  const alreadyResolved =
    product.earlyBird === true ||
    product.lateBird === true ||
    product[priceType]?.originalPrice !== undefined ||
    product[priceType]?.discount !== undefined;
  const pricing = alreadyResolved
    ? {
        flags: {
          earlyBird: product.earlyBird === true,
          lateBird: product.lateBird === true,
        },
        tiers: product,
      }
    : resolveEventTicketPricing(event);
  const priceInfo = pricing.tiers[priceType];

  if (!priceInfo) {
    return null;
  }

  const price = ticketPriceValue(priceInfo.price);
  const originalPrice = ticketPriceValue(priceInfo.originalPrice);
  const discountPercentage = Number(priceInfo.discount);
  const hasDiscount =
    (Number.isFinite(discountPercentage) && discountPercentage > 0) ||
    (price !== null && originalPrice !== null && originalPrice > price);

  return {
    price: priceInfo.price,
    priceId: priceInfo.priceId,
    discountInfo: {
      hasDiscount,
      originalPrice: priceInfo.originalPrice,
      discountPercentage: priceInfo.discount,
      isEarlyBird: pricing.flags.earlyBird,
      isLateBird: pricing.flags.lateBird,
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
  const priceInfo = getApplicablePrice(event, userType);

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
    const promocode = findPromocodeByCode(event, promocodeString);
    
    if (!promocode) {
      return {
        valid: false,
        error: "Invalid promocode",
        basePrice: priceInfo.price,
        priceId: priceInfo.priceId,
        discountInfo: priceInfo.discountInfo,
      };
    }

    const validation = validatePromocodeForPurchase(promocode, priceInfo.price, userType);
    
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
 * Also removes the ticket from MemberUser/AlumniUser.tickets for member-type guests (best-effort).
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

  // Best-effort: remove tickets from MemberUser/AlumniUser.tickets for member-type guests
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

        // Try regular MemberUser first, then AlumniUser
        let targetUser = await MemberUser.findOne({ email: r.email }).session(sess);
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

import moment from "moment";
import { addPrice, addProduct } from "../side-services/stripe.js";

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

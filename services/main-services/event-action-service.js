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
      let startTimerMet = true; // Default to true if not provided
      let ticketTimerMet = true; // Default to true if not provided

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

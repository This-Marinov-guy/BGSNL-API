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

  let guestCount = event?.guestList?.length ?? 0;
  event.product["earlyBird"] = false;
  event.product["lateBird"] = false;

  if (event?.lateBird && event.lateBird.isEnabled) {
    const lateBird = event.lateBird;
    const isLateBird = {
      limit: !Object.prototype.hasOwnProperty.call(lateBird, "ticketLimit"),
      timer:
        !Object.prototype.hasOwnProperty.call(lateBird, "ticketTimer") ||
        !Object.prototype.hasOwnProperty.call(lateBird, "startTimer"),
    };

    if (guestCount > 0 && lateBird.excludeMembers) {
      guestCount = event.guestList.filter((g) => g.type !== "member").length;
    }

    if (
      Object.prototype.hasOwnProperty.call(lateBird, "ticketLimit") &&
      lateBird.ticketLimit > guestCount
    ) {
      isLateBird["limit"] = true;
    }

    if (
      Object.prototype.hasOwnProperty.call(lateBird, "ticketTimer") &&
      moment(lateBird.ticketTimer).isAfter(moment())
    ) {
      isLateBird["timer"] = true;
    }

    if (
      Object.prototype.hasOwnProperty.call(lateBird, "startTimer") &&
      moment(lateBird.startTimer).isBefore(moment())
    ) {
      isLateBird["timer"] = true;
    }

    if (isLateBird.limit && isLateBird.timer) {
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
  }

  if (event?.earlyBird && event.earlyBird.isEnabled) {
    const earlyBird = event.earlyBird;
    const isEarlyBird = {
      limit: !Object.prototype.hasOwnProperty.call(earlyBird, "ticketLimit"),
      timer:
        !Object.prototype.hasOwnProperty.call(earlyBird, "ticketTimer") &&
        !Object.prototype.hasOwnProperty.call(earlyBird, "startTimer"),
    };

    if (guestCount > 0 && earlyBird.excludeMembers) {
      guestCount = event.guestList.filter((g) => g.type !== "member").length;
    }

    if (
      Object.prototype.hasOwnProperty.call(earlyBird, "ticketLimit") &&
      earlyBird.ticketLimit > guestCount
    ) {
      isEarlyBird["limit"] = true;
    }

    if (
      Object.prototype.hasOwnProperty.call(earlyBird, "ticketTimer") &&
      moment(earlyBird.ticketTimer).isAfter(moment())
    ) {
      isEarlyBird["timer"] = true;
    }

    if (
      Object.prototype.hasOwnProperty.call(earlyBird, "startTimer") &&
      moment(earlyBird.startTimer).isBefore(moment())
    ) {
      isEarlyBird["timer"] = true;
    }

    if (isEarlyBird.limit && isEarlyBird.timer) {
      event.product["earlyBird"] = true;

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
  }

  return event;
};

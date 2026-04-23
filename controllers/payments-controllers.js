import dotenv from "dotenv";
dotenv.config();
import HttpError from "../models/Http-error.js";
import User from "../models/User.js";
import Event from "../models/Event.js";
import { ACCESS_4, DEFAULT_REGION, MEMBER } from "../util/config/defines.js";
import { extractUserFromRequest } from "../util/functions/security.js";
import { createStripeClient, getStripeKey } from "../util/config/stripe.js";
import { findUserById } from "../services/main-services/user-service.js";
import { BILLING_PORTAL_CONFIGURATIONS } from "../util/config/enums.js";
import { checkDiscountsOnEvents } from "../services/main-services/event-action-service.js";
import {
  handleGuestTicketPurchase,
  handleMemberTicketPurchase,
} from "../services/main-services/stripe-webhook-service.js";
import { generateAndUploadEventTicket } from "../services/side-services/ticket-generator.js";

// Resolves the correct Stripe priceId from the DB, applying early/late-bird and promotion discounts.
// For guest checkout it always resolves guest price.
// For member checkout normalTicket=true falls back to guest price.
const resolveTicketPriceId = async (
  event,
  checkoutType = "guest",
  userId = "",
  normalTicket = false
) => {
  const ev = checkDiscountsOnEvents(event);
  const p = ev.product;

  if (checkoutType !== "member") {
    return p?.guest?.priceId ?? null;
  }

  if (!userId) {
    return null;
  }

  if (normalTicket) {
    return p?.guest?.priceId ?? null;
  }

  let user;
  try {
    user = await User.findById(userId);
  } catch (_) {
    return null;
  }
  if (!user) return null;

  const isActiveMember = ACCESS_4.includes(user.role);
  if (isActiveMember && p?.activeMember?.priceId) {
    return p.activeMember.priceId;
  }
  return p?.member?.priceId ?? null;
};

const inferCheckoutType = (req, userId) => {
  const method = req.body?.method;

  if (
    method === "buy_member_ticket" ||
    req.originalUrl?.includes("/member-ticket")
  ) {
    return "member";
  }

  if (
    method === "buy_guest_ticket" ||
    req.originalUrl?.includes("/guest-ticket")
  ) {
    return "guest";
  }

  return userId ? "member" : "guest";
};

// Builds Stripe line items for add-ons by matching _id against the event's add-on items in the DB.
const resolveAddonLineItems = (event, addOns) => {
  const items = event.addOns?.items ?? [];
  return addOns
    .map((addon) => {
      const dbItem = items.find(
        (item) => item._id.toString() === (addon._id ?? addon.id)?.toString()
      );
      return dbItem?.priceId
        ? { price: dbItem.priceId, quantity: addon.quantity ?? 1 }
        : null;
    })
    .filter(Boolean);
};

export const cancelSubscription = async (req, res, next) => {
  const { userId } = extractUserFromRequest(req);

  let user;

  try {
    user = await findUserById(userId);
  } catch (err) {
    return next(
      new HttpError("Could not find the current user, please try again", 500)
    );
  }

  const stripeClient = createStripeClient(DEFAULT_REGION);

  try {
    await stripeClient.subscriptions.update(user.subscription.id, {
      cancel_at_period_end: true,
    });
  } catch (err) {
    new HttpError("Something went wrong, please try again!", 500);
  }

  res.status(200).json({
    message:
      "Membership was canceled - you can still access your account and use discounts until the expiration date!",
  });
};

export const donationConfig = (req, res) => {
  res.send({
    publishableKey: getStripeKey("publishableKey"),
  });
};

export const postDonationIntent = async (req, res, next) => {
  const { amount, name, comments } = req.body;
  const { userId } = extractUserFromRequest(req);

  if (amount < 2 || amount > 10000) {
    return res.status(200).json({
      status: false,
      message: "Amount must be between the range of 2 and 10 000 euro",
    });
  }

  if (name.length > 50 || comments.length > 100) {
    return res.status(200).json({
      status: false,
      message:
        "Something went wrong - please update the details and try again!",
    });
  }

  const stripeClient = createStripeClient(DEFAULT_REGION);

  try {
    const paymentIntent = await stripeClient.paymentIntents.create({
      currency: "EUR",
      amount: amount * 100,
      automatic_payment_methods: { enabled: true },
      metadata: {
        name,
        comments,
        userId: userId || '',
      },
    });
    // Send publishable key and PaymentIntent details to client
    res.send({
      clientSecret: paymentIntent.client_secret,
    });
  } catch (e) {
    return res.status(400).send({
      error: {
        message: e.message,
      },
    });
  }
};

export const postPlaygroundTicketPreview = async (req, res, next) => {
  if (process.env.NODE_ENV === "production") {
    return next(new HttpError("Playground endpoint is disabled in production", 403));
  }

  const name = String(req.body?.name || "Test").trim();
  const surname = String(req.body?.surname || "User").trim();
  const originUrl = req.body?.origin_url || req.body?.originUrl || "";
  const quantity = Math.max(1, Number(req.body?.quantity || 1));

  let latestEvent;
  try {
    latestEvent = await Event.findOne({ status: { $ne: "archived" } }).sort({
      date: -1,
    });
  } catch (err) {
    return next(new HttpError("Could not load latest event", 500));
  }

  if (!latestEvent) {
    return next(new HttpError("No event found for playground preview", 404));
  }

  const previewEvent = {
    ...latestEvent.toObject(),
    ticketQR: true,
    ticketName: true,
  };

  let ticketUrl = "";
  try {
    ticketUrl = await generateAndUploadEventTicket({
      event: previewEvent,
      checkoutType: "guest",
      bucketName: process.env.BUCKET_GUEST_TICKETS,
      originUrl,
      code: Date.now(),
      quantity,
      guestName: `${name} ${surname}`.trim(),
    });
  } catch (err) {
    console.log(err);
    return next(new HttpError("Could not generate playground ticket", 500));
  }

  return res.status(200).json({
    status: true,
    ticketUrl,
    event: {
      id: latestEvent.id,
      title: latestEvent.title,
      date: latestEvent.date,
      region: latestEvent.region,
      ticketImg: latestEvent.ticketImg,
      ticketColor: latestEvent.ticketColor,
    },
    preview: {
      name,
      surname,
      quantity,
      ticketName: true,
      ticketQR: true,
    },
  });
};

export const postSubscriptionNoFile = async (req, res, next) => {
  const { itemId, origin_url, region } = req.body;
  const { userId, customerId = '' } = extractUserFromRequest(req);

  const stripeClient = createStripeClient(DEFAULT_REGION);

  const checkoutData = {
    mode: "subscription",
    allow_promotion_codes: true,
    line_items: [{ price: itemId, quantity: 1 }],
    success_url: `${origin_url}/success`,
    cancel_url: `${origin_url}/fail`,
    metadata: {
      ...req.body,
      userId: userId || "",
    },
  };

  // if (customerId) {
  //   checkoutData.customer = customerId;
  // }

  const session = await stripeClient.checkout.sessions.create(checkoutData);

  res.status(200).json({ url: session.url });
};

export const postSubscriptionFile = async (req, res, next) => {
  const { itemId, origin_url, region } = req.body;
  const { userId, customerId = '' } = extractUserFromRequest(req);

  const stripeClient = createStripeClient(DEFAULT_REGION);

  let fileLocation;
  if (req.file) {
    fileLocation = req.file.Location ? req.file.Location : req.file.location;
  }

  const checkoutData = {
    mode: "subscription",
    allow_promotion_codes: false,
    line_items: [{ price: itemId, quantity: 1 }],
    success_url: `${origin_url}/success`,
    cancel_url: `${origin_url}/fail`,
    metadata: {
      file: fileLocation ? fileLocation : null,
      userId: userId || "",
      ...req.body,
    },
  };

  // if (customerId) {
  //   checkoutData.customer = customerId;
  // }

  const session = await stripeClient.checkout.sessions.create(checkoutData);

  res.status(200).json({ url: session.url });
};

export const postCheckoutNoFile = async (req, res, next) => {
  const { origin_url, eventId, normalTicket } = req.body;
  const { userId } = extractUserFromRequest(req);
  const addOns = req.body.addOns ? JSON.parse(req.body.addOns) : [];
  let { quantity } = req.body;
  const checkoutType = inferCheckoutType(req, userId);
  const effectiveUserId =
    checkoutType === "member" ? userId || req.body.userId || "" : "";

  if (!eventId) {
    return next(new HttpError("Missing eventId", 422));
  }

  let event;
  try {
    event = await Event.findById(eventId);
  } catch (_) {
    return next(new HttpError("Could not load event", 500));
  }

  if (!event) {
    return next(new HttpError("Event not found", 404));
  }

  const isNormalTicket = normalTicket === "true" || normalTicket === true;
  const priceId = await resolveTicketPriceId(
    event,
    checkoutType,
    effectiveUserId,
    isNormalTicket
  );

  if (!priceId) {
    return next(new HttpError("No price configured for this event", 500));
  }

  const stripeClient = createStripeClient(event.region);

  quantity = Number(quantity);
  if (!quantity || isNaN(quantity) || quantity < 1) {
    quantity = 1;
  }

  const lineItems = [{ price: priceId, quantity }];
  lineItems.push(...resolveAddonLineItems(event, addOns));

  const checkoutData = {
    mode: "payment",
    allow_promotion_codes: true,
    line_items: lineItems,
    success_url: `${origin_url}/success`,
    cancel_url: `${origin_url}/fail`,
    metadata: {
      ...req.body,
      userId: effectiveUserId,
      quantity,
      region: event.region,
    },
  };

  // if (customerId) {
  //   checkoutData.customer = customerId;
  // }

  const session = await stripeClient.checkout.sessions.create(checkoutData);

  res.status(200).json({ url: session.url });
};

export const postCheckoutFile = async (req, res, next) => {
  const { origin_url, eventId, normalTicket } = req.body;
  const { userId } = extractUserFromRequest(req);
  const addOns = req.body.addOns ? JSON.parse(req.body.addOns) : [];
  let { quantity } = req.body;
  const checkoutType = inferCheckoutType(req, userId);
  const effectiveUserId =
    checkoutType === "member" ? userId || req.body.userId || "" : "";

  if (!eventId) {
    return next(new HttpError("Missing eventId", 422));
  }

  let event;
  try {
    event = await Event.findById(eventId);
  } catch (_) {
    return next(new HttpError("Could not load event", 500));
  }

  if (!event) {
    return next(new HttpError("Event not found", 404));
  }

  const isNormalTicket = normalTicket === "true" || normalTicket === true;
  quantity = Number(quantity);
  if (!quantity || isNaN(quantity) || quantity < 1) {
    quantity = 1;
  }
  let member = null;

  // For member flow: warn once if user already has a ticket, then allow normal/guest-price fallback.
  if (checkoutType === "member") {
    if (!effectiveUserId) {
      return next(new HttpError("Missing userId for member checkout", 422));
    }

    try {
      member = await User.findById(effectiveUserId);
    } catch (_) {
      return next(new HttpError("Could not load member", 500));
    }

    if (!member) {
      return next(new HttpError("User not found", 404));
    }

    const memberName = `${member.name} ${member.surname}`;
    const alreadyRegistered = event.guestList.some(
      (g) => g.name === memberName && g.email === member.email
    );

    if (alreadyRegistered && !isNormalTicket) {
      return res.status(200).json({ alreadyRegistered: true });
    }
  }

  let fileLocation = "";
  try {
    const bucketName =
      checkoutType === "member"
        ? process.env.BUCKET_MEMBER_TICKETS
        : process.env.BUCKET_GUEST_TICKETS;

    fileLocation = await generateAndUploadEventTicket({
      event,
      checkoutType,
      bucketName,
      originUrl: origin_url,
      code: req.body.code,
      quantity,
      guestName: req.body.guestName,
      userId: effectiveUserId,
      memberUser: member,
    });
  } catch (err) {
    console.log(err);
    return next(new HttpError("Ticket generation failed, please try again", 500));
  }

  const isFreeCheckout =
    event.isFree || (checkoutType === "member" && event.isMemberFree);

  if (isFreeCheckout) {
    const metadata = {
      ...req.body,
      file: fileLocation ? fileLocation : "",
      userId: effectiveUserId,
      quantity,
      region: event.region,
    };

    const freePaymentData = {
      transactionId: `free_${Date.now()}`,
    };

    if (checkoutType === "member") {
      await handleMemberTicketPurchase(metadata, freePaymentData);
    } else {
      await handleGuestTicketPurchase(metadata, freePaymentData);
    }

    return res.status(200).json({
      status: true,
      free: true,
      message: "Success",
    });
  }

  const priceId = await resolveTicketPriceId(
    event,
    checkoutType,
    effectiveUserId,
    isNormalTicket
  );

  if (!priceId) {
    return next(new HttpError("No price configured for this event", 500));
  }

  const stripeClient = createStripeClient(event.region);

  const lineItems = [{ price: priceId, quantity }];
  lineItems.push(...resolveAddonLineItems(event, addOns));

  const checkoutData = {
    mode: "payment",
    allow_promotion_codes: true,
    line_items: lineItems,
    success_url: `${origin_url}/success`,
    cancel_url: `${origin_url}/fail`,
    metadata: {
      ...req.body,
      file: fileLocation ? fileLocation : null,
      userId: effectiveUserId,
      quantity,
      region: event.region,
    },
  };

  // if (customerId) {
  //   checkoutData.customer = customerId;
  // }

  const session = await stripeClient.checkout.sessions.create(checkoutData);

  res.status(200).json({ url: session.url });
};

export const postCustomerPortal = async (req, res, next) => {
  const { url, type } = req.body;
  const { userId } = extractUserFromRequest(req);

  let user;

  try {
    user = await findUserById(userId);
  } catch (err) {
    return next(
      new HttpError("Could not find the current user, please try again", 500)
    );
  }  

  if (!user || !user.subscription.customerId) {
    return next(
      new HttpError("Operation failed - please contact support!", 500)
    );
  }

  const stripeClient = createStripeClient(DEFAULT_REGION);

  let session = null;
  let configuration = BILLING_PORTAL_CONFIGURATIONS[type] ?? BILLING_PORTAL_CONFIGURATIONS[MEMBER];

  try {
    session = await stripeClient.billingPortal.sessions.create({
      customer: user.subscription.customerId,
      return_url: url,
      configuration: configuration,
    });
  } catch (err) {
    console.log(err);
    return next(
      new HttpError("Operation failed - please contact support!", 500)
    );
  }

  res.status(200).json({ url: session.url });
};


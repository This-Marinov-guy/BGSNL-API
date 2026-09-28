import { checkoutPromoAudience, prepareEventPromoCheckout } from "../services/tickets/event-promo-codes.js";
import { randomInt } from "node:crypto";
import dotenv from "dotenv";
import { createHash } from "node:crypto";
dotenv.config();
import HttpError from "../models/Http-error.js";
import Event from "../models/Event.js";
import { ACCESS_4, DEFAULT_REGION } from "../util/config/defines.js";
import { extractUserFromRequest } from "../util/functions/security.js";
import { createStripeClient, getStripeKey } from "../util/config/stripe.js";
import {
  findUserById,
} from "../services/main-services/user-service.js";
import { resolveEventTicketPricing } from "../services/main-services/event-action-service.js";
import { isTicketSaleClosed } from "../util/functions/helpers.js";
import {
  handleGuestTicketPurchase,
  handleMemberTicketPurchase,
} from "../services/main-services/stripe-webhook-service.js";
import { accountEntitlements } from "../util/subscriptions/policy.js";
import { reconcileAccount } from "../services/subscriptions/reconcile.js";
import { generateAndUploadEventTicket } from "../services/side-services/ticket-generator.js";
import { mintTicketToken, reserveTicketToken } from "../services/tickets/qr-link.js";
import BillingRecord from "../models/BillingRecord.js";
import { createReturnedCheckout, createFreePaymentReturn, preparePaymentReturn, paymentOrigin } from "../services/payments/payment-return.js";
import { withBillingLease } from "../services/subscriptions/lease.js";
import {
  isExistingMemberTicket,
  isExistingEventTicket,
  isRestrictedTicketAccount,
  memberTicketClaimKey,
  memberTicketDuplicateMatcher,
  normalizeCheckoutQuantity,
} from "../services/tickets/member-ticket-policy.js";

const toTicketPrice = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
};

const priceInfoToLineItem = (event, priceInfo, quantity) => {
  if (!priceInfo) return null;
  if (priceInfo.priceId) return { price: priceInfo.priceId, quantity };

  const amount = Math.round(Number(priceInfo.price) * 100);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const priceData = {
    currency: "eur",
    unit_amount: amount,
  };

  if (priceInfo.productId) {
    priceData.product = priceInfo.productId;
  } else {
    priceData.product_data = { name: event.title };
  }

  return { price_data: priceData, quantity };
};

// Resolves the correct ticket price from the DB, applying early/late-bird and promotion discounts.
// For guest checkout it always resolves guest price.
// For member checkout normalTicket=true falls back to guest price.
export const resolveTicketPriceInfo = async (
  event,
  checkoutType = "guest",
  userId = "",
  normalTicket = false
) => {
  const productId = event?.product?.id;
  const { tiers } = resolveEventTicketPricing(event);
  const withProductId = (tier) => tier ? { ...tier, productId } : null;

  if (checkoutType !== "member") {
    return withProductId(tiers.guest);
  }

  if (!userId) {
    return null;
  }

  if (normalTicket) {
    return withProductId(tiers.guest);
  }

  let user;
  try {
    user = await findUserById(userId);
  } catch (_) {
    return null;
  }
  if (!user || !accountEntitlements(user).memberDiscount) return null;

  const isActiveMember = user.roles?.some((role) => ACCESS_4.includes(role));
  if (isActiveMember && tiers.activeMember?.priceId) {
    return withProductId(tiers.activeMember);
  }
  return withProductId(tiers.member);
};

export const resolveTicketPriceId = async (...args) => {
  const priceInfo = await resolveTicketPriceInfo(...args);
  return priceInfo?.priceId ?? null;
};

export const resolveTicketLineItem = async (
  event,
  checkoutType = "guest",
  userId = "",
  normalTicket = false,
  quantity = 1
) => {
  const priceInfo = await resolveTicketPriceInfo(event, checkoutType, userId, normalTicket);
  const numericPrice = toTicketPrice(priceInfo?.price);
  if (!priceInfo?.priceId && numericPrice === null) return null;
  return priceInfoToLineItem(event, priceInfo, quantity);
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

export const guestMetadataForAccount = (account) => ({
  guestName: [account?.name, account?.surname].filter(Boolean).join(" ") || "Guest",
  guestEmail: account?.email || "",
  guestPhone: account?.phone || "Not provided",
});

export const createTicketCheckoutSession = async ({
  stripeClient,
  checkoutData,
  checkoutType,
  isNormalTicket,
  eventId,
  userId,
  member,
  event,
}, {
  createReturned = createReturnedCheckout,
  lease = withBillingLease,
  hasDuplicate = query => Event.exists(query),
  updateRecord = (...args) => BillingRecord.updateOne(...args),
} = {}) => {
  const promoSignature = JSON.stringify([checkoutPromoAudience(checkoutType, member),
    (event?.product?.promoCodes ?? []).map(promo => [promo.id, promo.code, promo.active, promo.audiences])]);
  const choicesSignature = createHash("sha256").update(JSON.stringify([
    checkoutData.line_items, checkoutData.metadata?.preferences || "", checkoutData.metadata?.addOns || "",
  ])).digest("hex");
  const createSession = async (data) => {
    const prepared = await prepareEventPromoCheckout({ stripe: stripeClient, event,
      audience: checkoutPromoAudience(checkoutType, member), checkoutData: data });
    return createReturned({ stripe: stripeClient, checkoutData: prepared,
      region: data.metadata.region, returnPath: `/${data.metadata.region}/purchase-ticket/${eventId}` });
  };
  if (checkoutType !== "member" || isNormalTicket) {
    const session = await createSession(checkoutData);
    return { url: session.url };
  }

  const claimKey = memberTicketClaimKey(eventId, userId);
  return lease(claimKey, async ({ record, assertOwned }) => {
    const duplicate = await hasDuplicate({
      _id: eventId,
      guestList: {
        $elemMatch: memberTicketDuplicateMatcher({
          userId,
          userIds: member?.accountAliases,
          email: member?.email,
        }),
      },
    });

    if (duplicate) return { alreadyRegistered: true };

    if (record.data?.sessionId) {
      let previous = await stripeClient.checkout.sessions.retrieve(record.data.sessionId);
      if (previous.status === "open") {
        if (record.data.promoSignature === promoSignature && record.data.choicesSignature === choicesSignature && previous.url) return { url: previous.url };
        // Replace changed choices/eligibility, but never leave two payable
        // member-ticket sessions open or race a successful payment.
        await assertOwned();
        try {
          previous = await stripeClient.checkout.sessions.expire(previous.id);
        } catch (error) {
          previous = await stripeClient.checkout.sessions.retrieve(record.data.sessionId);
          if (previous.status !== "expired" && previous.status !== "complete") throw error;
        }
      }
      if (previous.status === "complete") throw new HttpError("Your ticket payment is being processed. Please refresh shortly.", 409);
      if (previous.status !== "expired") throw new HttpError("Your previous checkout could not be closed. Please try again.", 409);
    }

    // Stripe requires Checkout sessions to remain open for at least 30 minutes.
    // Keep a small buffer so request latency cannot put us below that boundary.
    const expiresAt = Math.floor(Date.now() / 1000) + 31 * 60;
    await assertOwned();
    const session = await createSession({
      ...checkoutData,
      expires_at: expiresAt,
    });

    await assertOwned();
    await updateRecord(
      { _id: claimKey },
      {
        $set: {
          data: {
            promoSignature,
            choicesSignature,
            reservedAt: new Date(),
            sessionId: session.id,
            sessionUrl: session.url,
            expiresAt: session.expires_at || expiresAt,
          },
        },
        $unset: { completedAt: 1 },
      },
      { upsert: true },
    );

    return { url: session.url };
  });
};

// Builds Stripe line items for add-ons by matching _id against the event's add-on items in the DB.
export const resolveAddonLineItems = (event, addOns) => {
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
    const receipt = await preparePaymentReturn({ origin: req.body.origin_url || req.get("origin"), kind: "donation",
      region: DEFAULT_REGION, returnPath: "/contact" });
    const paymentIntent = await stripeClient.paymentIntents.create({
      currency: "EUR",
      amount: amount * 100,
      automatic_payment_methods: { enabled: true },
      metadata: {
        name,
        comments,
        userId: userId || '',
        paymentReturnId: receipt.id,
      },
    });
    await receipt.bind(paymentIntent.id);
    // Send publishable key and PaymentIntent details to client
    return res.send({
      clientSecret: paymentIntent.client_secret,
      returnUrl: receipt.url,
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
    latestEvent = await Event.findOne({
      status: { $nin: ["archived", "draft"] },
    }).sort({
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
      // Preview tickets are never fulfilled, so this token admits nobody.
      ticketToken: mintTicketToken(),
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

export const postCheckoutNoFile = async (req, res, next) => {
  const { origin_url, eventId, normalTicket } = req.body;
  paymentOrigin(origin_url);
  const { userId } = extractUserFromRequest(req);
  const addOns = req.body.addOns ? JSON.parse(req.body.addOns) : [];
  let { quantity } = req.body;
  let checkoutType = inferCheckoutType(req, userId);
  let member = null;
  let restrictedGuestMetadata = req.emailTicketCheckout && checkoutType === "guest"
    ? guestMetadataForAccount(req.account) : null;
  if (checkoutType === "member") {
    try {
      member = isRestrictedTicketAccount(req.account)
        ? req.account
        : (await reconcileAccount(req.account))?.user;
      if (!member) return next(new HttpError("Could not load member", 401));
      if (!accountEntitlements(member).memberDiscount) {
        checkoutType = "guest";
        restrictedGuestMetadata = guestMetadataForAccount(member);
      }
    } catch { return next(new HttpError("Could not verify membership. Please try again.", 503)); }
  }
  const effectiveUserId = checkoutType === "member" ? userId || "" : "";
  quantity = normalizeCheckoutQuantity(quantity, checkoutType);
  if (!quantity) {
    return next(new HttpError(
      checkoutType === "member"
        ? "Member checkout is limited to one ticket"
        : "Quantity must be a whole number between 1 and 10",
      422
    ));
  }

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

  if (isTicketSaleClosed(event)) {
    return next(new HttpError("Ticket sale is closed", 400));
  }

  const isNormalTicket = normalTicket === "true" || normalTicket === true;
  const alreadyRegistered = checkoutType === "member" && event.guestList.some(
    (ticket) => (req.emailTicketCheckout ? isExistingEventTicket : isExistingMemberTicket)(ticket, {
      userId: effectiveUserId,
      userIds: member?.accountAliases,
      email: member?.email,
    })
  );
  if (alreadyRegistered && !isNormalTicket) {
    return res.status(200).json({ alreadyRegistered: true });
  }

  const ticketLineItem = await resolveTicketLineItem(
    event,
    checkoutType,
    effectiveUserId,
    isNormalTicket,
    quantity
  );

  if (!ticketLineItem) {
    return next(new HttpError("No price configured for this event", 500));
  }

  const stripeClient = createStripeClient(event.region);

  const lineItems = [ticketLineItem];
  lineItems.push(...resolveAddonLineItems(event, addOns));

  const ticketCode = randomInt(100000000, 1000000000);
  const ticketToken = await reserveTicketToken(event, ticketCode);
  const ticketFile = await generateAndUploadEventTicket({ event, checkoutType,
    bucketName: checkoutType === "member" ? process.env.BUCKET_MEMBER_TICKETS : process.env.BUCKET_GUEST_TICKETS,
    ticketToken, code: ticketCode, quantity, originUrl: origin_url,
    guestName: restrictedGuestMetadata?.guestName || req.body.guestName,
    userId: effectiveUserId, memberUser: member });

  const checkoutData = {
    mode: "payment",
    allow_promotion_codes: true,
    line_items: lineItems,
    success_url: `${origin_url}/success`,
    cancel_url: `${origin_url}/fail`,
    metadata: {
      ...req.body,
      ...restrictedGuestMetadata,
      code: ticketCode,
      ticketToken,
      file: ticketFile,
      method: checkoutType === "member" ? "buy_member_ticket" : "buy_guest_ticket",
      type: checkoutType === "member" ? "member" : "guest",
      userId: effectiveUserId,
      quantity,
      region: event.region,
      memberPriceApplied: checkoutType === "member" && !isNormalTicket ? "true" : "false",
    },
  };

  // if (customerId) {
  //   checkoutData.customer = customerId;
  // }

  const result = await createTicketCheckoutSession({
    stripeClient,
    checkoutData,
    checkoutType,
    isNormalTicket,
    eventId,
    userId: effectiveUserId,
    member,
    event,
  });

  return res.status(200).json(result);
};

export const postCheckoutFile = async (req, res, next, {
  loadEvent = (id) => Event.findById(id),
  reconcile = reconcileAccount,
  generateTicket = generateAndUploadEventTicket,
  reserveToken = reserveTicketToken,
  resolvePrice,
  resolveLineItem,
  stripeForRegion = createStripeClient,
  createCheckout = createTicketCheckoutSession,
} = {}) => {
  const { origin_url, eventId, normalTicket } = req.body;
  paymentOrigin(origin_url);
  const { userId } = extractUserFromRequest(req);
  const addOns = req.body.addOns ? JSON.parse(req.body.addOns) : [];
  let { quantity } = req.body;
  let checkoutType = inferCheckoutType(req, userId);
  let member = null;
  let restrictedGuestMetadata = req.emailTicketCheckout && checkoutType === "guest"
    ? guestMetadataForAccount(req.account) : null;
  if (checkoutType === "member") {
    try {
      member = isRestrictedTicketAccount(req.account)
        ? req.account
        : (await reconcile(req.account))?.user;
      if (!member) return next(new HttpError("Could not load member", 401));
      if (!accountEntitlements(member).memberDiscount) {
        checkoutType = "guest";
        restrictedGuestMetadata = guestMetadataForAccount(member);
      }
    } catch { return next(new HttpError("Could not verify membership. Please try again.", 503)); }
  }
  const effectiveUserId = checkoutType === "member" ? userId || "" : "";
  quantity = normalizeCheckoutQuantity(quantity, checkoutType);
  if (!quantity) {
    return next(new HttpError(
      checkoutType === "member"
        ? "Member checkout is limited to one ticket"
        : "Quantity must be a whole number between 1 and 10",
      422
    ));
  }

  if (!eventId) {
    return next(new HttpError("Missing eventId", 422));
  }

  let event;
  try {
    event = await loadEvent(eventId);
  } catch (_) {
    return next(new HttpError("Could not load event", 500));
  }

  if (!event) {
    return next(new HttpError("Event not found", 404));
  }

  if (isTicketSaleClosed(event)) {
    return next(new HttpError("Ticket sale is closed", 400));
  }

  const isNormalTicket = normalTicket === "true" || normalTicket === true;

  // For member flow: warn once if user already has a ticket, then allow normal/guest-price fallback.
  if (checkoutType === "member") {
    if (!effectiveUserId) {
      return next(new HttpError("Missing userId for member checkout", 422));
    }

    if (!member || !accountEntitlements(member).memberDiscount) {
      return next(new HttpError("An active member subscription is required", 403));
    }

    const alreadyRegistered = event.guestList.some(
      (ticket) => (req.emailTicketCheckout ? isExistingEventTicket : isExistingMemberTicket)(ticket, {
        userId: effectiveUserId,
        userIds: member.accountAliases,
        email: member.email,
      })
    );

    if (alreadyRegistered && !isNormalTicket) {
      return res.status(200).json({ alreadyRegistered: true });
    }
  }

  let fileLocation = "";
  // Never trust a browser timestamp as a unique purchase identity.
  const ticketCode = randomInt(1, 281474976710655);
  let ticketToken;
  try {
    const bucketName =
      checkoutType === "member"
        ? process.env.BUCKET_MEMBER_TICKETS
        : process.env.BUCKET_GUEST_TICKETS;

    // Reserved before the guest rows exist; the same token is stored on every
    // row this purchase creates, so one QR admits the whole group.
    ticketToken = await reserveToken(event, ticketCode);

    fileLocation = await generateTicket({
      event,
      checkoutType,
      bucketName,
      originUrl: origin_url,
      ticketToken,
      code: ticketCode,
      quantity,
      guestName: restrictedGuestMetadata?.guestName || req.body.guestName,
      userId: effectiveUserId,
      memberUser: member,
    });
  } catch (err) {
    console.log(err);
    return next(new HttpError("Ticket generation failed, please try again", 500));
  }

  const isFreeCheckout =
    event.isFree || (checkoutType === "member" && !isNormalTicket && event.isMemberFree);

  // Even free email tickets go through Checkout confirmation: opening a link
  // (including mail scanning) must never issue a ticket.
  if (isFreeCheckout && !req.emailTicketCheckout) {
    const metadata = {
      ...req.body,
      ...restrictedGuestMetadata,
      method: checkoutType === "member" ? "buy_member_ticket" : "buy_guest_ticket",
      code: ticketCode,
      ticketToken,
      type: checkoutType === "member" ? "member" : "guest",
      file: fileLocation ? fileLocation : "",
      userId: effectiveUserId,
      quantity,
      region: event.region,
      memberPriceApplied: checkoutType === "member" && !isNormalTicket ? "true" : "false",
    };

    const freePaymentData = {
      transactionId: `free_${Date.now()}`,
    };

    if (checkoutType === "member") {
      const result = await handleMemberTicketPurchase(metadata, freePaymentData);
      if (result.duplicate) {
        return res.status(200).json({ alreadyRegistered: true });
      }
    } else {
      await handleGuestTicketPurchase(metadata, freePaymentData);
    }

    return res.status(200).json({
      status: true,
      free: true,
      message: "Success",
      url: await createFreePaymentReturn({ origin: origin_url, region: event.region,
        returnPath: `/${event.region}/event-details/${eventId}`, title: event.title, quantity }),
    });
  }

  const resolveCheckoutLineItem = resolveLineItem
    ? () => resolveLineItem(event, checkoutType, effectiveUserId, isNormalTicket, quantity)
    : resolvePrice
      ? async () => {
          const priceId = await resolvePrice(event, checkoutType, effectiveUserId, isNormalTicket);
          return priceId ? { price: priceId, quantity } : null;
        }
      : () => resolveTicketLineItem(event, checkoutType, effectiveUserId, isNormalTicket, quantity);
  const ticketLineItem = isFreeCheckout ? null : await resolveCheckoutLineItem();

  if (!isFreeCheckout && !ticketLineItem) {
    return next(new HttpError("No price configured for this event", 500));
  }

  const stripeClient = stripeForRegion(event.region);

  const lineItems = isFreeCheckout
    ? [{ price_data: { currency: "eur", product_data: { name: event.title }, unit_amount: 0 }, quantity }]
    : [ticketLineItem];
  lineItems.push(...resolveAddonLineItems(event, addOns));

  const checkoutData = {
    mode: "payment",
    ...(req.emailTicketCheckout ? { customer_email: req.account.email } : {}),
    allow_promotion_codes: true,
    line_items: lineItems,
    success_url: `${origin_url}/success`,
    cancel_url: `${origin_url}/fail`,
    metadata: {
      ...req.body,
      ...restrictedGuestMetadata,
      method: checkoutType === "member" ? "buy_member_ticket" : "buy_guest_ticket",
      code: ticketCode,
      ticketToken,
      type: checkoutType === "member" ? "member" : "guest",
      file: fileLocation ? fileLocation : null,
      userId: effectiveUserId,
      quantity,
      region: event.region,
      memberPriceApplied: checkoutType === "member" && !isNormalTicket ? "true" : "false",
    },
  };

  // if (customerId) {
  //   checkoutData.customer = customerId;
  // }

  const result = await createCheckout({
    stripeClient,
    checkoutData,
    checkoutType,
    isNormalTicket,
    eventId,
    userId: effectiveUserId,
    member,
    event,
  });

  return res.status(200).json(result);
};

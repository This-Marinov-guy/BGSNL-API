/**
 * create-ticket-checkout — mint a Stripe Checkout link for an event ticket from
 * the command line, for a member (user) or a guest.
 *
 * This is a thin CLI wrapper around the exact same helpers the HTTP checkout
 * controller uses (payments-controllers.js), so the link it returns behaves
 * identically to one produced by the website — including the member billing
 * lease that keeps a member's ticket idempotent and duplicate-guarded. Nothing
 * is charged and no guest-list row is written until the link is actually paid;
 * generating the link only uploads the ticket image and opens a Stripe session.
 *
 * Usage:
 *   node scripts/create-ticket-checkout.mjs --eventId=<id> --type=guest \
 *     --guestName="Jane Doe" --guestEmail=jane@example.com --guestPhone=+31600000000
 *
 *   node scripts/create-ticket-checkout.mjs --eventId=<id> --type=member \
 *     --userId=member_<id>
 *
 * Flags:
 *   --eventId=      (required) event _id
 *   --type=         member | guest            (default: guest)
 *   --userId=       member account id         (required when --type=member)
 *   --guestName=    guest full name           (guest; falls back to the member account)
 *   --guestEmail=   guest email
 *   --guestPhone=   guest phone
 *   --quantity=     1-10 (guest) / forced to 1 (member)   (default: 1)
 *   --normalTicket  member buys an extra ticket at the guest price
 *   --origin=       origin for success/cancel URLs  (default: https://bulgariansociety.nl)
 *   --code=         idempotency/order code    (default: current epoch ms)
 *   --addOns=       JSON array of { _id | id, quantity }   (optional)
 */

import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import { fileURLToPath } from "url";
import path from "path";

import Event from "../models/Event.js";
import { findUserById } from "../services/main-services/user-service.js";
import { accountEntitlements } from "../util/subscriptions/policy.js";
import { reconcileAccount } from "../services/subscriptions/reconcile.js";
import { createStripeClient } from "../util/config/stripe.js";
import { generateAndUploadEventTicket } from "../services/side-services/ticket-generator.js";
import {
  isRestrictedTicketAccount,
  normalizeCheckoutQuantity,
} from "../services/tickets/member-ticket-policy.js";
import {
  createTicketCheckoutSession,
  guestMetadataForAccount,
  resolveAddonLineItems,
  resolveTicketPriceId,
} from "../controllers/payments-controllers.js";

const getMongoUri = () =>
  // eslint-disable-next-line no-process-env
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;

export const parseArgs = (argv) => {
  const options = {
    type: "guest",
    quantity: "1",
    normalTicket: false,
    diagnose: false,
    origin: "https://bulgariansociety.nl",
    code: String(Date.now()),
    addOns: [],
  };

  for (const arg of argv) {
    if (arg === "--normalTicket") {
      options.normalTicket = true;
    } else if (arg === "--diagnose") {
      options.diagnose = true;
    } else if (arg.startsWith("--addOns=")) {
      const raw = arg.slice("--addOns=".length);
      options.addOns = raw ? JSON.parse(raw) : [];
    } else if (arg.startsWith("--")) {
      const [key, ...rest] = arg.slice(2).split("=");
      options[key] = rest.join("=");
    }
  }

  if (!options.eventId) {
    throw new Error("Missing --eventId");
  }
  if (!["member", "guest"].includes(options.type)) {
    throw new Error(`Invalid --type "${options.type}". Use member or guest.`);
  }
  if (options.type === "member" && !options.userId) {
    throw new Error("--type=member requires --userId=member_<id>");
  }

  return options;
};

/**
 * Mirrors postCheckoutFile() for the paid-ticket path: resolve the account and
 * checkout type, generate the ticket image, resolve the price, then hand off to
 * the same createTicketCheckoutSession() the controller uses.
 */
export const createTicketCheckout = async (options) => {
  const event = await Event.findById(options.eventId);
  if (!event) throw new Error(`Event not found: ${options.eventId}`);

  let checkoutType = options.type;
  const isNormalTicket = options.normalTicket === true;
  // Admin override: charge a specific tier's price regardless of the account's
  // entitlement. Bypasses the "expired/no membership → guest price" rule, so it
  // is opt-in only and always logged below.
  const forceTier = ["member", "activeMember", "guest"].includes(options.forcePrice)
    ? options.forcePrice
    : null;
  let member = null;
  let restrictedGuestMetadata = null;

  if (checkoutType === "member") {
    const account = await findUserById(options.userId);
    if (!account) throw new Error(`Member account not found: ${options.userId}`);

    // A restricted (locked/frozen/…) account is used as-is; an active one is
    // reconciled against Stripe first — the same branch the controller takes.
    member = isRestrictedTicketAccount(account)
      ? account
      : (await reconcileAccount(account))?.user || account;

    // Same fallback the controller applies: an account without the member
    // discount is charged the guest price instead of failing — unless an admin
    // override pins the price to a member tier.
    const wantsMemberTier = forceTier === "member" || forceTier === "activeMember";
    if (!wantsMemberTier && !accountEntitlements(member).memberDiscount) {
      checkoutType = "guest";
      restrictedGuestMetadata = guestMetadataForAccount(member);
    }
  }

  // Read-only explanation of the price decision — no ticket, no Stripe session.
  if (options.diagnose) {
    const ent = member ? accountEntitlements(member) : null;
    const memberPriceId = member
      ? await resolveTicketPriceId(event, "member", options.userId, false)
      : null;
    const guestPriceId = await resolveTicketPriceId(event, "guest", "", false);
    return {
      diagnose: true,
      account: member
        ? {
            id: options.userId,
            resolvedId: String(member._id),
            name: [member.name, member.surname].filter(Boolean).join(" "),
            email: member.email,
            status: member.status,
            roles: member.roles,
            subscriptionStatus: member.subscription?.status,
            subscriptionHasBenefits: member.subscription?.hasBenefits,
            subscriptionSyncedAt: member.subscription?.syncedAt,
            expireDate: member.expireDate,
          }
        : null,
      entitlements: ent,
      resolvedCheckoutType: checkoutType,
      wouldChargePrice:
        checkoutType === "member" ? event.product?.member?.price : event.product?.guest?.price,
      memberPriceId,
      guestPriceId,
      product: event.product,
    };
  }

  // The identity the caller authenticated as — matches the controller, where
  // this is the token's userId rather than the resolved account _id.
  const effectiveUserId = checkoutType === "member" ? options.userId : "";

  const quantity = normalizeCheckoutQuantity(options.quantity, checkoutType);
  if (!quantity) {
    throw new Error(
      checkoutType === "member"
        ? "Member checkout is limited to one ticket"
        : "Quantity must be a whole number between 1 and 10"
    );
  }

  const guestName =
    restrictedGuestMetadata?.guestName || options.guestName || "";

  const bucketName =
    checkoutType === "member"
      // eslint-disable-next-line no-process-env
      ? process.env.BUCKET_MEMBER_TICKETS
      // eslint-disable-next-line no-process-env
      : process.env.BUCKET_GUEST_TICKETS;

  const fileLocation = await generateAndUploadEventTicket({
    event,
    checkoutType,
    bucketName,
    originUrl: options.origin,
    code: options.code,
    quantity,
    guestName,
    userId: effectiveUserId,
    memberUser: member,
  });

  const isFreeCheckout =
    event.isFree ||
    (checkoutType === "member" && !isNormalTicket && event.isMemberFree);
  if (isFreeCheckout) {
    return {
      free: true,
      message:
        "This event is free for this ticket type — there is no Stripe link. " +
        "Use the website flow (or the checkout endpoint) to register a free ticket.",
    };
  }

  // With an override, use that tier's configured priceId directly — the normal
  // resolver would return null for an account without the member entitlement.
  const priceId = forceTier
    ? event.product?.[forceTier]?.priceId ?? null
    : await resolveTicketPriceId(
        event,
        checkoutType,
        effectiveUserId,
        isNormalTicket
      );
  if (!priceId) {
    throw new Error(
      forceTier
        ? `No priceId configured for tier "${forceTier}" on this event`
        : "No price configured for this event/type"
    );
  }
  if (forceTier) {
    console.error(
      `[create-ticket-checkout] OVERRIDE: charging "${forceTier}" price ` +
        `(${event.product?.[forceTier]?.price}€) for ${options.userId} — ` +
        "account entitlement bypassed."
    );
  }

  const lineItems = [{ price: priceId, quantity }];
  lineItems.push(...resolveAddonLineItems(event, options.addOns));

  // Metadata mirrors the fields the frontend posts and the webhook reads to
  // build the ticket once payment completes.
  const metadata = {
    eventId: options.eventId,
    code: options.code,
    region: event.region,
    quantity,
    method: checkoutType === "member" ? "buy_member_ticket" : "buy_guest_ticket",
    type: checkoutType === "member" ? "member" : "guest",
    guestName,
    guestEmail: restrictedGuestMetadata?.guestEmail || options.guestEmail || "",
    guestPhone: restrictedGuestMetadata?.guestPhone || options.guestPhone || "",
    policyTerms: "true",
    payTerms: "true",
    file: fileLocation || null,
    userId: effectiveUserId,
    memberPriceApplied:
      checkoutType === "member" && !isNormalTicket ? "true" : "false",
  };

  const checkoutData = {
    mode: "payment",
    allow_promotion_codes: true,
    line_items: lineItems,
    success_url: `${options.origin}/success`,
    cancel_url: `${options.origin}/fail`,
    metadata,
  };

  return createTicketCheckoutSession({
    stripeClient: createStripeClient(event.region),
    checkoutData,
    checkoutType,
    isNormalTicket,
    eventId: options.eventId,
    userId: effectiveUserId,
    member,
  });
};

const isDirectRun = (() => {
  const scriptPath = process.argv[1];
  return scriptPath
    ? path.resolve(scriptPath) === fileURLToPath(import.meta.url)
    : false;
})();

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  mongoose.set("strictQuery", true);
  await mongoose.connect(getMongoUri());
  try {
    const result = await createTicketCheckout(options);
    if (result.diagnose) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.alreadyRegistered) {
      console.log(
        "This account already used the member price for this event. " +
          "Re-run with --normalTicket for the guest-price fallback."
      );
    } else if (result.free) {
      console.log(result.message);
    } else {
      console.log(result.url);
    }
  } finally {
    await mongoose.connection.close();
  }
};

if (isDirectRun) {
  main().catch(async (error) => {
    console.error(`[create-ticket-checkout] Failed: ${error.message}`);
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
    process.exitCode = 1;
  });
}

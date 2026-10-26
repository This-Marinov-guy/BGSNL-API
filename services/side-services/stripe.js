import { syncEventPromoCodes } from "../tickets/event-promo-codes.js";
import dotenv from "dotenv";
dotenv.config();
import { MOMENT_DATE_YEAR } from '../../util/functions/dateConvert.js';
import { capitalizeFirstLetter } from '../../util/functions/helpers.js';
import moment from "moment";
import { DEFAULT_REGION } from "../../util/config/defines.js";
import { STRIPE_KEYS, createStripeClient } from "../../util/config/stripe.js";
import { logIntegrationError } from "../../middleware/axiom-logger.js";

const stripeClientCache = new Map();

const getCachedStripeClient = (region) => {
    if (!stripeClientCache.has(region)) {
        stripeClientCache.set(region, createStripeClient(region));
    }

    return stripeClientCache.get(region);
};

const getStripeLookupRegions = (preferredRegions = []) => {
    const seenRegions = new Set();
    const seenSecretKeys = new Set();
    const orderedRegions = [...preferredRegions, DEFAULT_REGION, ...Object.keys(STRIPE_KEYS)];

    return orderedRegions.filter((region) => {
        if (!region || seenRegions.has(region) || !(region in STRIPE_KEYS)) {
            return false;
        }

        seenRegions.add(region);

        const secretKey = STRIPE_KEYS[region]?.secretKey;
        if (!secretKey || seenSecretKeys.has(secretKey)) {
            return false;
        }

        seenSecretKeys.add(secretKey);
        return true;
    });
};

const isStripeResourceMissingError = (err) =>
    err?.code === "resource_missing" ||
    err?.raw?.code === "resource_missing" ||
    err?.statusCode === 404;

export const getStripeSubscriptionCreatedDate = async (subscriptionId, preferredRegions = []) => {
    if (!subscriptionId) {
        return null;
    }

    for (const region of getStripeLookupRegions(preferredRegions)) {
        try {
            const subscription = await getCachedStripeClient(region).subscriptions.retrieve(subscriptionId);

            if (subscription?.created) {
                return {
                    createdAt: new Date(subscription.created * 1000),
                    region,
                };
            }
        } catch (err) {
            if (isStripeResourceMissingError(err)) {
                continue;
            }

            logIntegrationError("stripe", err, "subscription-created-date");

            console.error(
                `[getStripeSubscriptionCreatedDate] Failed to retrieve subscription ${subscriptionId} from ${region}: ${err.message}`
            );
        }
    }

    return null;
};

export const stripeProductDescription = (region, name, date) => {
    console.log(region, name, date);
    if (!date || !name || !region) {
        return '';
    }

    return `Event Ticket for ${capitalizeFirstLetter(region, true)}'s ${name} on ${moment(date).format(MOMENT_DATE_YEAR)}`;
};

export const addProduct = async (data, priceData = []) => {
    let product;
    const properties = {
        name: data['name'],
        images: [data['image']],
        description: stripeProductDescription(data['region'], data['name'], data['date'])
    };

    const stripeClient = createStripeClient(data['region']);

    try {
        product = await stripeClient.products.create(properties);

        // priceData.forEach(async (amount) => {
        //     const priceId = await addPrice(data['region'], product['id'], amount);

        //     if (priceId) {

        //     }
        // });
    } catch (err) {
        logIntegrationError("stripe", err, "product-create");
        return false;
    }

    return product['id'];
};

export const editProduct = async (region, productId, data) => {
    const stripeClient = createStripeClient(region);

    try {
        await stripeClient.products.update(
            productId,
            {
                ...data,
            }
        );
    } catch (err) {
        logIntegrationError("stripe", err, "product-update");
        return false;
    }

    return true;
};

export const archiveProduct = async (region, productId, { stripeClient } = {}) => {
    if (!productId) {
        return false;
    }

    try {
        const client = stripeClient || createStripeClient(region);
        const priceIds = [];
        let startingAfter;
        do {
            const page = await client.prices.list({ product: productId, active: true, limit: 100,
                ...(startingAfter ? { starting_after: startingAfter } : {}) });
            priceIds.push(...page.data.map(price => price.id));
            if (page.has_more && !page.data.length) throw new Error("Stripe price pagination did not advance");
            const next = page.has_more ? page.data.at(-1).id : null;
            if (next && next === startingAfter) throw new Error("Stripe price pagination did not advance");
            startingAfter = next;
        } while (startingAfter);

        for (const priceId of priceIds) await client.prices.update(priceId, { active: false });
        await client.products.update(productId, { active: false });
    } catch (err) {
        logIntegrationError("stripe", err, "product-archive");
        throw err;
    }

    return true;
};

export const addPrice = async (region, productId, amount = 0, nickname = 'price') => {
    if (!amount) {
        return false;
    }

    const stripeClient = createStripeClient(region);

    let price;

    try {
        price = await stripeClient.prices.create({
            currency: 'eur',
            unit_amount: amount * 100,
            product: productId,
            nickname
        });
    } catch (err) {
        logIntegrationError("stripe", err, "price-create");
        return false;
    }

    return price['id'];
};

const loadRefundCharge = async (stripeClient, paymentIntentId) => {
  const intent = await stripeClient.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge.balance_transaction"] });
  const charge = typeof intent.latest_charge === "string"
    ? await stripeClient.charges.retrieve(intent.latest_charge, { expand: ["balance_transaction"] })
    : intent.latest_charge;
  if (!charge) throw new Error("Payment has no completed charge");
  return charge;
};

export const getStripeRefundQuote = async (region, paymentIntentId, { stripeClient = createStripeClient(region) } = {}) => {
  const charge = await loadRefundCharge(stripeClient, paymentIntentId);
  const transaction = typeof charge.balance_transaction === "string"
    ? await stripeClient.balanceTransactions.retrieve(charge.balance_transaction)
    : charge.balance_transaction;
  if (!transaction || !Number.isInteger(transaction.fee)) throw new Error("Stripe processing fee is unavailable");
  return { amountCents: charge.amount, refundedCents: charge.amount_refunded,
    remainingCents: charge.amount - charge.amount_refunded, feeCents: transaction.fee,
    currency: charge.currency?.toUpperCase() || "EUR" };
};

/**
 * Issues a Stripe refund for a payment intent
 * @param {string} region - Region for stripe client
 * @param {string} paymentIntentId - Stripe payment intent ID (pi_...)
 * @param {string|null} reason - Human-readable reason (stored in metadata)
 * @param {{mode?: "full"|"partial"|"less_fees", amountCents?: number, idempotencyKey?: string}} options
 * @returns {{ success: boolean, refundId?: string, status?: string, error?: string }}
 */
export const refundStripePayment = async (region, paymentIntentId, reason = null, options = {}) => {
  if (!paymentIntentId || paymentIntentId === "-") {
    return { success: false, error: "No valid payment intent ID" };
  }

  const stripeClient = options.dependencies?.stripeClient || createStripeClient(region);

  try {
    const mode = options.mode || "full";
    if (!["full", "partial", "less_fees"].includes(mode)) throw new Error("Invalid refund mode");
    if (options.operationId) {
      const refunds = await stripeClient.refunds.list({ payment_intent: paymentIntentId, limit: 100 });
      const prior = refunds.data.find(item => item.metadata?.operation_id === options.operationId &&
        !["failed", "canceled"].includes(item.status));
      if (prior) return { success: true, refundId: prior.id, status: prior.status, amountCents: prior.amount,
        alreadyRefunded: true };
    }
    const charge = await loadRefundCharge(stripeClient, paymentIntentId);
    const remaining = charge.amount - charge.amount_refunded;
    if (remaining <= 0) return { success: true, status: "already_refunded" };
    let amount;
    if (mode === "partial") {
      amount = options.amountCents;
      if (!Number.isInteger(amount) || amount <= 0 || amount > remaining) throw new Error("Partial refund amount is invalid");
    } else if (mode === "less_fees") {
      const transaction = typeof charge.balance_transaction === "string"
        ? await stripeClient.balanceTransactions.retrieve(charge.balance_transaction)
        : charge.balance_transaction;
      if (!transaction || !Number.isInteger(transaction.fee)) throw new Error("Stripe fee is unavailable");
      amount = remaining - transaction.fee;
      if (amount <= 0) throw new Error("Stripe fee exceeds refundable amount");
    } else amount = remaining;
    const refundData = { payment_intent: paymentIntentId };
    refundData.amount = amount;
    if (reason) {
      refundData.metadata = { reason };
    }
    if (options.operationId) refundData.metadata = { ...refundData.metadata, operation_id: options.operationId };
    const refund = await stripeClient.refunds.create(refundData, options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined);
    if (["failed", "canceled"].includes(refund.status)) return { success: false, error: `Stripe refund ${refund.status}` };
    return { success: true, refundId: refund.id, status: refund.status, amountCents: refund.amount };
  } catch (err) {
    logIntegrationError("stripe", err, "refund");
    console.error(`[refundStripePayment] Failed to refund payment intent ${paymentIntentId}:`, err.message);
    return { success: false, error: err.message };
  }
};

export const editPrice = async (region, priceId, data) => {
    const stripeClient = createStripeClient(region);

    try {
        await stripeClient.prices.update(
            priceId,
            {
                ...data
            }
        );
    } catch (err) {
        logIntegrationError("stripe", err, "price-update");
        return false;
    }

    return true;
};

export const processPromocodesForCreate = (region, productId, promoCodes) =>
  syncEventPromoCodes(createStripeClient(region), productId, promoCodes, []);

export const processPromocodesForUpdate = (region, productId, promoCodes, existingPromocodes = []) =>
  syncEventPromoCodes(createStripeClient(region), productId, promoCodes, existingPromocodes);

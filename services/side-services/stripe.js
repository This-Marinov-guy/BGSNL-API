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

export const deleteProduct = async (region, productId) => {
    if (!productId) {
        return false;
    }

    const stripeClient = createStripeClient(region);

    try {
        const prices = await stripeClient.prices.list({ product: productId });

        for (const price of prices.data) {
          await stripeClient.prices.update(price.id, { active: false });
          console.log(`Archived price: ${price.id}`);
        }

        await stripeClient.products.del(productId);
    } catch (err) {
        logIntegrationError("stripe", err, "product-delete");
        return false;
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

/**
 * Issues a Stripe refund for a payment intent
 * @param {string} region - Region for stripe client
 * @param {string} paymentIntentId - Stripe payment intent ID (pi_...)
 * @param {string|null} reason - Human-readable reason (stored in metadata)
 * @returns {{ success: boolean, refundId?: string, status?: string, error?: string }}
 */
export const refundStripePayment = async (region, paymentIntentId, reason = null) => {
  if (!paymentIntentId || paymentIntentId === "-") {
    return { success: false, error: "No valid payment intent ID" };
  }

  const stripeClient = createStripeClient(region);

  try {
    const refundData = { payment_intent: paymentIntentId };
    if (reason) {
      refundData.metadata = { reason };
    }
    const refund = await stripeClient.refunds.create(refundData);
    return { success: true, refundId: refund.id, status: refund.status };
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

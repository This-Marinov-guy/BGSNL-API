import dotenv from "dotenv";
dotenv.config();
import HttpError from "../models/Http-error.js";
import User from "../models/User.js";
import { DEFAULT_REGION } from "../util/config/defines.js";
import { extractUserFromRequest } from "../util/functions/security.js";
import { createStripeClient, getStripeKey } from "../util/config/stripe.js";

export const cancelSubscription = async (req, res, next) => {
  const { userId } = extractUserFromRequest(req);

  let user;

  try {
    user = await User.findById(userId);
  } catch (err) {
    return next(
      new HttpError("Could not find the current user, please try again", 500)
    );
  }

  const stripeClient = createStripeClient(user.region);

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

export const postSubscriptionNoFile = async (req, res, next) => {
  const { itemId, origin_url, region } = req.body;
  const { userId } = extractUserFromRequest(req);

  const stripeClient = createStripeClient(DEFAULT_REGION);

  const session = await stripeClient.checkout.sessions.create({
    mode: "subscription",
    allow_promotion_codes: true,
    line_items: [{ price: itemId, quantity: 1 }],
    success_url: `${origin_url}/success`,
    cancel_url: `${origin_url}/fail`,
    metadata: {
      ...req.body,
      userId,
    },
  });

  res.status(200).json({ url: session.url });
};

export const postSubscriptionFile = async (req, res, next) => {
  const { itemId, origin_url, region } = req.body;

  const stripeClient = createStripeClient(DEFAULT_REGION);

  let fileLocation;
  if (req.file) {
    fileLocation = req.file.Location ? req.file.Location : req.file.location;
  }
  const session = await stripeClient.checkout.sessions.create({
    mode: "subscription",
    allow_promotion_codes: true,
    line_items: [{ price: itemId, quantity: 1 }],
    success_url: `${origin_url}/success`,
    cancel_url: `${origin_url}/fail`,
    metadata: {
      file: fileLocation ? fileLocation : null,
      ...req.body,
    },
  });

  res.status(200).json({ url: session.url });
};

export const postCheckoutNoFile = async (req, res, next) => {
  const { itemId, origin_url, region } = req.body;
  const addOns = req.body.addOns ? JSON.parse(req.body.addOns) : [];
  let { quantity } = req.body;

  const stripeClient = createStripeClient(region);

  if (!quantity || isNaN(quantity) || quantity < 1) {
    quantity = 1;
  }

  const lineItems = [{ price: itemId, quantity }];

  if (addOns.length > 0) {
    for (let i = 0; i < addOns.length; i++) {
      if (!addOns[i]?.priceId) {
        continue;
      }

      lineItems.push({
        price: addOns[i].priceId,
        quantity: addOns[i].quantity ?? 1,
        description: addOns[i].title ?? "Add-on",
      });
    }
  }

  const session = await stripeClient.checkout.sessions.create({
    mode: "payment",
    allow_promotion_codes: true,
    line_items: lineItems,
    success_url: `${origin_url}/success`,
    cancel_url: `${origin_url}/fail`,
    metadata: {
      ...req.body,
    },
  });

  res.status(200).json({ url: session.url });
};

export const postCheckoutFile = async (req, res, next) => {
  const { itemId, origin_url, region } = req.body;
  const addOns = req.body.addOns ? JSON.parse(req.body.addOns) : [];
  let { quantity } = req.body;

  const stripeClient = createStripeClient(region);

  if (!quantity || isNaN(quantity) || quantity < 1) {
    quantity = 1;
  }

  const lineItems = [{ price: itemId, quantity }];
  
  if (addOns.length > 0) {
    for (let i = 0; i < addOns.length; i++) {
      if (!addOns[i]?.priceId) {
        continue;
      }

      lineItems.push({
        price: addOns[i].priceId,
        quantity: addOns[i].quantity ?? 1,
        description: addOns[i].title ?? "Add-on",
      });
    }
  }

  let fileLocation;

  if (req.file) {
    fileLocation = req.file.Location ? req.file.Location : req.file.location;
  }

  const session = await stripeClient.checkout.sessions.create({
    mode: "payment",
    allow_promotion_codes: true,
    line_items: lineItems,
    success_url: `${origin_url}/success`,
    cancel_url: `${origin_url}/fail`,
    metadata: {
      file: fileLocation ? fileLocation : null,
      ...req.body,
    },
  });

  res.status(200).json({ url: session.url });
};

export const postCustomerPortal = async (req, res, next) => {
  const { url } = req.body;
  const { userId } = extractUserFromRequest(req);

  let user;

  try {
    user = await User.findById(userId);
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

  try {
    session = await stripeClient.billingPortal.sessions.create({
      customer: user.subscription.customerId,
      return_url: url,
    });
  } catch (err) {
    console.log(err);
    return next(
      new HttpError("Operation failed - please contact support!", 500)
    );
  }

  res.status(200).json({ url: session.url });
};

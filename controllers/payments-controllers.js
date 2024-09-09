import dotenv from "dotenv";
dotenv.config();
import bcrypt from "bcryptjs";
import Stripe from "stripe";
import HttpError from "../models/Http-error.js";
import mongoose from "mongoose";
import Event from "../models/Event.js";
import User from "../models/User.js";
import { sendTicketEmail, welcomeEmail } from "../services/side-services/email-transporter.js";
import { eventToSpreadsheet, usersToSpreadsheet } from "../services/side-services/google-spreadsheets.js";
import { decryptData } from "../util/functions/helpers.js";
import { MOMENT_DATE_YEAR, addMonthsToDate, calculatePurchaseAndExpireDates } from "../util/functions/dateConvert.js";
import { SUBSCRIPTION_PERIOD } from "../util/config/defines.js";
import moment from "moment";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2022-08-01",
});

const cancelSubscription = async (req, res, next) => {
  const userId = req.body.userId;

  let user;

  try {
    user = await User.findById(userId);
  } catch (err) {
    return next(
      new HttpError(
        "Could not find the current user, please try again",
        500
      )
    );
  }

  try {
    await stripe.subscriptions.update(
      user.subscription.id,
      {
        cancel_at_period_end: true,
      }
    );
  } catch (err) {
    new HttpError(
      "Something went wrong, please try again!",
      500
    )
  }

  res.status(200).json({ message: 'Membership was canceled - you can still access your account and use discounts until the expiration date!' });
}

const donationConfig = (req, res) => {
  res.send({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
  });
}

const postDonationIntent = async (req, res, next) => {
  const { amount, name, comments } = req.body;

  if (amount < 2 || amount > 10000) {
    return res.status(200).json({ status: false, message: "Amount must be between the range of 2 and 10 000 euro" });
  }

  if (name.length > 50 || comments.length > 100) {
    return res.status(200).json({ status: false, message: "Something went wrong - please update the details and try again!" });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
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
}

const postSubscriptionNoFile = async (req, res, next) => {
  const { itemId, origin_url } = req.body;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    allow_promotion_codes: true,
    line_items: [{ price: itemId, quantity: 1 }],
    success_url: `${origin_url}/success`,
    cancel_url: `${origin_url}/fail`,
    metadata: {
      ...req.body,
    },
  });

  res.status(200).json({ url: session.url });
};

const postSubscriptionFile = async (req, res, next) => {
  const { itemId, origin_url } = req.body;

  let fileLocation
  if (req.file) {
    fileLocation = req.file.Location ? req.file.Location : req.file.location
  }
  const session = await stripe.checkout.sessions.create({
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
}

const postCheckoutNoFile = async (req, res, next) => {
  const { itemId, origin_url } = req.body;
  let { quantity } = req.body;

  if (!quantity || isNaN(quantity) || quantity < 1) {
    quantity = 1
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    allow_promotion_codes: true,
    line_items: [{ price: itemId, quantity: quantity }],
    success_url: `${origin_url}/success`,
    cancel_url: `${origin_url}/fail`,
    metadata: {
      ...req.body,
    },
  });

  res.status(200).json({ url: session.url });
};

const postCheckoutFile = async (req, res, next) => {
  const { itemId, origin_url } = req.body;
  let { quantity } = req.body;

  if (!quantity || isNaN(quantity) || quantity < 1) {
    quantity = 1
  }

  let fileLocation
  if (req.file) {
    fileLocation = req.file.Location ? req.file.Location : req.file.location
  }
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    allow_promotion_codes: true,
    line_items: [{ price: itemId, quantity: quantity }],
    success_url: `${origin_url}/success`,
    cancel_url: `${origin_url}/fail`,
    metadata: {
      file: fileLocation ? fileLocation : null,
      ...req.body,
    },
  });

  res.status(200).json({ url: session.url });
};

const postCustomerPortal = async (req, res, next) => {
  const { customerId, url } = req.body;

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: url,
  });

  res.status(200).json({ url: session.url });
};

const postWebhookCheckout = async (req, res, next) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = 'whsec_ngneD8G5SlOB1rE3an9VttnRu3LFXHSq';

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  const customerId = event.data.object.customer ?? '';
  const subscriptionId = event.data.object.subscription ?? '';
  const metadata = event.data.object.metadata ?? '';
  const eventType = event.type ?? '';

  switch (eventType) {
    case 'checkout.session.completed':
      switch (metadata.method) {
        case "signup": {
          const {
            longTerm,
            name,
            region,
            period,
            surname,
            birth,
            phone,
            email,
            university,
            otherUniversityName,
            graduationDate,
            course,
            studentNumber,
            notificationTypeTerms,
          } = metadata;

          const password = decryptData(metadata.password);

          let hashedPassword;
          try {
            hashedPassword = await bcrypt.hash(password, 12);
          } catch (err) {
            return next(new HttpError(err.message, 500));
          }

          let image;
          if (!metadata.file) {
            image = `/assets/images/avatars/bg_other_avatar_${Math.floor(
              Math.random() * 3 + 1
            )}.jpeg`;
          } else {
            image = metadata.file;
          }

          const { purchaseDate, expireDate } = calculatePurchaseAndExpireDates(period);

          const createdUser = new User({
            status: "active",
            subscription: {
              period,
              id: subscriptionId,
              customerId
            },
            region,
            purchaseDate,
            expireDate,
            image,
            name,
            surname,
            birth: new Date(birth),
            phone,
            email,
            university,
            otherUniversityName,
            graduationDate,
            course,
            studentNumber,
            password: hashedPassword,
            notificationTypeTerms,
            tickets: [],
          });

          try {
            await createdUser.save();
          } catch (err) {
            return next(new HttpError(err.message, 500));
          }

          welcomeEmail(email, name, region)

          await usersToSpreadsheet(region);
          await usersToSpreadsheet();

          res.status(200).json({ received: true });
        }
        case "unlock_account": {
          const userId = metadata.userId;
          const period = metadata.period;

          let user;

          try {
            user = await User.findById(userId);
          } catch (err) {
            return next(new HttpError(err.message, 500));
          }

          user.status = "active";
          user.subscription = {
            period, id: subscriptionId, customerId
          }

          const { purchaseDate, expireDate } = calculatePurchaseAndExpireDates(period);

          user.purchaseDate = purchaseDate;
          user.expireDate = expireDate;

          try {
            await user.save();
          } catch (err) {
            return next(new HttpError(err.message, 500));
          }

          await usersToSpreadsheet(user.region);
          await usersToSpreadsheet();

          res.status(200).json({ received: true });
        }
        case "buy_guest_ticket": {
          let { quantity, eventId, guestName, guestEmail, guestPhone, preferences } =
            metadata;

          let societyEvent;
          try {
            societyEvent = await Event.findById(eventId);
          } catch (err) {
            return next(new HttpError(err.message, 500));
          }
          let guest = {
            type: "guest",
            name: guestName,
            email: guestEmail,
            phone: guestPhone,
            preferences,
            ticket: metadata.file,
          };

          for (let i = 0; i < quantity; i++) {
            try {
              const sess = await mongoose.startSession();
              sess.startTransaction();
              societyEvent.guestList.push(guest);
              await societyEvent.save();
              await sess.commitTransaction();
            } catch (err) {
              console.log(err);
              return next(new HttpError(err.message, 500));
            }
          }

          await sendTicketEmail(
            "guest",
            guestEmail,
            societyEvent.title,
            moment(societyEvent.date).format(MOMENT_DATE_YEAR),
            guestName,
            metadata.file
          );

          await eventToSpreadsheet(societyEvent.id);

          res.status(200).json({ received: true });
        }
        case "buy_member_ticket": {
          const { eventId, userId, preferences } = metadata;
          let societyEvent;
          try {
            societyEvent = await Event.findById(eventId);
          } catch (err) {
            return next(new HttpError(err.message, 500));
          }

          if (!societyEvent) {
            return next(new HttpError("Could not find such event", 404));
          }

          let targetUser;
          try {
            targetUser = await User.findById(userId);
          } catch (err) {
            return next(new HttpError(err.message, 500));
          }
          try {
            const sess = await mongoose.startSession();
            sess.startTransaction();
            societyEvent.guestList.push({
              type: "member",
              name: targetUser.name + " " + targetUser.surname,
              email: targetUser.email,
              phone: targetUser.phone,
              preferences,
              ticket: metadata.file,
            });

            targetUser.tickets.push({
              event: societyEvent.title + ' | ' + moment(societyEvent.date).format(MOMENT_DATE_YEAR),
              image: metadata.file,
            });
            await societyEvent.save();
            await targetUser.save();
            await sess.commitTransaction();
          } catch (err) {
            return next(new HttpError(err.message, 500));
          }

          await sendTicketEmail(
            "member",
            targetUser.email,
            societyEvent.title,
            moment(societyEvent.date).format(MOMENT_DATE_YEAR),
            targetUser.name,
            metadata.file
          );

          await eventToSpreadsheet(societyEvent.id);

          res.status(200).json({ received: true });
        }
        default: console.log('No case');
      }
    case 'invoice.paid': {
      // no data meaning customer has just been created
      if (!subscriptionId) {
        return res.status(200).json({ received: true, message: 'No action performed' });
      }

      let user;

      try {
        user = await User.findOne({ 'subscription.id': subscriptionId});
      } catch (err) {
        return next(new HttpError(err.message, 500));
      }

      if (!user) {
        return next(new HttpError('No user found', 500));
      }

      const priceId = event.data.object.lines.data[0].price.id || '';
      const period = SUBSCRIPTION_PERIOD[priceId] ?? 12;

      const { purchaseDate, expireDate } = calculatePurchaseAndExpireDates(period);

      user.purchaseDate = purchaseDate;
      user.expireDate = expireDate;
      user.status = 'active'

      try {
        await user.save();
      } catch (err) {
        return next(new HttpError(err.message, 500));
      }

      await usersToSpreadsheet(user.region);
      await usersToSpreadsheet();

      res.status(200).json({ received: true });
    }
    case 'invoice.payment_failed': {
      let user;

      try {
        user = await User.findOne({ 'subscription.id': subscriptionId });
      } catch (err) {
        return next(new HttpError(err.message, 500));
      }

      if (!user) {
        return next(new HttpError('No such user', 500));
      }

      user.status = 'locked'

      try {
        await user.save();
      } catch (err) {
        return next(new HttpError(err.message, 500));
      }

      await usersToSpreadsheet(user.region);
      await usersToSpreadsheet();

      //send email to update payment method or open account 

      res.status(200).json({ received: true });
    }
    default:
      console.log('Unhandled event for subscription');
  }

  res.status(200).json({ received: true });
}

export {
  cancelSubscription,
  donationConfig,
  postDonationIntent,
  postCheckoutNoFile,
  postCheckoutFile,
  postSubscriptionNoFile,
  postSubscriptionFile,
  postCustomerPortal,
  postWebhookCheckout,
};

import dotenv from "dotenv";
dotenv.config();
import bcrypt from "bcryptjs";
import Stripe from "stripe";
import HttpError from "../models/Http-error.js";
import mongoose from "mongoose";
import Event from "../models/Event.js";
import User from "../models/User.js";
import { sendTicketEmail, welcomeEmail } from "../services/email-transporter.js";
import moment from 'moment'
import { formatReverseDate } from "../util/functions/dateConvert.js";
import { eventToSpreadsheet, usersToSpreadsheet } from "../services/google-spreadsheets.js";

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

  const customerId = event.data.object.customer;
  const subscriptionId = event.data.object.subscription
  const metadata = event.data.object.metadata;
  const eventType = event.type;

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
            password,
            notificationTypeTerms,
          } = metadata;

          let hashedPassword;
          try {
            hashedPassword = await bcrypt.hash(password, 12);
          } catch (err) {
            return next(new HttpError("Could not create a new user", 500));
          }

          let image;
          if (!metadata.file) {
            image = `/assets/images/avatars/bg_other_avatar_${Math.floor(
              Math.random() * 3 + 1
            )}.jpeg`;
          } else {
            image = metadata.file;
          }

          const today = new Date()
          const expire = new Date(today.setMonth(today.getMonth() + period))

          const createdUser = new User({
            status: "active",
            subscription: {
              period,
              id: subscriptionId,
              customerId
            },
            region,
            purchaseDate: moment(new Date()).format("D MMM YYYY"),
            expireDate: moment(new Date()).add(period, 'months').format("D MMM YYYY"),
            image,
            name,
            surname,
            birth: moment(birth).format("D MMM YYYY"),
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
            const error = new HttpError("Signing up failed", 500);
            return next(error);
          }

          welcomeEmail(email, name, region)

          usersToSpreadsheet(region);
          usersToSpreadsheet(null, false);

          break;
        }
        case "unlock_account": {
          const userId = metadata.userId;
          const period = metadata.period;

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

          //cancel old subscription 

          try {
            await stripe.subscriptions.update(
              user.subscription.id,
              {
                cancel_at_period_end: true,
              }
            );
          } catch (err) {

          }

          user.status = "active";
          user.subscription = {
            period, id: subscriptionId, customerId
          }

          user.purchaseDate = moment(new Date()).format("D MMM YYYY")
          user.expireDate = moment(new Date()).add(period, 'months').format("D MMM YYYY")

          try {
            await user.save();
          } catch (err) {
            return next(
              new HttpError("Something went wrong, please try again", 500)
            );
          }

          usersToSpreadsheet(user.region, true)

          break;
        }
        case "buy_guest_ticket": {
          let { quantity, eventId, guestName, guestEmail, guestPhone, preferences, marketing } =
            metadata;

          let societyEvent;
          try {
            societyEvent = await Event.findById(eventId);
          } catch (err) {
            return next(
              new HttpError(
                "Could not add you to the event, please try again!",
                500
              )
            );
          }
          let guest = {
            type: "guest",
            timestamp: new Date().toString(),
            name: guestName,
            email: guestEmail,
            phone: guestPhone,
            preferences,
            marketing,
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
              return next(
                new HttpError(
                  "Adding guest to the event failed, please try again",
                  500
                )
              );
            }
          }

          sendTicketEmail(
            "guest",
            guestEmail,
            eventName,
            eventDate,
            guestName,
            metadata.file
          );

          eventToSpreadsheet(societyEvent.id, eventName, region)

          break;
        }
        case "buy_member_ticket": {
          const { eventId, userId, preferences } = metadata;
          let societyEvent;
          try {
            societyEvent = await Event.findById(eventId);
          } catch (err) {
            return next(
              new HttpError(
                "Could not add you to the event, please try again!",
                500
              )
            );
          }

          if (!societyEvent) {
            return next(new HttpError("Could not find such event", 404));
          }

          let targetUser;
          try {
            targetUser = await User.findById(userId);
          } catch (err) {
            new HttpError("Could not find a user with provided id", 404);
          }
          try {
            const sess = await mongoose.startSession();
            sess.startTransaction();
            societyEvent.guestList.push({
              type: "member",
              timestamp: new Date().toString(),
              name: targetUser.name + " " + targetUser.surname,
              email: targetUser.email,
              phone: targetUser.phone,
              preferences,
              ticket: metadata.file,
            });

            targetUser.tickets.push({
              event: eventName,
              purchaseDate: new Date().toString(),
              image: metadata.file,
            });
            await societyEvent.save();
            await targetUser.save();
            await sess.commitTransaction();
          } catch (err) {
            return next(
              new HttpError(
                "Adding user to the event failed, please try again",
                500
              )
            );
          }

          sendTicketEmail(
            "member",
            targetUser.email,
            eventName,
            eventDate,
            targetUser.name,
            metadata.file
          );

          eventToSpreadsheet(societyEvent.id, eventName, region)

          break;
        }
        default: console.log('No case');
      }
      break;
    case 'invoice.paid': {
      let user;

      try {
        user = await User.findOne({ 'subscription.id': subscriptionId, 'subscription.customerId': customerId });
      } catch (err) {
        break;
      }

      if (!user) {
        break;
      }

      const price = event.data.object.lines.data[0].price.id || '';

      let period

      if (price === 'price_1OuqmtIOw5UGbAo1V4TqMet4') {
        period = 6
      }

      if (price === 'price_1Otbd6IOw5UGbAo1rdJ7wXp3') {
        period = 12
      }

      user.status = 'active'
      user.purchaseDate = moment(new Date()).format("D MMM YYYY")
      user.expireDate = moment(new Date()).add(period, 'months').format("D MMM YYYY")

      try {
        await user.save();
      } catch (err) {
        return next(
          new HttpError("Something went wrong, please try again", 500)
        );
      }

      usersToSpreadsheet(user.region, true)

      break;
    }
    case 'invoice.payment_failed': {
      let user;

      try {
        user = await User.findOne({ 'subscription.id': subscriptionId, 'subscription.customerId': customerId });
      } catch (err) {
        break;
      }

      if (!user) {
        break;
      }

      user.status = 'locked'

      try {
        await user.save();
      } catch (err) {
        return next(
          new HttpError("Something went wrong, please try again", 500)
        );
      }

      usersToSpreadsheet(user.region, true)

      //send email to update payment method or open account 

      break;
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

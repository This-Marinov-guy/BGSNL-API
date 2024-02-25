import dotenv from "dotenv";
dotenv.config();
import bcrypt from "bcryptjs";
import Stripe from "stripe";
import HttpError from "../models/Http-error.js";
import mongoose from "mongoose";
import Event from "../models/Event.js";
import User from "../models/User.js";
import { sendTicketEmail, welcomeEmail } from "../middleware/email-transporter.js";
import { format } from "date-fns";
import { formatReverseDate } from "../util/dateConvert.js";
import { eventToSpreadsheet, usersToSpreadsheet } from "../util/searchInDatabase.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2022-08-01",
});

const donationConfig = (req, res) => {
  res.send({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
  });
}

const postDonationIntent = async (req, res) => {
  const { amount, name, comments } = req.body;
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
    console.log(paymentIntent.client_secret);
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

const postCheckoutNoFile = async (req, res, next) => {
  const { itemId, origin_url } = req.body;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: itemId, quantity: 1 }],
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

  let fileLocation
  if (req.file) {
    fileLocation = req.file.Location ? req.file.Location : req.file.location
  }
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
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

  if (
    event.type === "checkout.session.async_payment_succeeded" ||
      event.type === "checkout.session.completed"
  ) {
    // Handle the event
    const metadata = event.data.object.metadata;
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

        const expireYear = new Date().getFullYear + period

        const createdUser = new User({
          status: "active",
          region,
          purchaseDate: format(new Date(), "dd MMM yyyy"),
          //membership is 4 months
          expireDate: "31 Aug" + expireYear,
          image,
          name,
          surname,
          birth: formatReverseDate(birth),
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

        welcomeEmail(email, name)

        usersToSpreadsheet(region, true);

        break;
      }
      case "buy_guest_ticket": {
        let { eventName, region, eventDate, guestName, guestEmail, guestPhone, preferences } =
          metadata;

        let societyEvent;
        try {
          societyEvent = await Event.findOneOrCreate(
            { event: eventName, region, date: eventDate },
            { status: 'open', event: eventName, region, date: eventDate, guestList: [] }
          );
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
          ticket: metadata.file,
        };
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
        const { eventName, region, eventDate, userId, preferences } = metadata;
        let societyEvent;
        try {
          societyEvent = await Event.findOneOrCreate(
            { event: eventName, region, date: eventDate },
            { status: 'open', event: eventName, region, date: eventDate, guestList: [] }
          );
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
      case "unlock_account": {
        const userId = metadata.userId;
        const longTerm = metadata.longTerm;

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

        user.status = "active";
        user.purchaseDate = format(new Date(), "dd MMM yyyy");
        user.expireDate = longTerm === 'true' ? "31 Aug 2027" : "31 Aug 2025";

        try {
          await user.save();
        } catch (err) {
          return next(
            new HttpError("Something went wrong, please try again", 500)
          );
        }

        usersToSpreadsheet(user.status, true)

        break;
      }
      default:
        console.log(`Unhandled event type ${event.type}`);
    }
  } 

  res.status(200).json({ received: true });
};

export {
  donationConfig,
  postDonationIntent,
  postCheckoutNoFile,
  postCheckoutFile,
  postWebhookCheckout,
};

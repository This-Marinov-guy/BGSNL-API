import dotenv from "dotenv";
dotenv.config();
import bcrypt from "bcryptjs";
import HttpError from "../../models/Http-error.js";
import mongoose from "mongoose";
import Event from "../../models/Event.js";
import User from "../../models/User.js";
import {
  paymentFailedEmail,
  sendTicketEmail,
  welcomeEmail,
} from "../../services/side-services/email-transporter.js";
import {
  eventToSpreadsheet,
  usersToSpreadsheet,
} from "../../services/side-services/google-spreadsheets.js";
import { chooseRandomAvatar, decryptData, hasOverlap } from "../../util/functions/helpers.js";
import {
  MOMENT_DATE_YEAR,
  calculatePurchaseAndExpireDates,
} from "../../util/functions/dateConvert.js";
import {
  DEFAULT_REGION,
  HOME_URL,
  LIMITLESS_ACCOUNT,
  SUBSCRIPTION_PERIOD,
} from "../../util/config/defines.js";
import moment from "moment";
import { ACTIVE, LOCKED, USER_STATUSES } from "../../util/config/enums.js";
import {
  createStripeClient,
  getStripeKey,
} from "../../util/config/stripe.js";

export const postWebhookCheckout = async (req, res, next) => {
  const userRegion = req.query.region ?? "netherlands";
  const sig = req.headers["stripe-signature"];
  const endpointSecret = getStripeKey("webhookSecretKey", userRegion);
  const stripeClient = createStripeClient(userRegion);

  let event;

  try {
    event = stripeClient.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  const customerId = event.data.object.customer ?? "";
  const subscriptionId = event.data.object.subscription ?? "";
  const metadata = event.data.object.metadata ?? "";
  const eventType = event.type ?? "";
  let responseMessage = "";

  switch (eventType) {
    case "checkout.session.completed":
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
            image = chooseRandomAvatar();
          } else {
            image = metadata.file;
          }

          const { purchaseDate, expireDate } =
            calculatePurchaseAndExpireDates(period);

          const createdUser = new User({
            status: USER_STATUSES[ACTIVE],
            subscription: {
              period,
              id: subscriptionId,
              customerId,
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

          await welcomeEmail(email, name, region);

          await usersToSpreadsheet(region);
          await usersToSpreadsheet();

          return res.status(200).json({ received: true });
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

          user.status = USER_STATUSES[ACTIVE];
          user.subscription = {
            period,
            id: subscriptionId,
            customerId,
          };

          const { purchaseDate, expireDate } =
            calculatePurchaseAndExpireDates(period);

          user.purchaseDate = purchaseDate;
          user.expireDate = expireDate;

          try {
            await user.save();
          } catch (err) {
            return next(new HttpError(err.message, 500));
          }

          await usersToSpreadsheet(user.region);
          await usersToSpreadsheet();

          return res.status(200).json({ received: true });
        }
        case "buy_guest_ticket": {
          let {
            quantity,
            eventId,
            code,
            guestName,
            guestEmail,
            guestPhone,
            preferences,
            type,
          } = metadata;

          let societyEvent;
          try {
            societyEvent = await Event.findById(eventId);
          } catch (err) {
            return next(new HttpError(err.message, 500));
          }
          let guest = {
            type: type ?? "guest",
            code,
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
            societyEvent.date,
            guestName,
            metadata.file
          );

          await eventToSpreadsheet(societyEvent.id);

          return res.status(200).json({ received: true });
        }
        case "buy_member_ticket": {
          const { eventId, userId, code, preferences, type } = metadata;
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
              type: type ?? "member",
              code,
              name: targetUser.name + " " + targetUser.surname,
              email: targetUser.email,
              phone: targetUser.phone,
              preferences,
              ticket: metadata.file,
            });

            targetUser.tickets.push({
              event:
                societyEvent.title +
                " | " +
                moment(societyEvent.date).format(MOMENT_DATE_YEAR),
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
            societyEvent.date,
            targetUser.name,
            metadata.file
          );

          await eventToSpreadsheet(societyEvent.id);

          return res.status(200).json({ received: true });
        }
        default:
          return res.status(200).json({
            received: true,
            message: "Unhandled event for checkout webhook",
          });
      }
    case "invoice.paid": {
      if (!subscriptionId) {
        responseMessage = "No user to update";
        break;
      }

      let user;

      try {
        user = await User.findOne({ "subscription.id": subscriptionId });
      } catch (err) {
        responseMessage = "No user to update";
        break;
      }

      if (!user) {
        responseMessage = "No user to update";
        break;
      }

      const priceId = event.data.object.lines.data[0].price.id || "";
      const period = SUBSCRIPTION_PERIOD[priceId] ?? 12;

      const { purchaseDate, expireDate } =
        calculatePurchaseAndExpireDates(period);

      user.status = USER_STATUSES[ACTIVE];
      user.purchaseDate = purchaseDate;
      user.expireDate = expireDate;

      try {
        await user.save();
      } catch (err) {
        return next(new HttpError(err.message, 500));
      }

      await usersToSpreadsheet(user.region);
      await usersToSpreadsheet();

      return res.status(200).json({ received: true });
    }
    case "invoice.payment_failed":
    case "invoice.payment_action_required": {
      let user;

      try {
        user = await User.findOne({ "subscription.id": subscriptionId });
      } catch (err) {
        responseMessage = "No user to update";
        break;
      }

      if (!user) {
        responseMessage = "No user to update";
        break;
      }

      const today = new Date();

      if (
        !hasOverlap(LIMITLESS_ACCOUNT, user?.roles) &&
        today > user.expireDate
      ) {
        user.status = USER_STATUSES[LOCKED];

        try {
          await user.save();
        } catch (err) {
          return next(new HttpError(err.message, 500));
        }

        try {
          await usersToSpreadsheet(user.region);
          await usersToSpreadsheet();

          const stripeClient = createStripeClient(DEFAULT_REGION);

          const session = await stripeClient.billingPortal.sessions.create({
            customer: user.customerId,
            return_url: HOME_URL,
          });

          await paymentFailedEmail(user.email, session.url);
        } catch (err) {
          console.log(err);
        }
      }

      return res.status(200).json({ received: true });
    }
    default:
      return res.status(200).json({
        received: true,
        message: "Unhandled event for subscription/checkout webhook",
      });
  }

  return res.status(200).json({
    received: true,
    message: responseMessage || "No action performed",
  });
};

import dotenv from "dotenv";
dotenv.config();
import bcrypt from "bcryptjs";
import HttpError from "../../models/Http-error.js";
import mongoose from "mongoose";
import Event from "../../models/Event.js";
import User from "../../models/User.js";
import AlumniUser from "../../models/AlumniUser.js";
import {
  paymentFailedEmail,
  sendTicketEmail,
  welcomeEmail,
  alumniWelcomeEmail,
} from "../../services/side-services/email-transporter.js";
import {
  alumniToSpreadsheet,
  eventToSpreadsheet,
  usersToSpreadsheet,
} from "../../services/side-services/google-spreadsheets.js";
import { findUserByQuery } from "../../services/main-services/user-service.js";
import {
  chooseRandomAvatar,
  decryptData,
  hasOverlap,
} from "../../util/functions/helpers.js";
import {
  MOMENT_DATE_YEAR,
  calculatePurchaseAndExpireDates,
} from "../../util/functions/dateConvert.js";
import {
  ADMIN,
  ALUMNI,
  DEFAULT_REGION,
  HOME_URL,
  LIMITLESS_ACCOUNT,
  SUBSCRIPTION_PERIOD_BY_ID,
  USER_URL,
  ALUMNI_TIER_BY_PRICE_ID,
} from "../../util/config/defines.js";
import moment from "moment";
import { ACTIVE, ALUMNI_MIGRATED, LOCKED, USER_STATUSES } from "../../util/config/enums.js";
import { createStripeClient, getStripeKey } from "../../util/config/stripe.js";
import { findUserById } from "../../services/main-services/user-service.js";

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
    case "checkout.session.async_payment_succeeded":
      switch (metadata.method) {
        case "alumni-signup": {
          const { tier, period, name, surname, email } = metadata;

          const password = decryptData(metadata.password);

          let hashedPassword;
          try {
            hashedPassword = await bcrypt.hash(password, 12);
          } catch (err) {
            return next(new HttpError("Could not create a new user", 500));
          }

          let image;
          if (!metadata.file) {
            image = chooseRandomAvatar();
          } else {
            image = metadata.file;
          }

          const { purchaseDate, expireDate } =
            calculatePurchaseAndExpireDates(1);

          const createdUser = new AlumniUser({
            status: USER_STATUSES[ACTIVE],
            subscription: {
              period,
              id: subscriptionId,
              customerId,
            },
            tier,
            purchaseDate,
            expireDate,
            image,
            name,
            surname,
            email,
            password: hashedPassword,
            tickets: [],
            roles: [ADMIN],
          });

          try {
            await createdUser.save();
          } catch (err) {
            const error = new HttpError("Signing up failed", 500);
            return next(error);
          }

          await alumniToSpreadsheet();
          await alumniWelcomeEmail(email, name);

          return res.status(200).json({ received: true });
        }
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
            user = await findUserById(userId);
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
            addOns,
            type,
          } = metadata;

          let societyEvent;
          try {
            societyEvent = await Event.findById(eventId);
          } catch (err) {
            return next(new HttpError(err.message, 500));
          }

          addOns = addOns !== undefined ? JSON.parse(addOns) : [];

          let guest = {
            type: type ?? "guest",
            code,
            name: guestName,
            email: guestEmail,
            phone: guestPhone,
            preferences,
            addOns,
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
            targetUser = await findUserByQuery({_id: userId});
          } catch (err) {
            return next(new HttpError(err.message, 500));
          }

          const addOns = metadata?.addOns ? JSON.parse(metadata?.addOns) : [];

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
              addOns,
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
        case "alumni_migration": {
          const { userId, tier, period } = metadata;
          
          // Find the regular user
          let regularUser;
          try {
            regularUser = await User.findOne({_id: userId});
            
            if (!regularUser) {
              console.error(`No user found with ID: ${userId}`);
              return res.status(200).json({ 
                received: true,
                message: "User not found for migration" 
              });
            }
          } catch (err) {
            console.error(`Error finding user: ${err.message}`);
            return res.status(200).json({ 
              received: true, 
              message: "Error finding user for migration" 
            });
          }
          
          // Extract the ObjectId part if the user already has a prefixed ID
          let objectIdPart;
          if (typeof regularUser._id === 'string' && regularUser._id.includes('member_')) {
            const idMatch = regularUser._id.match(/member_(.*)/);
            if (idMatch && idMatch[1]) {
              objectIdPart = idMatch[1];
            } else {
              console.error(`ID format invalid: ${regularUser._id}`);
              return res.status(200).json({ 
                received: true, 
                message: "Invalid user ID format for migration" 
              });
            }
          } else {
            // If the user has a regular ObjectId, convert it to string
            objectIdPart = regularUser._id.toString();
          }
          
          // Create the alumni ID with the same ObjectId part
          const alumniId = `alumni_${objectIdPart}`;
          
          // Check if we need to cancel an existing subscription
          let oldSubscriptionId = null;
          if (regularUser.subscription && regularUser.subscription.id) {
            oldSubscriptionId = regularUser.subscription.id;
            
            // Cancel old subscription
            try {
              const stripeClient = createStripeClient(regularUser.region || DEFAULT_REGION);
              await stripeClient.subscriptions.cancel(oldSubscriptionId);
              console.log(`Cancelled subscription ${oldSubscriptionId} for user ${userId}`);
            } catch (err) {
              console.error(`Error cancelling subscription: ${err.message}`);
              // Continue with the migration even if cancellation fails
            }
          }
          
          const { purchaseDate, expireDate } = calculatePurchaseAndExpireDates(period || 12);
          
          // Check if an alumni user already exists
          let existingAlumni;
          try {
            existingAlumni = await AlumniUser.findOne({ 
              $or: [
                { _id: alumniId },
                { email: regularUser.email }
              ]
            });
          } catch (err) {
            console.error(`Error checking existing alumni: ${err.message}`);
          }
          
          let alumniUser;
          
          try {
            if (existingAlumni) {
              // Update existing alumni user
              existingAlumni.name = regularUser.name;
              existingAlumni.surname = regularUser.surname;
              existingAlumni.email = regularUser.email;
              existingAlumni.image = regularUser.image || "";
              existingAlumni.status = USER_STATUSES[ACTIVE];
              existingAlumni.tier = tier || 0;
              existingAlumni.subscription = {
                period,
                id: subscriptionId,
                customerId,
              };
              existingAlumni.purchaseDate = purchaseDate;
              existingAlumni.expireDate = expireDate;
              existingAlumni.joinDate = existingAlumni.joinDate || new Date();
              
              // Make sure the alumni role is set
              if (!existingAlumni.roles.includes(ALUMNI)) {
                existingAlumni.roles.push(ALUMNI);
              }
              
              await existingAlumni.save();
              alumniUser = existingAlumni;
              console.log(`Updated alumni user ${alumniId} for migration`);
            } else {
              // Create new alumni user
              const newAlumniUser = new AlumniUser({
                _id: alumniId,
                name: regularUser.name,
                surname: regularUser.surname,
                email: regularUser.email,
                password: regularUser.password,
                image: regularUser.image || "",
                status: USER_STATUSES[ACTIVE],
                tier: tier || 0,
                roles: [ALUMNI],
                subscription: {
                  period,
                  id: subscriptionId,
                  customerId,
                },
                joinDate: new Date(),
                purchaseDate,
                expireDate,
                tickets: regularUser.tickets || [],
                christmas: regularUser.christmas || []
              });
              
              await newAlumniUser.save();
              alumniUser = newAlumniUser;
              console.log(`Created new alumni user ${alumniId} for migration`);
            }
            
            // Update regular user status to alumni
            regularUser.status = USER_STATUSES[ALUMNI_MIGRATED];
            await regularUser.save();
            
            // Update spreadsheets
            await alumniToSpreadsheet();
            await usersToSpreadsheet(regularUser.region);
            await usersToSpreadsheet();
            
            // Send welcome email
            await alumniWelcomeEmail(regularUser.email, regularUser.name);
            
            return res.status(200).json({ 
              received: true,
              message: "User successfully migrated to alumni",
              details: {
                userId: regularUser._id,
                alumniId: alumniUser._id,
                oldSubscription: oldSubscriptionId,
                newSubscription: subscriptionId
              }
            });
            
          } catch (err) {
            console.error(`Error during migration: ${err.message}`);
            return res.status(200).json({ 
              received: true, 
              error: `Migration failed: ${err.message}` 
            });
          }
        }
        default:
          return res.status(200).json({
            received: true,
            message: "Unhandled event for checkout webhook",
          });
      }
    case "invoice.paid": {
      if (!subscriptionId || !customerId) {
        responseMessage = "No user to update";
        break;
      }

      let user;

      try {
        user = await findUserByQuery({ "subscription.id": subscriptionId });
      } catch (err) {
        responseMessage = "No user to update";
      }

      if (!user) {
        try {
          user = await findUserByQuery({ "subscription.customerId": customerId });
        } catch (err) {
          responseMessage = "No user to update";
        }
      }

      if (!user) {
        responseMessage = "No user to update";
        break;
      }

      const priceId = event.data.object.lines.data[0].price.id || "";
      const period = SUBSCRIPTION_PERIOD_BY_ID[priceId] ?? 12;

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
      if (!subscriptionId || !customerId) {
        responseMessage = "No user to update";
        break;
      }

      let user;

      try {
        user = await findUserByQuery({ "subscription.id": subscriptionId });
      } catch (err) {
        responseMessage = "No user to update";
      }

      if (!user) {
        try {
          user = await findUserByQuery({ "subscription.customerId": customerId });
        } catch (err) {
          responseMessage = "No user to update";
        }
      }

      if (!user) {
        responseMessage = "No user to update";
        break;
      }

      const today = new Date();

      const isUserLocked = user.status === USER_STATUSES[LOCKED];

      if (
        !isUserLocked &&
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

          await paymentFailedEmail(user.email, USER_URL);
        } catch (err) {
          console.log(err);
        }
      }

      return res.status(200).json({ received: true });
    }
    case "customer.subscription.updated": {
      if (!subscriptionId || !customerId) {
        responseMessage = "No subscription to update";
        break;
      }

      // Get the new price ID from the subscription
      const newPriceId = event.data.object.items.data[0]?.price?.id;
      
      if (!newPriceId) {
        responseMessage = "No price ID found in subscription";
        break;
      }

      // Check if this is an alumni subscription by looking for the price ID in our mapping
      const newTier = ALUMNI_TIER_BY_PRICE_ID[newPriceId];
      
      if (!newTier) {
        responseMessage = "Price ID not found in alumni mapping";
        break;
      }

      // Find the alumni user by subscription ID or customer ID
      let alumniUser;
      try {
        alumniUser = await AlumniUser.findOne({ 
          $or: [
            { "subscription.id": subscriptionId },
            { "subscription.customerId": customerId }
          ]
        });
      } catch (err) {
        console.error(`Error finding alumni user: ${err.message}`);
        responseMessage = "Error finding alumni user";
        break;
      }

      if (!alumniUser) {
        responseMessage = "No alumni user found for this subscription";
        break;
      }

      // Update the tier
      const oldTier = alumniUser.tier;
      alumniUser.tier = newTier;

      try {
        await alumniUser.save();
        console.log(`Updated alumni user ${alumniUser._id} tier from ${oldTier} to ${newTier}`);
        
        // Update spreadsheets
        await alumniToSpreadsheet();
        
        responseMessage = `Alumni tier updated from ${oldTier} to ${newTier}`;
      } catch (err) {
        console.error(`Error updating alumni user tier: ${err.message}`);
        responseMessage = "Error updating alumni user tier";
      }

      return res.status(200).json({ 
        received: true, 
        message: responseMessage,
        details: {
          alumniId: alumniUser._id,
          oldTier,
          newTier,
          priceId: newPriceId
        }
      });
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

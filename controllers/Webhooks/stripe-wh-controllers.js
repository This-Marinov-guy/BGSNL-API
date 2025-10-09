import dotenv from "dotenv";
dotenv.config();
import HttpError from "../../models/Http-error.js";
import { createStripeClient, getStripeKey } from "../../util/config/stripe.js";
import {
  handleAlumniSignup,
  handleUserSignup,
  handleAccountUnlock,
  handleGuestTicketPurchase,
  handleMemberTicketPurchase,
  handleAlumniMigration,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleSubscriptionUpdated,
} from "../../services/main-services/stripe-webhook-service.js";

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

  try {
    switch (eventType) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        switch (metadata.method) {
          case "alumni-signup": {
            await handleAlumniSignup(metadata, subscriptionId, customerId);
            return res.status(200).json({ received: true });
          }
          case "signup": {
            await handleUserSignup(metadata, subscriptionId, customerId);
            return res.status(200).json({ received: true });
          }
          case "unlock_account": {
            await handleAccountUnlock(metadata, subscriptionId, customerId);
            return res.status(200).json({ received: true });
          }
          case "buy_guest_ticket": {
            await handleGuestTicketPurchase(metadata);
            return res.status(200).json({ received: true });
          }
          case "buy_member_ticket": {
            await handleMemberTicketPurchase(metadata);
            return res.status(200).json({ received: true });
          }
          case "alumni_migration": {
            const result = await handleAlumniMigration(metadata, subscriptionId, customerId);
            return res.status(200).json({ 
              received: true,
              ...result
            });
          }
          default:
            return res.status(200).json({
              received: true,
              message: "Unhandled event for checkout webhook",
            });
        }
      case "invoice.paid": {
        const result = await handleInvoicePaid(subscriptionId, customerId, event);
        if (!result.success) {
          responseMessage = result.message;
          break;
        }
        return res.status(200).json({ received: true });
      }
      case "invoice.payment_failed":
      case "invoice.payment_action_required": {
        const result = await handleInvoicePaymentFailed(subscriptionId, customerId);
        if (!result.success) {
          responseMessage = result.message;
          break;
        }
        return res.status(200).json({ received: true });
      }
      case "customer.subscription.updated": {
        const result = await handleSubscriptionUpdated(subscriptionId, customerId, event);
        if (!result.success) {
          responseMessage = result.message;
          break;
        }
        return res.status(200).json({ 
          received: true, 
          message: result.message,
          details: result.details
        });
      }
      default:
        return res.status(200).json({
          received: true,
          message: "Unhandled event for subscription/checkout webhook",
        });
    }
  } catch (error) {
    if (error instanceof HttpError) {
      return next(error);
    }
    return next(new HttpError(error.message || "Internal server error", 500));
  }

  return res.status(200).json({
    received: true,
    message: responseMessage || "No action performed",
  });
};

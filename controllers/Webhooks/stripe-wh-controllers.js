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

  const eventType = event.type ?? "";
  let responseMessage = "";

  // Helper function to extract subscriptionId and customerId based on event type
  const extractIds = (event) => {
    let customerId = "";
    let subscriptionId = "";
    
    switch (eventType) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        customerId = event.data.object.customer ?? "";
        subscriptionId = event.data.object.subscription ?? "";
        break;
      case "invoice.paid":
      case "invoice.payment_failed":
      case "invoice.payment_action_required":
        customerId = event.data.object.customer ?? "";
        subscriptionId = event.data.object.subscription ?? "";
        break;
      case "customer.subscription.updated":
        customerId = event.data.object.customer ?? "";
        subscriptionId = event.data.object.id ?? "";
        break;
      default:
        customerId = event.data.object.customer ?? "";
        subscriptionId = event.data.object.subscription ?? "";
    }
    
    return { customerId, subscriptionId };
  };

  const { customerId, subscriptionId } = extractIds(event);
  const metadata = event.data.object.metadata ?? {};

  // Debug logging for webhook events
  console.log(`Webhook Event: ${eventType}`);
  console.log(`Customer ID: ${customerId}`);
  console.log(`Subscription ID: ${subscriptionId}`);
  console.log(`Metadata:`, JSON.stringify(metadata));

  // Base debug info to include in all responses
  const baseDebugInfo = {
    eventType: eventType || 'unknown',
    customerId: customerId || 'none',
    subscriptionId: subscriptionId || 'none',
    metadata: Object.keys(metadata).length > 0 ? metadata : 'empty',
    timestamp: new Date().toISOString(),
    region: userRegion,
    eventId: event.id || 'unknown'
  };

  try {
    switch (eventType) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        switch (metadata.method) {
          case "alumni-signup": {
            await handleAlumniSignup(metadata, subscriptionId, customerId);
            return res.status(200).json({ 
              received: true,
              message: "Alumni signup completed successfully",
              debug: baseDebugInfo
            });
          }
          case "signup": {
            await handleUserSignup(metadata, subscriptionId, customerId);
            return res.status(200).json({ 
              received: true,
              message: "User signup completed successfully",
              debug: baseDebugInfo
            });
          }
          case "unlock_account": {
            await handleAccountUnlock(metadata, subscriptionId, customerId);
            return res.status(200).json({ 
              received: true,
              message: "Account unlock completed successfully",
              debug: baseDebugInfo
            });
          }
          case "buy_guest_ticket": {
            await handleGuestTicketPurchase(metadata);
            return res.status(200).json({ 
              received: true,
              message: "Guest ticket purchase completed successfully",
              debug: baseDebugInfo
            });
          }
          case "buy_member_ticket": {
            await handleMemberTicketPurchase(metadata);
            return res.status(200).json({ 
              received: true,
              message: "Member ticket purchase completed successfully",
              debug: baseDebugInfo
            });
          }
          case "alumni_migration": {
            const result = await handleAlumniMigration(metadata, subscriptionId, customerId);
            return res.status(200).json({ 
              received: true,
              ...result,
              debug: baseDebugInfo
            });
          }
          default:
            return res.status(200).json({
              received: true,
              message: "Unhandled event for checkout webhook",
              debug: baseDebugInfo
            });
        }
      case "invoice.paid": {
        const result = await handleInvoicePaid(subscriptionId, customerId, event);
        if (!result.success) {
          responseMessage = result.message;
          break;
        }
        return res.status(200).json({ 
          received: true,
          message: "Invoice paid processed successfully",
          debug: baseDebugInfo
        });
      }
      case "invoice.payment_failed":
      case "invoice.payment_action_required": {
        const result = await handleInvoicePaymentFailed(subscriptionId, customerId);
        if (!result.success) {
          responseMessage = result.message;
          break;
        }
        return res.status(200).json({ 
          received: true,
          message: "Invoice payment failed processed successfully",
          debug: baseDebugInfo
        });
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
          details: result.details,
          debug: baseDebugInfo
        });
      }
      default:
        return res.status(200).json({
          received: true,
          message: "Unhandled event for subscription/checkout webhook",
          debug: baseDebugInfo
        });
    }
  } catch (error) {
    console.error("Webhook processing error:", error);
    if (error instanceof HttpError) {
      return next(error);
    }
    return next(new HttpError(error.message || "Internal server error", 500));
  }

  return res.status(200).json({
    received: true,
    message: responseMessage || "No action performed",
    debug: baseDebugInfo
  });
};

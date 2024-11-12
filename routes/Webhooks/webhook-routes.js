import express from "express";
import dotenv from "dotenv";
import { STRIPE_WEBHOOK_ROUTE } from "../../util/config/defines.js";
import { postWebhookCheckout } from "../../controllers/Webhooks/stripe-wh-controllers.js";
dotenv.config();

const webhookRouter = express.Router();

// DO not touch
webhookRouter.post(
  STRIPE_WEBHOOK_ROUTE,
  express.raw({ type: "*/*" }),
  postWebhookCheckout
);

export default webhookRouter;

import express from "express";
import {
  postWebhookCheckout,
} from "../controllers/payments-controllers.js";
import dotenv from "dotenv";
import { STRIPE_WEBHOOK_ROUTE } from "../util/config/defines.js";
dotenv.config();

const webhookRouter = express.Router();

// DO not touch
webhookRouter.post(
  STRIPE_WEBHOOK_ROUTE,
  express.raw({ type: "*/*" }),
  postWebhookCheckout
);

export default webhookRouter;

import express from "express";
import {
  donationConfig,
  postCheckoutFile,
  postCheckoutNoFile,
  postDonationIntent,
  postWebhookCheckout,
} from "../controllers/payments-controllers.js";
import fileUpload from "../middleware/file-upload.js";
import fileResizedUpload from "../middleware/file-resize-upload.js";
import dotenv from "dotenv";
dotenv.config();

const paymentRouter = express.Router();

paymentRouter.get("/donation/config", donationConfig)

paymentRouter.post("/donation/create-payment-intent", postDonationIntent)

paymentRouter.post("/checkout-no-file", postCheckoutNoFile);

paymentRouter.post(
  "/checkout/member",
  fileUpload(process.env.BUCKET_MEMBER_TICKETS).single("image"),
  postCheckoutFile
);
paymentRouter.post(
  "/checkout/guest",
  fileUpload(process.env.BUCKET_GUEST_TICKETS).single("image"),
  postCheckoutFile
);
paymentRouter.post(
  "/checkout/signup",
  fileResizedUpload(process.env.BUCKET_USERS).single("image"),
  postCheckoutFile
);

paymentRouter.post(
  "/webhook-checkout",
  express.raw({ type: "application/json" }),
  postWebhookCheckout
);

export default paymentRouter;

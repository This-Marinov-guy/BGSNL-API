import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import cors from "cors";
import HttpError from "./models/Http-error.js";
import userRouter from "./routes/users-routes.js";
import eventRouter from "./routes/events-routes.js";
import paymentRouter from "./routes/payments-routes.js";
import contestRouter from "./routes/contest-routes.js";
import specialEventsRouter from "./routes/special-events-routes.js";
import { eventToSpreadsheet, usersToSpreadsheet } from './util/searchInDatabase.js'

const app = express();

// TEST ENVIRONMENT
// 1st --> put the localhost url in cors list "http://localhost:3000"
// 2nd --> change the http-hook in React to make  requests to localhost server

//configuration

const allowedOrigins = [
  // "http://localhost:3000",
  'https://bulgariansociety.netlify.app',
  'https://bulgariansociety.nl',
  'https://www.bulgariansociety.nl',
  'https://starfish-app-tvh24.ondigitalocean.app'
];

const stripeUrls = [
  'https://a.stripecdn.com',
  'https://api.stripe.com',
  'https://atlas.stripe.com',
  'https://auth.stripe.com',
  'https://b.stripecdn.com',
  'https://billing.stripe.com',
  'https://buy.stripe.com',
  'https://c.stripecdn.com',
  'https://checkout.stripe.com',
  'https://climate.stripe.com',
  'https://connect.stripe.com',
  'https://dashboard.stripe.com',
  'https://express.stripe.com',
  'https://files.stripe.com',
  'https://hooks.stripe.com',
  'https://invoice.stripe.com',
  'https://invoicedata.stripe.com',
  'https://js.stripe.com',
  'https://m.stripe.com',
  'https://m.stripe.network',
  'https://manage.stripe.com',
  'https://pay.stripe.com',
  'https://payments.stripe.com',
  'https://q.stripe.com',
  'https://qr.stripe.com',
  'https://r.stripe.com',
  'https://verify.stripe.com',
  'https://stripe.com',
  'https://terminal.stripe.com',
  'https://uploads.stripe.com'
];

const ipAddresses = [
  "3.18.12.63",
  "3.130.192.231",
  "13.235.14.237",
  "13.235.122.149",
  "18.211.135.69",
  "35.154.171.200",
  "52.15.183.38",
  "54.88.130.119",
  "54.88.130.237",
  "54.187.174.169",
  "54.187.205.235",
  "54.187.216.72"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const connectingIp = req.headers['do-connecting-ip'];

  console.log('Request registered: origin: ' + origin + ' | connecting ip: ' + connectingIp);

  if ([...allowedOrigins, ...stripeUrls].includes(origin) || ipAddresses.includes(connectingIp)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return next();
  } else {
    res.status(403).json({ message: 'Forbidden: Access is denied' });
  }
});

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
  })
);

app.use((req, res, next) => {
  if ("OPTIONS" == req.method) {
    return res.sendStatus(200);
  } else {
    next();
  }
});

app.use((req, res, next) => {
  if (req.originalUrl === "/api/payment/webhook-checkout") {
    next()
  } else {
    bodyParser.json()(req, res, next);
  }
});

//routes
app.use("/api/user", userRouter);
app.use("/api/event", eventRouter);
app.use("/api/payment", paymentRouter);
app.use("/api/contest", contestRouter);
app.use("/api/special", specialEventsRouter)

//no page found 
app.use((req, res, next) => {
  const error = new HttpError("Action not allowed, please try again later!", 404);
  return next(error);
});

// error handling
app.use((error, req, res, next) => {
  console.log(error);
  const status = error.statusCode || 500;
  const message = error.message;
  const data = error.data;
  res.status(status).json({ message: message, data: data });
});

//db connection
mongoose.set("strictQuery", true);
mongoose
  .connect(
    `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`
  )
  .then(() => {
    console.log("Connected to DB");
    app.listen(process.env.PORT || 80);
    console.log(`Server running on port ${process.env.PORT || 80}`);
  })
  .catch((err) => console.log("Failed to Connect ", err));

// usersToSpreadsheet(null, false)

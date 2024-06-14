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

const stripeIps = [
  '13.112.224.240',
  '13.115.13.148',
  '13.210.129.177',
  '13.210.176.167',
  '13.228.126.182',
  '13.228.224.121',
  '13.230.11.13',
  '13.230.90.110',
  '13.55.153.188',
  '13.55.5.15',
  '13.56.126.253',
  '13.56.173.200',
  '13.56.173.232',
  '13.57.108.134',
  '13.57.155.157',
  '13.57.156.206',
  '13.57.157.116',
  '13.57.90.254',
  '13.57.98.27',
  '18.194.147.12',
  '18.195.120.229',
  '18.195.125.165',
  '34.200.27.109',
  '34.200.47.89',
  '34.202.153.183',
  '34.204.109.15',
  '34.213.149.138',
  '34.214.229.69',
  '34.223.201.215',
  '34.237.201.68',
  '34.237.253.141',
  '34.238.187.115',
  '34.239.14.72',
  '34.240.123.193',
  '34.241.202.139',
  '34.241.54.72',
  '34.241.59.225',
  '34.250.29.31',
  '34.250.89.120',
  '35.156.131.6',
  '35.156.194.238',
  '35.157.227.67',
  '35.158.254.198',
  '35.163.82.19',
  '35.164.105.206',
  '35.164.124.216',
  '50.16.2.231',
  '50.18.212.157',
  '50.18.212.223',
  '50.18.219.232',
  '52.1.23.197',
  '52.196.53.105',
  '52.196.95.231',
  '52.204.6.233',
  '52.205.132.193',
  '52.211.198.11',
  '52.212.99.37',
  '52.213.35.125',
  '52.22.83.139',
  '52.220.44.249',
  '52.25.214.31',
  '52.26.11.205',
  '52.26.132.102',
  '52.26.14.11',
  '52.36.167.221',
  '52.53.133.6',
  '52.54.150.82',
  '52.57.221.37',
  '52.59.173.230',
  '52.62.14.35',
  '52.62.203.73',
  '52.63.106.9',
  '52.63.119.77',
  '52.65.161.237',
  '52.73.161.98',
  '52.74.114.251',
  '52.74.98.83',
  '52.76.14.176',
  '52.76.156.251',
  '52.76.174.156',
  '52.77.80.43',
  '52.8.19.58',
  '52.8.8.189',
  '54.149.153.72',
  '54.152.36.104',
  '54.183.95.195',
  '54.187.182.230',
  '54.187.199.38',
  '54.187.208.163',
  '54.238.140.239',
  '54.65.115.204',
  '54.65.97.98',
  '54.67.48.128',
  '54.67.52.245',
  '54.68.165.206',
  '54.68.183.151',
  '107.23.48.182',
  '107.23.48.232',
  '198.137.150.21',
  '198.137.150.22',
  '198.137.150.23',
  '198.137.150.24',
  '198.137.150.25',
  '198.137.150.26',
  '198.137.150.27',
  '198.137.150.28',
  '198.137.150.101',
  '198.137.150.102',
  '198.137.150.103',
  '198.137.150.104',
  '198.137.150.105',
  '198.137.150.106',
  '198.137.150.107',
  '198.137.150.108',
  '198.137.150.171',
  '198.137.150.172',
  '198.137.150.173',
  '198.137.150.174',
  '198.137.150.175',
  '198.137.150.176',
  '198.137.150.177',
  '198.137.150.178',
  '198.137.150.221',
  '198.137.150.222',
  '198.137.150.223',
  '198.137.150.224',
  '198.137.150.225',
  '198.137.150.226',
  '198.137.150.227',
  '198.137.150.228',
  '198.202.176.21',
  '198.202.176.22',
  '198.202.176.23',
  '198.202.176.24',
  '198.202.176.25',
  '198.202.176.26',
  '198.202.176.27',
  '198.202.176.28',
  '198.202.176.101',
  '198.202.176.102',
  '198.202.176.103',
  '198.202.176.104',
  '198.202.176.105',
  '198.202.176.106',
  '198.202.176.107',
  '198.202.176.108',
  '198.202.176.171',
  '198.202.176.172',
  '198.202.176.173',
  '198.202.176.174',
  '198.202.176.175',
  '198.202.176.176',
  '198.202.176.177',
  '198.202.176.178',
  '198.202.176.221',
  '198.202.176.222',
  '198.202.176.223',
  '198.202.176.224',
  '198.202.176.225',
  '198.202.176.226',
  '198.202.176.227',
  '198.202.176.228',
  '3.18.12.63',
  '3.130.192.231',
  '13.235.14.237',
  '13.235.122.149',
  '18.211.135.69',
  '35.154.171.200',
  '52.15.183.38',
  '54.88.130.119',
  '54.88.130.237',
  '54.187.174.169',
  '54.187.205.235',
  '54.187.216.72',
];


app.use((req, res, next) => {
  const origin = req.headers.origin;
  const ip = req.ip;
  
  if ([...allowedOrigins, ...stripeUrls].includes(origin) || stripeIps.includes(ip)) {
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

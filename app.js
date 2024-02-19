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
import databaseRouter from "./routes/database-routes.js";
import specialEventsRouter from "./routes/special-events-routes.js";
import { eventToSpreadsheet } from "./util/searchInDatabase.js";
import { usersToSpreadsheet } from "./controllers/database-controllers.js";

const app = express();

// TEST ENVIRONMENT
// 1st --> put the localhost url in cors list "http://localhost:3000"
// 2nd --> change the http-hook in React to make  requests to localhost server

//configuration

app.use(
  cors({
    origin: [
      'https://bulgariansociety.netlify.app',
      "https://bulgariansociety.nl",
      "https://www.bulgariansociety.nl",
    ],
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
    let data = '';
    req.setEncoding('utf8');
    req.on('data', function(chunk) {
        data += chunk;
    });
    req.on('end', function() {
        req.rawBody = data;
        next();
    });
    } else {
    bodyParser.json()(req, res, next);
  }
});

//routes
app.use("/api/user", userRouter);
app.use("/api/event", eventRouter);
app.use("/api/payment", paymentRouter);
app.use("/api/contest", contestRouter);
app.use("/api/database", databaseRouter);
app.use("/api/special", specialEventsRouter)

//no page found
app.use((req, res, next) => {
  const error = new HttpError("Page not found", 404);
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

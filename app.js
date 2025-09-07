import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import cors from "cors";
import HttpError from "./models/Http-error.js";
import userRouter from "./routes/users-routes.js";
import eventRouter from "./routes/Events/events-routes.js";
import paymentRouter from "./routes/payments-routes.js";
import contestRouter from "./routes/contest-routes.js";
import commonRouter from "./routes/common-routes.js";
import securityRouter from "./routes/security-routes.js";
import specialEventsRouter from "./routes/special-routes.js";
import { allowedOrigins } from "./util/config/access.js";
import { firewall, rateLimiter } from "./middleware/firewall.js";
import axiomLogger from "./middleware/axiom-logger.js";
import { REGIONS, STRIPE_WEBHOOK_ROUTE } from "./util/config/defines.js";
import futureEventRouter from "./routes/Events/future-events-routes.js";
import wordpressRouter from "./routes/Integration/wordpress-routes.js";
import googleScriptsRouter from "./routes/Integration/google-scripts.js";
import webhookRouter from "./routes/Webhooks/webhook-routes.js";
import kokoAppRouter from "./routes/Integration/koko-app-data.js";
import { 
  convertUsersWithoutSubscriptionToAlumni,
  setJoinDateForAllAlumniUsers
} from './util/private/manipulate-db.js';

const app = express();

// Pass secured routes
app.use("/api/google-scripts", googleScriptsRouter);
app.use("/api/mobile", kokoAppRouter);
app.use("/api/webhooks", webhookRouter);

// Firewall
app.set("trust proxy", true);

if (app.get("env") !== "development") {
  app.use(rateLimiter);
  app.use(firewall);
} else {
  allowedOrigins.push("http://localhost:3000");
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(
          new HttpError(
            "There was a problem with your request, please try again later!",
            403
          )
        );
      }
    },
  })
);

// TODO: fix this as it is risky (one change in path will break the payments)
app.use((req, res, next) => {
  if (req.path === `/api/payment${STRIPE_WEBHOOK_ROUTE}`) {
    next();
  } else {
    bodyParser.json()(req, res, next);
  }
});

// Axiom request/response logging (moved after body parser)
if (process.env.APP_ENV !== "dev") {
  app.use(axiomLogger);
}

app.use((req, res, next) => {
  if ("OPTIONS" == req.method) {
    return res.sendStatus(200);
  } else {
    next();
  }
});

//routes
app.get("/", (req, res) => {
  res.status(200).json({ message: "Welcome to BGSNL Official Server" });
});

// Protected routes
app.use("/api/common", commonRouter);
app.use("/api/security", securityRouter);
app.use("/api/user", userRouter);
app.use("/api/event", eventRouter);
app.use("/api/future-event", futureEventRouter);
app.use("/api/payment", paymentRouter);
app.use("/api/contest", contestRouter);
app.use("/api/special", specialEventsRouter);
app.use("/api/wordpress", wordpressRouter);

//no page found
app.use((req, res, next) => {
  const error = new HttpError(
    "No action found - please try different path!",
    404
  );
  return next(error);
});

// error handling (not sure if needed)
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

// instantly update all user spreadsheets (do not leave uncommented)

// if (app.get('env') === 'development') {
//   await usersToSpreadsheet();
//   REGIONS.forEach(async (r) => {
//     await usersToSpreadsheet(r);
//   });
// }

// Convert users without subscription to alumni users
// Uncomment to run the conversion (do not leave uncommented)
// if (app.get('env') === 'development') {
//   try {
//     console.log('Starting conversion of users without subscription to alumni...');
//     const results = await convertUsersWithoutSubscriptionToAlumni();
//     console.log(`Conversion completed. Processed ${results?.length || 0} users.`);
//   } catch (error) {
//     console.error('Error in conversion process:', error);
//   }
// }

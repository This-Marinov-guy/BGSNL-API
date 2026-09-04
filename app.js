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
import axiomLogger, { flushAxiom, ingestLog, redactSensitive } from "./middleware/axiom-logger.js";
import { createErrorEvent } from "./util/logging/axiom-log-models.js";
import { REGIONS, STRIPE_WEBHOOK_ROUTE } from "./util/config/defines.js";
import futureEventRouter from "./routes/Events/future-events-routes.js";
import wordpressRouter from "./routes/Integration/wordpress-routes.js";
import googleScriptsRouter from "./routes/Integration/google-scripts.js";
import webhookRouter from "./routes/Webhooks/webhook-routes.js";
import kokoAppRouter from "./routes/Integration/koko-app-data.js";
import internshipRouter from "./routes/internship-routes.js";
import dashboardRouter from "./routes/dashboard-routes.js";
import { convertAlumniToUser, convertUserToAlumni } from "./services/main-services/user-service.js";
import { refundEventTickets } from "./services/main-services/event-action-service.js";
import { getUsersByDateRange } from "./services/background-services/statistics-service.js";
import { sendNonSocietyEventResendEmail } from "./controllers/Events/events-controllers.js";
import captureMarketingEmail from "./middleware/capture-marketing-email.js";
import {
  apiVersionMiddleware,
  requireEnabledApiVersion,
} from "./middleware/api-version.js";
import {
  API_VERSIONS,
  DEFAULT_API_VERSION,
  ENABLED_API_VERSIONS,
  getApiRoutePath,
} from "./util/config/api-versions.js";
import { formatUploadValidationError } from "./middleware/upload-validation-error.js";

const app = express();

// All unversioned /api requests resolve to v1. Explicit version prefixes are
// preserved so v2 and v3 routers can be introduced without changing v1.
app.use(apiVersionMiddleware);

const mountApiRouter = (version, routePath, router) => {
  app.use(getApiRoutePath(routePath, version), router);
};

// Pass secured routes
mountApiRouter(API_VERSIONS.V1, "/google-scripts", googleScriptsRouter);
mountApiRouter(API_VERSIONS.V1, "/mobile", kokoAppRouter);
mountApiRouter(API_VERSIONS.V1, "/webhooks", webhookRouter);

// Firewall
app.set("trust proxy", true);

if (app.get("env") !== "development") {
  app.use(rateLimiter);
  app.use(firewall);
} else {
  allowedOrigins.push(
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "http://127.0.0.1:3002"
  );
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

// Reject unavailable explicit versions after firewall and CORS processing.
app.use(requireEnabledApiVersion);

// TODO: fix this as it is risky (one change in path will break the payments)
app.use((req, res, next) => {
  if (req.path === `/api/payment${STRIPE_WEBHOOK_ROUTE}`) {
    next();
  } else if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
    // Skip JSON parsing for multipart/form-data (let multer handle it)
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
    return next();
  }
});

// Persist marketing recipients after successful form responses without making
// the user wait for the database write.
app.use(captureMarketingEmail);

//routes
app.get("/", (req, res) => {
  res.status(200).json({ message: "Welcome to BGSNL Official Server" });
});

app.get(getApiRoutePath(), (req, res) => {
  res.status(200).json({
    message: "Welcome to BGSNL Official Server API",
    version: req.apiVersion,
    defaultVersion: DEFAULT_API_VERSION,
    supportedVersions: ENABLED_API_VERSIONS,
  });
});

// Protected routes
mountApiRouter(API_VERSIONS.V1, "/common", commonRouter);
mountApiRouter(API_VERSIONS.V1, "/security", securityRouter);
mountApiRouter(API_VERSIONS.V1, "/user", userRouter);
mountApiRouter(API_VERSIONS.V1, "/event", eventRouter);
mountApiRouter(API_VERSIONS.V1, "/future-event", futureEventRouter);
mountApiRouter(API_VERSIONS.V1, "/payment", paymentRouter);
mountApiRouter(API_VERSIONS.V1, "/contest", contestRouter);
mountApiRouter(API_VERSIONS.V1, "/special", specialEventsRouter);
mountApiRouter(API_VERSIONS.V1, "/wordpress", wordpressRouter);
mountApiRouter(API_VERSIONS.V1, "/internship", internshipRouter);
mountApiRouter(API_VERSIONS.V1, "/dashboard", dashboardRouter);

//no page found
app.use((req, res, next) => {
  const error = new HttpError(
    "No action found - please try different path!",
    404
  );
  return next(error);
});

// error handling (not sure if needed)
app.use((error, req, res, _next) => {
  console.log(error);

  const uploadValidationError = formatUploadValidationError(error);
  if (uploadValidationError) {
    return res.status(422).json(uploadValidationError);
  }

  const status = error.statusCode || 500;
  const message = error.message;
  const data = error.data;

  const logEvent = createErrorEvent({
    req,
    res: { statusCode: status, statusMessage: message, durationMs: 0 },
    meta: {},
    error: error,
    payload: data !== undefined ? { data } : undefined,
    redact: redactSensitive,
  });
  ingestLog(logEvent);

  return res.status(status).json({ message: message, data: data });
});

//db connection
mongoose.set("strictQuery", true);
let server;

mongoose
  .connect(
    `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`
  )
  .then(() => {
    console.log("Connected to DB");
    server = app.listen(process.env.PORT || 80);
    console.log(`Server running on port ${process.env.PORT || 80}`);
  })
  .catch((err) => console.log("Failed to Connect ", err));

// Graceful shutdown handler
const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);
  
  // Stop accepting new connections
  if (server) {
    server.close(() => {
      console.log("HTTP server closed");
    });
  }

  // Flush Axiom logs
  await flushAxiom();

  // Close MongoDB connection
  try {
    await mongoose.connection.close();
    console.log("MongoDB connection closed");
  } catch (err) {
    console.error("Error closing MongoDB connection:", err);
  }

  console.log("Graceful shutdown complete");
  process.exit(0);
};

// Override existing signal handlers for proper shutdown
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

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

// usersToSpreadsheet();

// addRoleToUsersByEmail(
//   [
//   ],
//   "active_member"
// );

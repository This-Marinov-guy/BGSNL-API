import assert from "node:assert/strict";
import test from "node:test";

import commonRouter from "../routes/common-routes.js";
import contestRouter from "../routes/contest-routes.js";
import eventRouter from "../routes/Events/events-routes.js";
import futureEventRouter from "../routes/Events/future-events-routes.js";
import internshipRouter from "../routes/internship-routes.js";
import paymentRouter from "../routes/payments-routes.js";
import securityRouter from "../routes/security-routes.js";
import specialEventsRouter from "../routes/special-routes.js";
import userRouter from "../routes/users-routes.js";
import webhookRouter from "../routes/Webhooks/webhook-routes.js";

const mutationMethods = new Set(["delete", "patch", "post", "put"]);

const routers = {
  common: commonRouter,
  contest: contestRouter,
  events: eventRouter,
  futureEvents: futureEventRouter,
  internship: internshipRouter,
  payments: paymentRouter,
  security: securityRouter,
  special: specialEventsRouter,
  users: userRouter,
  webhooks: webhookRouter,
};

// These mutations intentionally consume no form fields, or validate a signed
// raw payload before Express can parse it. Any new exception must be deliberate.
const validationExemptions = new Set([
  "events:post:/sync-calendar-events",
  "security:post:/alumni-signup",
  "security:post:/signup",
  "users:delete:/cancel-membership",
  "webhooks:post:/stripe-payments",
]);

const routeKey = (routerName, method, path) =>
  `${routerName}:${method}:${path}`;

test("every form-backed mutation route runs backend validation", () => {
  const discoveredExemptions = new Set();
  const unvalidatedRoutes = [];

  for (const [routerName, router] of Object.entries(routers)) {
    for (const layer of router.stack.filter((item) => item.route)) {
      const handlers = layer.route.stack.map((item) => item.name);

      for (const method of Object.keys(layer.route.methods)) {
        if (!mutationMethods.has(method)) continue;

        const key = routeKey(routerName, method, layer.route.path);
        if (validationExemptions.has(key)) {
          discoveredExemptions.add(key);
          continue;
        }

        if (!handlers.includes("validateRequest")) {
          unvalidatedRoutes.push(key);
        }
      }
    }
  }

  assert.deepEqual(unvalidatedRoutes, []);
  assert.deepEqual(discoveredExemptions, validationExemptions);
});

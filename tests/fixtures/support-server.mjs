// Local UI verification only: no Mongo connection, mail, Stripe or real accounts.
// APP_ENV=dev node tests/fixtures/support-server.mjs
import express from "express";
import cors from "cors";
import { createSessionService } from "../../services/authentication/sessions.js";
import { memorySessionStore } from "./session-store.mjs";
import { trustedWebsiteRequest } from "../../util/auth/request-client.js";
import { randomBytes } from "node:crypto";
import { createAuthMiddleware } from "../../middleware/authorization.js";
import { apiVersionMiddleware } from "../../middleware/api-version.js";
import { createSupportRouter, supportPrivacy, supportError } from "../../routes/support-routes.js";
import { createSupportService } from "../../services/support/conversations.js";
import { memorySupportStore } from "./support-store.js";

if (process.env.APP_ENV !== "dev" || process.env.NODE_ENV === "production") throw new Error("Support fixtures are development-only.");
process.env.JWT_STRING = randomBytes(48).toString("hex");
process.env.AUTH_VERSION = "1";
const accounts = ["member", "staff"].map((name) => ({
  _id: `support-preview-${name}`, id: `support-preview-${name}`, name: name === "staff" ? "Support" : "Preview", surname: "Tester",
  email: `${name}@support.test.com`, phone: "+31600000000", status: "active", roles: [name === "staff" ? "support" : "user"],
  sessionVersion: 0, region: "groningen", version: 1, isSubscribed: false, isAlumni: false, hasBenefits: false, memberDiscount: false,
  image: "/assets/images/logo/logo-nl.png", birth: "1995-01-01", birthDate: "1995-01-01", joinDate: "2024-01-01", tickets: [], internships: [], subscription: {},
}));
const findAccount = async (id) => accounts.find((account) => account.id === id);
const sessions = createSessionService({ records: memorySessionStore(), findAccount });
const authenticate = createAuthMiddleware({ findAccount, validateSession: sessions.validate });
const app = express();
app.use(cors({ origin: "http://localhost:3002", allowedHeaders: ["Content-Type", "Authorization", "X-Support-Token"] }));
app.use(express.json({ limit: "32kb" }));
app.use(apiVersionMiddleware, supportPrivacy);
app.get("/api/v1/security/google/config", (_req, res) => res.json({ enabled: false }));
app.post("/api/v1/security/login", async (req, res, next) => {
  const account = accounts.find(({ email }) => email === req.body.email);
  if (!account || req.body.password !== "Support-preview-only-123!") return res.status(401).json({ message: "Use the documented local fixture account." });
  try { return res.json({ ...account, ...await sessions.start(account) }); } catch (error) { return next(error); }
});
for (const action of ["refresh", "activity", "logout"]) app.post(`/api/v1/security/session/${action}`, async (req, res, next) => {
  if (!trustedWebsiteRequest(req)) return res.status(403).json({ message: "Website only" });
  try {
    if (action === "logout") { await sessions.revoke(req.body.refreshToken); return res.json({ status: true }); }
    return res.json(await sessions.refresh(req.body.refreshToken, { activity: action === "activity" }));
  } catch (error) { return next(error); }
});
app.get("/api/v1/user/refresh-token", (_req, res) => res.status(410).json({ message: "Use the website session flow." }));
app.get("/api/v1/user/get-subscription-status", authenticate, (req, res) => res.json(req.account));
app.get("/api/v1/user/current", authenticate, (req, res) => res.json({ user: req.account, celebrate: false }));
app.use("/api/v1/support", createSupportRouter({ service: createSupportService({ records: memorySupportStore() }), authenticate, throttle: async () => {},
  uploadImages: async (files) => files.map(() => ({
    type: "image",
    url: "https://res.cloudinary.com/demo/image/upload/sample.jpg",
  })),
}));
app.use((_req, res) => res.status(404).json({ message: "This isolated fixture only serves support and preview sign-in." }));
app.use(supportError);
app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
app.listen(8089, "127.0.0.1", () => console.log("Isolated support fixture on http://localhost:8089/api — memory-only, no external writes."));

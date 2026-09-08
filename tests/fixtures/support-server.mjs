// Local UI verification only: no Mongo connection, mail, Stripe or real accounts.
// APP_ENV=dev node tests/fixtures/support-server.mjs
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
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
const authenticate = createAuthMiddleware({ findAccount: async (id) => accounts.find((account) => account.id === id) });
const token = (account) => jwt.sign({ userId: account.id, version: 1, sessionVersion: 0, roles: account.roles, status: account.status,
  image: account.image, region: account.region }, process.env.JWT_STRING, { expiresIn: "1h" });
const app = express();
app.use(cors({ origin: "http://localhost:3002", allowedHeaders: ["Content-Type", "Authorization", "X-Support-Token"] }));
app.use(express.json({ limit: "32kb" }));
app.use(apiVersionMiddleware, supportPrivacy);
app.get("/api/v1/security/google/config", (_req, res) => res.json({ enabled: false }));
app.post("/api/v1/security/login", (req, res) => {
  const account = accounts.find(({ email }) => email === req.body.email);
  if (!account || req.body.password !== "Support-preview-only-123!") return res.status(401).json({ message: "Use the documented local fixture account." });
  return res.json({ ...account, token: token(account) });
});
app.get("/api/v1/user/refresh-token", authenticate, (req, res) => res.json({ token: token(req.account) }));
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

import dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import mongoose from "mongoose";
import MemberUser from "../models/MemberUser.js";

const fileEnvironment = {};
for (const file of [".env", ".env.dev", ".env.local"]) {
  try {
    const values = dotenv.parse(await readFile(new URL(`../${file}`, import.meta.url)));
    Object.assign(fileEnvironment, values);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
for (const [key, value] of Object.entries(fileEnvironment)) {
  if (["DB", "DB_USER", "DB_PASS"].includes(key) || process.env[key] === undefined) process.env[key] = value;
}

const email = process.argv[2]?.toLowerCase();
const requestedRole = process.argv[3] === "admin" ? "admin" : "active_member";
if (process.env.APP_ENV !== "dev" || !/^e2e-active-[a-z0-9-]+@flow-test\.bgsnl\.local$/.test(email || "") ||
    (process.argv[3] !== undefined && process.argv[3] !== "admin")) {
  throw new Error("Role provisioning is limited to a newly created E2E account in development.");
}
if (!process.env.DB || !process.env.DB_USER || !process.env.DB_PASS) {
  throw new Error("Development database credentials are missing.");
}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;
await mongoose.connect(uri);
try {
  const account = await MemberUser.findOne({ email });
  if (!account || account.status !== "active" || !account.roles?.includes("member") || !account.subscription?.id ||
      (requestedRole === "admin" && !account.roles.includes("active_member"))) {
    throw new Error("The E2E account must complete Member signup before active-member provisioning.");
  }
  await MemberUser.updateOne({ _id: account._id, email }, { $addToSet: { roles: requestedRole } });
  console.log(`${requestedRole} role provisioned for the E2E account.`);
} finally {
  await mongoose.disconnect();
}

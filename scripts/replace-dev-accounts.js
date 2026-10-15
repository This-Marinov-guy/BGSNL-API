/**
 * Replace non-admin accounts in the dedicated development MongoDB cluster.
 * Preview: node --env-file=.env.dev scripts/replace-dev-accounts.js
 * Apply:   node --env-file=.env.dev scripts/replace-dev-accounts.js --apply
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import mongoose from "mongoose";
import MemberUser from "../models/MemberUser.js";
import AlumniUser from "../models/AlumniUser.js";
import { hashPassword } from "../services/authentication/passwords.js";
import { REGIONS } from "../util/config/defines.js";
import { cardOwner, createCardToken } from "../services/wallet/policy.js";

const DEV_HOST = "dev.zuwo0.mongodb.net";
const ADMIN_ROLES = ["admin", "super_admin"];
const NON_ADMIN = { roles: { $nin: ADMIN_ROLES } };
const IMAGE = "/assets/images/avatars/bg_other_avatar_1.jpeg";
const DAY = 86_400_000;
const MEMBER_COUNT = 240;
const ALUMNI_COUNT = 80;
const FIRST_NAMES = ["Alex", "Mira", "Niko", "Elena", "Victor", "Dara", "Ivan", "Sofia", "Martin", "Raya", "Daniel", "Nina"];
const LAST_NAMES = ["Sample", "Demo", "Example", "Test", "Preview", "Fixture"];

function safeEnvironment() {
  const dev = dotenv.parse(readFileSync(new URL("../.env.dev", import.meta.url)));
  const prod = dotenv.parse(readFileSync(new URL("../.env.prod", import.meta.url)));
  const host = String(process.env.DB || "").split("/")[0];
  assert.equal(process.env.APP_ENV, "dev", "APP_ENV must be dev");
  assert.notEqual(process.env.NODE_ENV, "production", "NODE_ENV must not be production");
  assert.equal(process.env.DB, dev.DB, "DB must match .env.dev exactly");
  assert.equal(process.env.DB_USER, dev.DB_USER, "DB_USER must match .env.dev");
  assert.equal(process.env.DB_PASS, dev.DB_PASS, "DB_PASS must match .env.dev");
  assert.equal(host, DEV_HOST, "Refusing any cluster other than the known dev cluster");
  assert.notEqual(host, String(prod.DB || "").split("/")[0], "Dev and production hosts must differ");
  assert.ok(process.env.DB_USER && process.env.DB_PASS, "Development DB credentials are required");
}

function makeAccounts(passwordHash, now) {
  const accounts = (kind, count) => Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const label = String(number).padStart(4, "0");
    const status = number % 20 === 0 ? "frozen" : number % 10 === 0 ? "payment_awaiting" : number % 7 === 0 ? "locked" : "active";
    const isMember = kind === "member";
    const data = {
      _id: `${kind}_dev_${kind}_${label}`,
      name: FIRST_NAMES[index % FIRST_NAMES.length],
      surname: LAST_NAMES[Math.floor(index / FIRST_NAMES.length) % LAST_NAMES.length],
      email: `dev-${kind}-${label}@accounts.example.invalid`,
      password: passwordHash,
      image: IMAGE,
      status,
      roles: isMember ? ["member"] : ["alumni"],
      phone: "+31600000000",
      birth: new Date(Date.UTC(1988 + index % 15, index % 12, 1 + index % 27)),
      region: REGIONS[index % REGIONS.length],
      university: "Demo University",
      joinDate: new Date(now.getTime() - (365 + index % 1095) * DAY),
      purchaseDate: new Date(now.getTime() - (15 + index % 300) * DAY),
      expireDate: new Date(now.getTime() + (status === "locked" ? -30 : 180 + index % 180) * DAY),
      subscription: { connected: false },
      notificationTerms: false,
      notificationTypeTerms: "none",
      accountAliases: [],
      documents: [],
      tickets: [],
      christmas: [],
      internshipApplications: [],
    };
    if (isMember) {
      data.course = "International Business";
      data.graduationDate = String(now.getUTCFullYear() + 1 + index % 4);
      data.studentNumber = `DEV-${label}`;
    } else {
      data.tier = index % 5;
      data.graduationDate = String(2010 + index % 15);
      data.profession = "Demo professional";
    }
    const model = isMember ? new MemberUser(data) : new AlumniUser(data);
    const validationError = model.validateSync();
    if (validationError) throw validationError;
    return model.toObject();
  });
  return { members: accounts("member", MEMBER_COUNT), alumni: accounts("alumni", ALUMNI_COUNT) };
}

async function currentState(db, session) {
  const options = session ? { session } : {};
  const members = await db.collection("memberUsers").find({}, options).sort({ _id: 1 }).toArray();
  const alumni = await db.collection("alumniUsers").find({}, options).sort({ _id: 1 }).toArray();
  const isAdmin = (account) => account.roles?.some((role) => ADMIN_ROLES.includes(role));
  return {
    members, alumni,
    memberAdmins: members.filter(isAdmin), alumniAdmins: alumni.filter(isAdmin),
    memberOthers: members.filter((account) => !isAdmin(account)),
    alumniOthers: alumni.filter((account) => !isAdmin(account)),
  };
}

async function main() {
  safeEnvironment();
  const apply = process.argv.includes("--apply");
  const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });
  try {
    assert.equal(mongoose.connection.name, "test", "Unexpected database name on dev cluster");
    const db = mongoose.connection.db;
    const collections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name));
    assert.ok(collections.has("memberUsers") && collections.has("alumniUsers"), "Expected account collections are missing");
    assert.ok(!collections.has("memberusers") && !collections.has("alumniusers"), "Unexpected legacy account collections exist");
    const before = await currentState(db);
    console.log(JSON.stringify({
      cluster: DEV_HOST, database: mongoose.connection.name, dryRun: !apply,
      before: { members: before.members.length, memberAdminsPreserved: before.memberAdmins.length,
        memberAccountsReplaced: before.memberOthers.length, alumni: before.alumni.length,
        alumniAdminsPreserved: before.alumniAdmins.length, alumniAccountsReplaced: before.alumniOthers.length },
      creating: { members: MEMBER_COUNT, alumni: ALUMNI_COUNT },
    }, null, 2));
    if (!apply) return;

    const password = `DevA1!${randomBytes(15).toString("base64url")}`;
    const fixtures = makeAccounts(await hashPassword(password), new Date());
    const session = await mongoose.startSession();
    let walletCardsRemoved = 0;
    try {
      await session.withTransaction(async () => {
        const inTransaction = await currentState(db, session);
        assert.deepEqual(inTransaction, before, "Account data changed since preview; retry the operation");
        const memberIds = inTransaction.memberOthers.map((account) => account._id);
        const alumniIds = inTransaction.alumniOthers.map((account) => account._id);
        const allRemovedIds = [...memberIds, ...alumniIds];
        const memberDelete = await db.collection("memberUsers").deleteMany(NON_ADMIN, { session });
        const alumniDelete = await db.collection("alumniUsers").deleteMany(NON_ADMIN, { session });
        assert.equal(memberDelete.deletedCount, memberIds.length);
        assert.equal(alumniDelete.deletedCount, alumniIds.length);
        const walletDelete = await db.collection("walletCards").deleteMany({ accountId: { $in: allRemovedIds } }, { session });
        walletCardsRemoved = walletDelete.deletedCount;
        await db.collection("memberUsers").insertMany(fixtures.members, { session });
        await db.collection("alumniUsers").insertMany(fixtures.alumni, { session });
        const cards = [...fixtures.members, ...fixtures.alumni].map((account) => ({
          _id: cardOwner(account), accountId: account._id, token: createCardToken(),
          provisionedAutomatically: true, revokedAt: null, createdAt: new Date(), updatedAt: new Date(),
        }));
        await db.collection("walletCards").insertMany(cards, { session });

        const activeMembers = await db.collection("memberUsers").countDocuments(
          { status: "active", expireDate: { $gt: new Date() } }, { session });
        const activeAlumni = await db.collection("alumniUsers").countDocuments({ status: "active" }, { session });
        await db.collection("statistics").updateOne({ type: "member" },
          { $set: { "data.total": activeMembers, "data.active": activeMembers, lastUpdated: new Date() } }, { session });
        await db.collection("statistics").updateOne({ type: "alumni" },
          { $set: { "data.total": activeAlumni, lastUpdated: new Date() } }, { session });
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } finally {
      await session.endSession();
    }

    const after = await currentState(db);
    assert.deepEqual(after.memberAdmins, before.memberAdmins, "Member admin records changed");
    assert.deepEqual(after.alumniAdmins, before.alumniAdmins, "Alumni admin records changed");
    assert.equal(after.memberOthers.length, MEMBER_COUNT);
    assert.equal(after.alumniOthers.length, ALUMNI_COUNT);
    assert.ok(after.memberOthers.every((account) => account.email.endsWith("@accounts.example.invalid")));
    assert.ok(after.alumniOthers.every((account) => account.email.endsWith("@accounts.example.invalid")));
    console.log(JSON.stringify({
      completed: true, cluster: DEV_HOST, database: mongoose.connection.name,
      after: { members: after.members.length, memberAdminsPreserved: after.memberAdmins.length,
        dummyMembers: after.memberOthers.length, alumni: after.alumni.length,
        alumniAdminsPreserved: after.alumniAdmins.length, dummyAlumni: after.alumniOthers.length },
      walletCardsRemoved, dummyWalletCardsCreated: MEMBER_COUNT + ALUMNI_COUNT,
      dummyAccountPassword: password,
    }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

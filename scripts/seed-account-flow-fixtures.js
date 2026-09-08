import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import User from "../models/User.js";
import AlumniUser from "../models/AlumniUser.js";

dotenv.config();

export const FIXTURE_DOMAIN = "flow-test.bgsnl.local";
export const ALLOWED_DATABASE = /^bgsnl_flow_test(?:_[a-z0-9-]+)?$/;

const DAY = 24 * 60 * 60 * 1000;
const image = "/assets/images/avatars/bg_other_avatar_1.jpeg";

const dateFromNow = (days, now) => new Date(now.getTime() + days * DAY);

const baseAccount = ({ id, email, name, status, roles, now, password }) => ({
  _id: id,
  email,
  name,
  surname: "Flow Test",
  password,
  image,
  status,
  roles,
  phone: "+31600000000",
  birth: new Date("2000-01-15T00:00:00.000Z"),
  region: "groningen",
  notificationTerms: true,
  notificationTypeTerms: "email",
  joinDate: dateFromNow(-730, now),
  purchaseDate: dateFromNow(-30, now),
  tickets: [],
  christmas: [],
  documents: [],
  internshipApplications: [],
  subscription: {},
  sessionVersion: 0,
  identityRevision: 0,
});

const member = ({ key, status, now, password, expiresInDays = 180, email, aliases = [] }) => ({
  ...baseAccount({
    id: `member_flow_${key}`,
    email: email || `member-${key}@${FIXTURE_DOMAIN}`,
    name: `Member ${key}`,
    status,
    roles: ["member"],
    now,
    password,
  }),
  expireDate: dateFromNow(expiresInDays, now),
  university: "Hanze University of Applied Sciences",
  graduationDate: String(now.getUTCFullYear() + 2),
  course: "International Business",
  studentNumber: `FLOW-${key.toUpperCase()}`,
  accountAliases: aliases,
});

const alumni = ({ key, status, tier, now, password, expiresInDays = 180, email, aliases = [] }) => ({
  ...baseAccount({
    id: `alumni_flow_${key}`,
    email: email || `alumni-${key}@${FIXTURE_DOMAIN}`,
    name: `Alumni ${key}`,
    status,
    roles: ["alumni"],
    now,
    password,
  }),
  tier,
  expireDate: dateFromNow(expiresInDays, now),
  university: "University of Groningen",
  graduationDate: String(now.getUTCFullYear() - 2),
  profession: "Flow tester",
  accountAliases: aliases,
});

export function buildAccountFlowFixtures({ passwordHash, now = new Date() }) {
  const migratedToAlumniEmail = `migrated-to-alumni@${FIXTURE_DOMAIN}`;
  const migratedToMemberEmail = `migrated-to-member@${FIXTURE_DOMAIN}`;
  const migratedMemberId = "member_flow_migrated_to_alumni";
  const currentAlumniId = "alumni_flow_migrated_to_alumni";
  const migratedAlumniId = "alumni_flow_migrated_to_member";
  const currentMemberId = "member_flow_migrated_to_member";

  return {
    users: [
      member({ key: "active", status: "active", now, password: passwordHash }),
      member({ key: "locked", status: "locked", now, password: passwordHash, expiresInDays: -30 }),
      member({ key: "payment-awaiting", status: "payment_awaiting", now, password: passwordHash }),
      member({ key: "frozen", status: "frozen", now, password: passwordHash }),
      member({
        key: "migrated_to_alumni",
        status: "membership-migrated",
        now,
        password: passwordHash,
        email: migratedToAlumniEmail,
        aliases: [migratedMemberId, currentAlumniId],
      }),
      member({
        key: "migrated_to_member",
        status: "locked",
        now,
        password: passwordHash,
        expiresInDays: -30,
        email: migratedToMemberEmail,
        aliases: [migratedAlumniId, currentMemberId],
      }),
    ],
    alumni: [
      alumni({ key: "free", status: "active", tier: 0, now, password: passwordHash }),
      alumni({ key: "active", status: "active", tier: 2, now, password: passwordHash }),
      alumni({ key: "locked", status: "locked", tier: 2, now, password: passwordHash, expiresInDays: -30 }),
      alumni({ key: "payment-awaiting", status: "payment_awaiting", tier: 2, now, password: passwordHash }),
      alumni({ key: "frozen", status: "frozen", tier: 2, now, password: passwordHash }),
      alumni({
        key: "migrated_to_alumni",
        status: "active",
        tier: 0,
        now,
        password: passwordHash,
        email: migratedToAlumniEmail,
        aliases: [migratedMemberId, currentAlumniId],
      }),
      alumni({
        key: "migrated_to_member",
        status: "membership-migrated",
        tier: 2,
        now,
        password: passwordHash,
        email: migratedToMemberEmail,
        aliases: [migratedAlumniId, currentMemberId],
      }),
    ],
  };
}

export function assertSafeTarget(databaseName) {
  if (!ALLOWED_DATABASE.test(databaseName || "")) {
    throw new Error("FLOW_TEST_DB_NAME must match bgsnl_flow_test or bgsnl_flow_test_<suffix>.");
  }
  if (databaseName === "test") {
    throw new Error("Refusing to use the application's production default database.");
  }
}

const fixtureEmail = new RegExp(`@${FIXTURE_DOMAIN.replaceAll(".", "\\.")}$`, "i");

async function assertDatabaseIsIsolated() {
  const [foreignMember, foreignAlumni] = await Promise.all([
    User.exists({ email: { $not: fixtureEmail } }),
    AlumniUser.exists({ email: { $not: fixtureEmail } }),
  ]);
  if (foreignMember || foreignAlumni) {
    throw new Error("The target database contains non-fixture accounts; refusing to seed it.");
  }
}

function validateFixtures(fixtures) {
  for (const [Model, records] of [[User, fixtures.users], [AlumniUser, fixtures.alumni]]) {
    for (const data of records) {
      const error = new Model(data).validateSync();
      if (error) throw error;
    }
  }
}

async function seedModel(Model, fixtures) {
  const results = [];
  for (const fixture of fixtures) {
    const result = await Model.replaceOne({ _id: fixture._id }, fixture, { upsert: true });
    results.push({
      id: fixture._id,
      email: fixture.email,
      status: fixture.status,
      tier: fixture.tier,
      created: result.upsertedCount === 1,
    });
  }
  return results;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const databaseName = process.env.FLOW_TEST_DB_NAME;
  const password = process.env.FLOW_TEST_PASSWORD;

  assertSafeTarget(databaseName);
  if (!password || password.length < 12) {
    throw new Error("FLOW_TEST_PASSWORD must be at least 12 characters.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const fixtures = buildAccountFlowFixtures({ passwordHash });
  validateFixtures(fixtures);

  if (!apply) {
    console.log(JSON.stringify({
      dryRun: true,
      databaseName,
      members: fixtures.users.map(({ _id, email, status }) => ({ id: _id, email, status })),
      alumni: fixtures.alumni.map(({ _id, email, status, tier }) => ({ id: _id, email, status, tier })),
    }, null, 2));
    return;
  }

  const host = process.env.DB?.split("/")[0];
  if (!host || !process.env.DB_USER || !process.env.DB_PASS) {
    throw new Error("DB, DB_USER, and DB_PASS are required to reach the isolated test database.");
  }
  const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${host}`;

  await mongoose.connect(uri, { dbName: databaseName });
  try {
    if (mongoose.connection.name !== databaseName) {
      throw new Error(`Connected to unexpected database: ${mongoose.connection.name}`);
    }
    await assertDatabaseIsIsolated();
    const [members, alumniAccounts] = await Promise.all([
      seedModel(User, fixtures.users),
      seedModel(AlumniUser, fixtures.alumni),
    ]);
    console.log(JSON.stringify({ databaseName, members, alumni: alumniAccounts }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

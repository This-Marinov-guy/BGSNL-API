import dotenv from "dotenv";
dotenv.config();

import mongoose from "mongoose";
import { fileURLToPath } from "url";
import path from "path";
import User from "../models/User.js";
import AlumniUser from "../models/AlumniUser.js";
import Event from "../models/Event.js";
import NonSocietyEvent from "../models/NonSocietyEvent.js";
import MarketingEmail, {
  normalizeMarketingCity,
  normalizeMarketingEmail,
} from "../models/MarketingEmail.js";
import { DEFAULT_REGION } from "../util/config/defines.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BATCH_SIZE = 1000;
const VALID_SOURCES = new Set(["all", "members", "alumni", "events"]);

const isDirectRun = (() => {
  const scriptPath = process.argv[1];
  return scriptPath
    ? path.resolve(scriptPath) === fileURLToPath(import.meta.url)
    : false;
})();

export const parseArgs = (argv) => {
  const options = { apply: false, source: "all" };

  for (const arg of argv) {
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg.startsWith("--source=")) {
      options.source = arg.slice("--source=".length) || "all";
    }
  }

  if (!VALID_SOURCES.has(options.source)) {
    throw new Error(
      `Invalid --source value "${options.source}". Use all, members, alumni, or events.`
    );
  }

  return options;
};

const getMongoUri = () =>
  // eslint-disable-next-line no-process-env
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;

const getDate = (...values) => {
  for (const value of values) {
    if (!value) continue;

    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }

  return null;
};

const createSourceSummary = () => ({
  scanned: 0,
  eligible: 0,
  invalidEmail: 0,
  fallbackCity: 0,
});

export const createCandidateCollector = (fallbackDate = new Date()) => {
  const candidates = new Map();
  let deduplicated = 0;

  const add = ({ email, city, addedAt, summary }) => {
    summary.scanned += 1;

    const normalizedEmail = normalizeMarketingEmail(email);
    const normalizedCity = normalizeMarketingCity(city || DEFAULT_REGION);

    if (!city) summary.fallbackCity += 1;

    if (
      typeof normalizedEmail !== "string" ||
      !EMAIL_REGEX.test(normalizedEmail)
    ) {
      summary.invalidEmail += 1;
      return;
    }

    summary.eligible += 1;

    const candidate = {
      email: normalizedEmail,
      city: normalizedCity,
      addedAt: getDate(addedAt, fallbackDate),
      unsubscribed: false,
    };
    const key = `${candidate.city}\u0000${candidate.email}`;
    const current = candidates.get(key);

    if (!current) {
      candidates.set(key, candidate);
      return;
    }

    deduplicated += 1;
    if (candidate.addedAt < current.addedAt) {
      candidates.set(key, candidate);
    }
  };

  return {
    add,
    candidates,
    getDeduplicatedCount: () => deduplicated,
  };
};

const collectMembers = async (collector, summary) => {
  const cursor = User.find({})
    .select("email region joinDate purchaseDate")
    .lean()
    .cursor();

  for await (const member of cursor) {
    collector.add({
      email: member.email,
      city: member.region,
      addedAt: getDate(member.joinDate, member.purchaseDate),
      summary,
    });
  }
};

const collectAlumni = async (collector, summary) => {
  const cursor = AlumniUser.find({})
    .select("email joinDate purchaseDate")
    .lean()
    .cursor();

  for await (const alumni of cursor) {
    collector.add({
      email: alumni.email,
      city: DEFAULT_REGION,
      addedAt: getDate(alumni.joinDate, alumni.purchaseDate),
      summary,
    });
  }
};

const collectEventModel = async (model, collector, summary, dateFields) => {
  const cursor = model
    .find({})
    .select("region createdAt guestList.email guestList.timestamp")
    .lean()
    .cursor();

  for await (const event of cursor) {
    for (const guest of event.guestList || []) {
      collector.add({
        email: guest.email,
        city: event.region,
        addedAt: getDate(...dateFields(guest, event)),
        summary,
      });
    }
  }
};

const collectEvents = async (collector, summary) => {
  await collectEventModel(Event, collector, summary, (guest, event) => [
    guest.timestamp,
    event.createdAt,
  ]);
  await collectEventModel(NonSocietyEvent, collector, summary, (guest) => [
    guest.timestamp,
  ]);
};

const findExistingCandidateKeys = async (candidates) => {
  const existingKeys = new Set();
  const cursor = MarketingEmail.find({})
    .select("email city")
    .lean()
    .cursor();

  for await (const entry of cursor) {
    const key = `${normalizeMarketingCity(entry.city)}\u0000${normalizeMarketingEmail(entry.email)}`;
    if (candidates.has(key)) existingKeys.add(key);
  }

  return existingKeys;
};

const applyCandidates = async (candidates) => {
  const entries = [...candidates.values()];
  const totals = { inserted: 0, matched: 0 };

  await MarketingEmail.init();

  for (let index = 0; index < entries.length; index += BATCH_SIZE) {
    const batch = entries.slice(index, index + BATCH_SIZE);
    const result = await MarketingEmail.bulkWrite(
      batch.map((entry) => ({
        updateOne: {
          filter: { email: entry.email, city: entry.city },
          update: { $setOnInsert: entry },
          upsert: true,
        },
      })),
      { ordered: false }
    );

    totals.inserted += result.upsertedCount || 0;
    totals.matched += result.matchedCount || 0;
  }

  return totals;
};

const printSummary = ({
  options,
  summaries,
  candidates,
  deduplicated,
  existing,
  applied,
}) => {
  console.log(
    `\n[marketing-backfill] ${options.apply ? "APPLY" : "DRY RUN"} summary`
  );

  for (const [source, summary] of Object.entries(summaries)) {
    if (options.source !== "all" && options.source !== source) continue;
    console.log(
      `[${source}] scanned=${summary.scanned} eligible=${summary.eligible} ` +
        `invalidEmail=${summary.invalidEmail} fallbackCity=${summary.fallbackCity}`
    );
  }

  console.log(
    `[combined] uniqueCandidates=${candidates.size} deduplicated=${deduplicated} ` +
      `alreadyPresent=${existing.size} ${options.apply ? "inserted" : "wouldInsert"}=${
        options.apply ? applied.inserted : candidates.size - existing.size
      }`
  );

  if (options.apply) {
    console.log(`[combined] matchedExistingDuringWrite=${applied.matched}`);
  } else {
    console.log("\nRun again with --apply to insert the missing recipients.");
  }
};

export const runBackfill = async (options) => {
  const summaries = {
    members: createSourceSummary(),
    alumni: createSourceSummary(),
    events: createSourceSummary(),
  };
  const collector = createCandidateCollector();

  if (options.source === "all" || options.source === "members") {
    await collectMembers(collector, summaries.members);
  }

  if (options.source === "all" || options.source === "alumni") {
    await collectAlumni(collector, summaries.alumni);
  }

  if (options.source === "all" || options.source === "events") {
    await collectEvents(collector, summaries.events);
  }

  const existing = await findExistingCandidateKeys(collector.candidates);
  const applied = options.apply
    ? await applyCandidates(collector.candidates)
    : { inserted: 0, matched: 0 };

  printSummary({
    options,
    summaries,
    candidates: collector.candidates,
    deduplicated: collector.getDeduplicatedCount(),
    existing,
    applied,
  });

  return {
    summaries,
    candidateCount: collector.candidates.size,
    existingCount: existing.size,
    ...applied,
  };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  mongoose.set("strictQuery", true);
  await mongoose.connect(getMongoUri(), {
    autoCreate: options.apply,
    autoIndex: options.apply,
  });

  console.log(
    `[marketing-backfill] Mode=${options.apply ? "APPLY" : "DRY RUN"} source=${options.source}`
  );

  try {
    await runBackfill(options);
  } finally {
    await mongoose.connection.close();
  }
};

if (isDirectRun) {
  main().catch(async (error) => {
    console.error(`[marketing-backfill] Failed: ${error.message}`);

    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }

    process.exitCode = 1;
  });
}

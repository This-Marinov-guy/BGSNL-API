/* eslint-disable no-sync */
import dotenv from "dotenv";
dotenv.config();

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import XLSX from "xlsx";
import MarketingEmail, {
  normalizeMarketingCity,
  normalizeMarketingEmail,
} from "../models/MarketingEmail.js";

const DEFAULT_ARCHIVE_PATH =
  "/Users/vlady/Documents/BGSNL archive/2024:2025";
const BATCH_SIZE = 1000;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const EMAIL_HEADER_PATTERN = /^e-?mail(?: address)?$/i;

const REGION_BY_WORKBOOK_PREFIX = {
  BGSA: "amsterdam",
  BGSB: "breda_tilburg",
  BGSE: "eindhoven",
  BGSG: "groningen",
  BGSL: "leeuwarden",
  BGSM: "maastricht",
  BGSR: "rotterdam",
};

const isDirectRun = (() => {
  const scriptPath = process.argv[1];
  return scriptPath
    ? path.resolve(scriptPath) === fileURLToPath(import.meta.url)
    : false;
})();

export const parseArgs = (argv) => {
  const options = {
    apply: false,
    archivePath: DEFAULT_ARCHIVE_PATH,
  };

  for (const arg of argv) {
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg.startsWith("--archive=")) {
      options.archivePath = arg.slice("--archive=".length);
    }
  }

  return options;
};

const getMongoUri = () =>
  // eslint-disable-next-line no-process-env
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB}`;

export const parseArchiveDate = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  if (typeof value === "number") {
    const parts = XLSX.SSF.parse_date_code(value);
    if (parts) {
      return new Date(
        Date.UTC(parts.y, parts.m - 1, parts.d, parts.H, parts.M, parts.S)
      );
    }
  }

  if (typeof value !== "string" || !value.trim()) return null;

  const cleaned = value
    .replace(/(\d{1,2})(?:st|nd|rd|th)\b/gi, "$1")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const timestamp = Date.parse(cleaned);

  return Number.isNaN(timestamp) ? null : new Date(timestamp);
};

const parseSheetDate = (sheetName) => {
  const dateText = sheetName.split("|").slice(1).join(" ");
  const match = dateText.match(
    /(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{2,4})/i
  );

  if (!match) return null;

  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return parseArchiveDate(`${match[1]} ${match[2]} ${year}`);
};

const getWorkbookRegion = (fileName) => {
  const prefix = Object.keys(REGION_BY_WORKBOOK_PREFIX).find((candidate) =>
    fileName.toUpperCase().startsWith(candidate)
  );

  return prefix ? REGION_BY_WORKBOOK_PREFIX[prefix] : null;
};

const getEmailSources = (cell) => [
  cell?.v,
  cell?.f,
  cell?.l?.Target,
  ...(cell?.c || []).map((comment) => comment.t),
];

const extractEmails = (cell) => {
  const emails = [];

  for (const source of getEmailSources(cell)) {
    if (source === undefined || source === null) continue;

    const matches = String(source).match(EMAIL_PATTERN) || [];
    emails.push(...matches.map(normalizeMarketingEmail));
  }

  return emails;
};

const findHeaderColumns = (sheet) => {
  let emailColumn = null;
  let timestampColumn = null;
  let headerRow = null;

  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith("!") || typeof cell?.v !== "string") continue;

    const decoded = XLSX.utils.decode_cell(address);
    const value = cell.v.trim();

    if (EMAIL_HEADER_PATTERN.test(value)) {
      emailColumn = decoded.c;
      headerRow = decoded.r;
    }

    if (/^timestamp$/i.test(value)) {
      timestampColumn = decoded.c;
    }
  }

  return { emailColumn, timestampColumn, headerRow };
};

export const scanArchive = (archivePath) => {
  if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isDirectory()) {
    throw new Error(`Archive directory not found: ${archivePath}`);
  }

  const files = fs
    .readdirSync(archivePath)
    .filter((fileName) => fileName.toLowerCase().endsWith(".xlsx"))
    .sort();

  if (!files.length) {
    throw new Error(`No .xlsx workbooks found in: ${archivePath}`);
  }

  const candidates = new Map();
  const summaries = [];
  let duplicateOccurrences = 0;

  for (const fileName of files) {
    const region = getWorkbookRegion(fileName);
    if (!region) {
      throw new Error(`No city mapping configured for workbook: ${fileName}`);
    }

    const filePath = path.join(archivePath, fileName);
    const fileDate = fs.statSync(filePath).mtime;
    const workbook = XLSX.readFile(filePath, {
      cellDates: true,
      cellFormula: true,
      cellHTML: false,
    });
    const summary = {
      fileName,
      region,
      tabs: workbook.SheetNames.length,
      tabsWithEmails: 0,
      occurrences: 0,
      invalidEmailCells: 0,
      timestampDates: 0,
      sheetDateFallbacks: 0,
      fileDateFallbacks: 0,
    };

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const { emailColumn, timestampColumn, headerRow } =
        findHeaderColumns(sheet);
      const sheetDate = parseSheetDate(sheetName);
      let tabHasEmails = false;

      if (emailColumn !== null && headerRow !== null && sheet["!ref"]) {
        const range = XLSX.utils.decode_range(sheet["!ref"]);

        for (let row = headerRow + 1; row <= range.e.r; row += 1) {
          const emailAddress = XLSX.utils.encode_cell({
            r: row,
            c: emailColumn,
          });
          const emailCell = sheet[emailAddress];
          const rawValue = String(emailCell?.v ?? "").trim();

          if (rawValue && extractEmails(emailCell).length === 0) {
            summary.invalidEmailCells += 1;
          }
        }
      }

      for (const [address, cell] of Object.entries(sheet)) {
        if (address.startsWith("!")) continue;

        const emails = extractEmails(cell);
        if (!emails.length) continue;

        tabHasEmails = true;
        const { r: row } = XLSX.utils.decode_cell(address);
        const timestampCell =
          timestampColumn === null
            ? null
            : sheet[XLSX.utils.encode_cell({ r: row, c: timestampColumn })];
        const timestampDate = parseArchiveDate(timestampCell?.v);
        const addedAt = timestampDate || sheetDate || fileDate;

        for (const email of emails) {
          summary.occurrences += 1;
          if (timestampDate) {
            summary.timestampDates += 1;
          } else if (sheetDate) {
            summary.sheetDateFallbacks += 1;
          } else {
            summary.fileDateFallbacks += 1;
          }

          const normalizedCity = normalizeMarketingCity(region);
          const key = `${normalizedCity}\u0000${email}`;
          const current = candidates.get(key);
          const candidate = {
            email,
            city: normalizedCity,
            addedAt,
            unsubscribed: false,
          };

          if (!current) {
            candidates.set(key, candidate);
          } else {
            duplicateOccurrences += 1;
            if (candidate.addedAt < current.addedAt) {
              candidates.set(key, candidate);
            }
          }
        }
      }

      if (tabHasEmails) summary.tabsWithEmails += 1;
    }

    summaries.push(summary);
  }

  return { candidates, duplicateOccurrences, summaries };
};

const findExistingKeys = async (candidates) => {
  const existing = new Set();
  const cursor = MarketingEmail.find({}).select("email city").lean().cursor();

  for await (const entry of cursor) {
    const key = `${normalizeMarketingCity(entry.city)}\u0000${normalizeMarketingEmail(entry.email)}`;
    if (candidates.has(key)) existing.add(key);
  }

  return existing;
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

const printSummary = ({ scan, existing, applied, apply }) => {
  console.log(`\n[archive-marketing-backfill] ${apply ? "APPLY" : "DRY RUN"} summary`);

  for (const summary of scan.summaries) {
    console.log(
      `[${summary.region}] files=1 tabs=${summary.tabs} tabsWithEmails=${summary.tabsWithEmails} ` +
        `occurrences=${summary.occurrences} invalidEmailCells=${summary.invalidEmailCells} ` +
        `timestampDates=${summary.timestampDates} sheetDateFallbacks=${summary.sheetDateFallbacks} ` +
        `fileDateFallbacks=${summary.fileDateFallbacks}`
    );
  }

  console.log(
    `[combined] uniqueCandidates=${scan.candidates.size} duplicateOccurrences=${scan.duplicateOccurrences} ` +
      `alreadyPresent=${existing.size} ${apply ? "inserted" : "wouldInsert"}=${
        apply ? applied.inserted : scan.candidates.size - existing.size
      }`
  );

  if (apply) {
    console.log(`[combined] matchedExistingDuringWrite=${applied.matched}`);
  } else {
    console.log("\nRun again with --apply to insert the missing archive recipients.");
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const scan = scanArchive(options.archivePath);

  mongoose.set("strictQuery", true);
  await mongoose.connect(getMongoUri(), {
    autoCreate: options.apply,
    autoIndex: options.apply,
  });

  try {
    const existing = await findExistingKeys(scan.candidates);
    const applied = options.apply
      ? await applyCandidates(scan.candidates)
      : { inserted: 0, matched: 0 };

    printSummary({ scan, existing, applied, apply: options.apply });
  } finally {
    await mongoose.connection.close();
  }
};

if (isDirectRun) {
  main().catch(async (error) => {
    console.error(`[archive-marketing-backfill] Failed: ${error.message}`);

    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }

    process.exitCode = 1;
  });
}

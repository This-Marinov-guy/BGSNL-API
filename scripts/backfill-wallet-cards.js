import mongoose from "mongoose";
import { pathToFileURL } from "node:url";
import WalletCard from "../models/WalletCard.js";
import { ensureWalletRecord, walletOwnerQuery } from "../services/wallet/provision.js";

export async function backfillWalletCards({ database, records = WalletCard, apply = false }) {
  const counts = { scanned: 0, existing: 0, revoked: 0, missing: 0, provisioned: 0 };
  for (const collection of ["memberUsers", "alumniUsers"]) {
    const cursor = database.collection(collection).find({}, { projection: { _id: 1, accountAliases: 1 } });
    for await (const account of cursor) {
      counts.scanned++;
      const existing = await records.findOne(walletOwnerQuery(account));
      if (existing) { counts.existing++; if (existing.revokedAt) counts.revoked++; continue; }
      counts.missing++;
      if (apply) { await ensureWalletRecord(account, records); counts.provisioned++; }
    }
  }
  return counts;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--apply", "--dry-run"].includes(arg)) || (args.includes("--apply") && args.includes("--dry-run"))) {
    throw new Error("Use --dry-run (default) or --apply");
  }
  // Explicit target prevents accidentally selecting a production database via defaults.
  const uri = process.env.WALLET_MIGRATION_MONGODB_URI;
  const dbName = process.env.WALLET_MIGRATION_DB_NAME;
  if (!uri || !dbName) throw new Error("Set WALLET_MIGRATION_MONGODB_URI and WALLET_MIGRATION_DB_NAME explicitly");
  const apply = args.includes("--apply");
  await mongoose.connect(uri, { dbName, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 });
  try {
    // Database-enforced uniqueness must exist before creating tokens.
    if (apply) await WalletCard.collection.createIndex({ token: 1 }, { unique: true });
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...await backfillWalletCards({ database: mongoose.connection.db, apply }) }));
  } finally { await mongoose.disconnect(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Wallet migration failed. Check the target database, connection and indexes. No tokens or credentials were logged; it is safe to retry."); process.exitCode = 1; });
}

import csv from "csv-parser";
import { Readable } from "node:stream";
import { createStripeClient, getStripeKey } from "../../util/config/stripe.js";
import { stripeId } from "../../util/subscriptions/policy.js";
import { DEFAULT_REGION } from "../../util/config/defines.js";
import { MEMBER_REVENUE_ACCOUNTS, memberRevenueEnabled, memberRevenueLiveMode } from "../../util/config/member-revenue.js";
import { processMemberRevenueSharing, verifyRevenuePlatform } from "./revenue-sharing.js";
import { withBillingLease } from "./lease.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";

const REPORT_TYPE = "all_fees.balance_transaction_created.itemized.2";
const COLUMNS = ["amount", "tax", "currency", "balance_transaction_id", "fee_transaction_id", "incurred_by", "incurred_by_type", "settled_via"];
const roundCents = (micros) => {
  const value = Number((micros + (micros < 0n ? -5000000000n : 5000000000n)) / 10000000000n);
  if (!Number.isSafeInteger(value)) throw new Error("Fee report amount is too large");
  return value;
};
const decimal = (value) => {
  if (!/^-?\d+(?:\.\d{1,12})?$/.test(value || "")) throw new Error("Invalid fee report amount");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  return (BigInt(whole) * 1000000000000n + BigInt(fraction.padEnd(12, "0"))) * (negative ? -1n : 1n);
};

export async function parseMemberFeeReport(body) {
  const rows = [];
  const parser = Readable.from([body]).pipe(csv({ strict: true }));
  for await (const row of parser) rows.push(row);
  return rows;
}

// Aggregate a whole immutable month, then replace each month's totals. Replaying
// a report after a crash never adds the same fee twice. Tax is INCLUDED in amount.
export function allocateMemberFees(rows, statements) {
  const byInvoice = new Map(statements.filter((s) => s.invoiceId).map((s) => [s.invoiceId, s]));
  const byCharge = new Map(statements.filter((s) => s.chargeId).map((s) => [s.chargeId, s]));
  const all = new Map();
  let unattributed = 0;
  for (const row of rows) {
    const share = row.incurred_by_type === "invoice" ? byInvoice.get(row.incurred_by) : byCharge.get(row.incurred_by);
    const region = Object.entries(MEMBER_REVENUE_ACCOUNTS).find(([, id]) => id === row.incurred_by)?.[0];
    if (!share && !region) {
      if (!row.incurred_by || !["invoice", "charge"].includes(row.incurred_by_type)) unattributed++;
      continue;
    }
    if ((row.currency || "").toLowerCase() !== "eur") throw new Error("Unexpected fee currency for member revenue");
    if (share?.balanceTransactionId && [row.balance_transaction_id, row.fee_transaction_id].includes(share.balanceTransactionId)) continue;
    // Credits funded by prepaid Stripe fee credits are not a second cash debit.
    // They require review rather than automatically billing a region again.
    if (!["balance", "invoice"].includes(row.settled_via)) { unattributed++; continue; }
    const id = share?._id || `region:${row.incurred_by}`;
    const entry = all.get(id) || { id, accountId: share?.accountId || row.incurred_by, region: share?.region || region, micros: 0n };
    entry.micros += decimal(row.amount);
    all.set(id, entry);
  }
  return { allocations: [...all.values()].map(({ micros, ...entry }) => ({ ...entry, amount: roundCents(micros) })), unattributed };
}

// Fees can identify the refund/dispute/transfer rather than its original
// payment. Resolve those Stripe objects before matching the enrolled ledger.
export async function resolveMemberFeeReferences(rows, stripe) {
  const cache = new Map();
  const resolved = [];
  for (const row of rows) {
    const service = { refund: "refunds", dispute: "disputes", transfer: "transfers" }[row.incurred_by_type];
    if (!service || !row.incurred_by) { resolved.push(row); continue; }
    const key = `${service}:${row.incurred_by}`;
    if (!cache.has(key)) cache.set(key, await stripe[service].retrieve(row.incurred_by));
    const object = cache.get(key);
    const charge = stripeId(object.charge || object.source_transaction);
    resolved.push({ ...row, incurred_by: charge || "", incurred_by_type: "charge" });
  }
  return resolved;
}

export async function downloadMemberFeeReport(file, { fetchFile = fetch, key = getStripeKey("secretKey", DEFAULT_REGION) } = {}) {
  const url = new URL(file.url);
  if (url.protocol !== "https:" || url.hostname !== "files.stripe.com" || url.username || url.password) throw new Error("Invalid Stripe report file URL");
  const response = await fetchFile(url.href, { headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error("Fee report download failed");
  return response.text();
}

export async function processMemberRevenueFees({ stripe = createStripeClient(DEFAULT_REGION), shares,
  enabled = memberRevenueEnabled(), now = new Date(), withLease = withBillingLease, download = downloadMemberFeeReport, coordinatorAssert = async () => {} } = {}) {
  if (!enabled) return;
  await verifyRevenuePlatform(stripe);
  // Nothing historical is charged to regions. Start with the first tracked
  // invoice month and process only complete months whose data is available.
  const first = await shares.findOne({ invoiceId: { $exists: true }, livemode: memberRevenueLiveMode() }).sort({ paidAt: 1 }).lean();
  if (!first) return;
  const start = new Date(first.paidAt);
  let month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (month < now) {
    const end = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
    if (end.getTime() + 96 * 3600000 > now.getTime()) return;
    const period = month.toISOString().slice(0, 7);
    const key = `member-revenue-fees:${memberRevenueLiveMode() ? "live" : "test"}:${period}`;
    await withLease(key, async ({ assertOwned: reportAssert }) => {
      const assertOwned = async () => { await coordinatorAssert(); await reportAssert(); };
      let run;
      // Reuse the immutable report on Stripe instead of storing report receipts.
      for await (const candidate of stripe.reporting.reportRuns.list({ limit: 100 })) {
        if (candidate.report_type === REPORT_TYPE && candidate.parameters?.interval_start === month.getTime() / 1000 &&
            candidate.parameters?.interval_end === end.getTime() / 1000 && candidate.status !== "failed") { run = candidate; break; }
      }
      if (!run) {
        const type = await stripe.reporting.reportTypes.retrieve(REPORT_TYPE);
        if (type.data_available_end < end.getTime() / 1000) throw new Error("Stripe fee report data is not available yet");
        run = await stripe.reporting.reportRuns.create({ report_type: REPORT_TYPE, parameters: {
          interval_start: month.getTime() / 1000, interval_end: end.getTime() / 1000, timezone: "UTC", columns: COLUMNS,
        } }, { idempotencyKey: key });
      }
      if (run.status === "failed") throw new Error("Stripe member fee report failed; review report configuration");
      if (run.status !== "succeeded") throw new Error("Stripe fee report is still processing; settlement postponed");
      const statements = await shares.find({ invoiceId: { $exists: true }, livemode: memberRevenueLiveMode() }).lean();
      const result = allocateMemberFees(await resolveMemberFeeReferences(await parseMemberFeeReport(await download(run.result)), stripe), statements);
      // Each immutable monthly total replaces itself on retry. Never clear
      // existing fees during a replay: settlement must not observe a false zero.
      await assertOwned();
      for (const entry of result.allocations) {
        const id = entry.id.startsWith("region:") ? `fee:${memberRevenueLiveMode() ? "live" : "test"}:${period}:${entry.accountId}` : entry.id;
        await assertOwned();
        await shares.updateOne({ _id: id }, { $set: { livemode: memberRevenueLiveMode(), accountId: entry.accountId, region: entry.region, [`extraFees.${period}`]: entry.amount } }, { upsert: true });
      }
      if (result.unattributed) {
        logOperationalError("service.unattributed-stripe-fees", new Error("Unattributed fees"), { rows: result.unattributed });
        console.error("Unattributed Stripe fees require review", { period, rows: result.unattributed });
      }
    });
    month = end;
  }
}

// One distributed coordinator serializes captures, fee reports and settlements
// across API instances. Webhooks only enrol subscriptions; they never transfer.
export async function processMemberRevenueMaintenance({ enabled = memberRevenueEnabled(), withLease = withBillingLease, ...dependencies } = {}) {
  if (!enabled) return;
  await withLease("member-revenue-maintenance", async ({ assertOwned }) => {
    await processMemberRevenueSharing({ ...dependencies, enabled, assertOwned, beforeSettle: async ({ shares, blocked }) => {
      await assertOwned();
      if (blocked.size) throw new Error("Complete invoice data is required before fee allocation");
      await processMemberRevenueFees({ ...dependencies, shares, enabled, coordinatorAssert: assertOwned });
    } });
  });
}

import PendingPayment from "../../models/PendingPayment.js";
import { memberRevenueLiveMode } from "../../util/config/member-revenue.js";
import { PENDING_MEMBER_TRANSFER_TYPE, WAITING_STRIPE_FUNDS } from "../subscriptions/pending-payments.js";

const PAGE_SIZE = 50;
const MAX_PAGE = 100;

export const normalizePaymentPage = value => {
  const page = value === undefined ? 1 : Number(value);
  return Number.isSafeInteger(page) && page >= 1 && page <= MAX_PAGE ? page : null;
};

export async function listPendingPayments({ page = 1, model = PendingPayment, livemode = memberRevenueLiveMode() } = {}) {
  if (!normalizePaymentPage(page)) throw new RangeError("Invalid payment page");
  if (model === PendingPayment && model.db.readyState !== 1) throw new Error("Pending payment database unavailable");
  const filter = { type: PENDING_MEMBER_TRANSFER_TYPE, reason: WAITING_STRIPE_FUNDS, livemode };
  const [total, records] = await Promise.all([
    model.countDocuments(filter),
    model.find(filter).sort({ createdAt: -1, _id: 1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
  ]);
  return { page, pageSize: PAGE_SIZE, total, hasMore: page * PAGE_SIZE < total,
    items: records.map(row => ({ invoiceId: row._id, subscriptionId: row.subscriptionId,
      accountId: row.accountId, region: row.region, type: row.type, reason: row.reason,
      amountCents: row.amountCents, currency: row.currency,
      invoicePaidAt: row.invoicePaidAt, createdAt: row.createdAt, updatedAt: row.updatedAt })) };
}

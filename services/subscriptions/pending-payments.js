import PendingPayment from "../../models/PendingPayment.js";

export const PENDING_MEMBER_TRANSFER_TYPE = "member_revenue_transfer";
export const WAITING_STRIPE_FUNDS = "waiting_stripe_funds";

export function pendingMemberTransfer(share) {
  const operation = share?.operation;
  if (operation?.kind !== "transfer" || operation.balanceDeferred !== true ||
      !Number.isSafeInteger(operation.amount) || operation.amount <= 0 ||
      !share._id?.startsWith("in_") || !share.subscriptionId?.startsWith("sub_") ||
      !share.accountId?.startsWith("acct_") || !operation.id) throw new Error("Invalid deferred member transfer");
  return { _id: share._id, type: PENDING_MEMBER_TRANSFER_TYPE, reason: WAITING_STRIPE_FUNDS,
    subscriptionId: share.subscriptionId, accountId: share.accountId, region: share.region,
    operationId: operation.id, amountCents: operation.amount, currency: "eur",
    livemode: share.livemode, invoicePaidAt: share.paidAt };
}

export const pendingMemberPayments = {
  async upsert(share, model = PendingPayment) {
    const { _id, ...fields } = pendingMemberTransfer(share);
    await model.updateOne({ _id }, { $set: fields }, { upsert: true });
  },
  async clear(invoiceId, model = PendingPayment) {
    await model.deleteOne({ _id: invoiceId, type: PENDING_MEMBER_TRANSFER_TYPE });
  },
};

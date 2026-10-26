import Event from "../../models/Event.js";
import mongoose from "mongoose";
import { withBillingLease } from "../subscriptions/lease.js";
import { updateEventStatistics, addEventToDataPool } from "../background-services/data-pool.js";
import { archiveProduct } from "../side-services/stripe.js";
import { deleteEventGuestTickets } from "../tickets/ticket-storage.js";
import { dispatchSitemapRefresh } from "../public-content/sitemap-dispatch.js";
import { academicYearLabel } from "../../util/config/academic-year.js";
import { refreshEventAverages } from "../background-services/regional-averages.js";

export const eventArchiveCutoff = (now = new Date()) =>
  new Date(new Date(now).getTime() - 3 * 24 * 60 * 60 * 1000);

export const expiredEventFilter = cutoff => ({
  $or: [
    { status: { $nin: ["archived", "cancelled", "draft"] },
      $or: [{ correctedDate: { $lte: cutoff } },
        { $and: [{ $or: [{ correctedDate: null }, { correctedDate: { $exists: false } }] }, { date: { $lte: cutoff } }] }] },
    { status: "archived", archiveCleanupPending: true },
  ],
});

// Both the scheduler and the manual archive action use this same procedure.
// Persist pending cleanup before touching storage so later runs can retry it.
export async function archiveEvent(eventId, { cutoff, stamp, cancel = false, deferCleanup = false, dependencies = {} } = {}) {
  const { lease = withBillingLease, load = (id, session) => Event.findById(id).session(session || null), statistics = updateEventStatistics,
    transaction = run => mongoose.connection.transaction(run),
    averages = refreshEventAverages, dataPool = addEventToDataPool, archiveStripeProduct = archiveProduct,
    removeGuestTickets = deleteEventGuestTickets, refresh = dispatchSitemapRefresh } = dependencies;
  return lease(`event-archive:${eventId}`, async ({ assertOwned }) => {
    let event, skip, becameArchived;
    await transaction(async session => {
      skip = false;
      event = await load(eventId, session);
      if (!event) throw new Error("Event not found");
      if (event.status === "draft") throw new Error("Drafts cannot be archived");
      if (cancel && event.status === "archived" && !event.cancellationRequestedAt) throw new Error("An already archived event cannot be cancelled");
      if (cutoff && event.status !== "archived" && (event.status === "cancelled" ||
        !(new Date(event.correctedDate || event.date) <= cutoff))) { event = null; return; }
      if (event.status === "archived" && event.archiveCleanupCompletedAt && !event.archiveCleanupPending) { skip = true; return; }
      await assertOwned(session);
      becameArchived = event.status !== "archived";
      if (event.status !== "archived") {
        await statistics(event, true, { session });
        event.mediaRetainedAt = new Date();
      }
      event.status = "archived";
      event.isSaleClosed = true;
      event.archiveCleanupPending = true;
      if (cancel && !event.cancellationRequestedAt) event.cancellationRequestedAt = new Date();
      if (stamp) stamp(event);
      await event.save({ session });
    });
    if (!event || skip) return event;
    // The status is committed before external cleanup. A later storage failure
    // must not leave an archived event in the public sitemap.
    if (becameArchived) {
      try { await refresh("archived", event); } catch { /* Best effort after commit. */ }
    }
    // Rebuild the event's region and the pooled national average from archived
    // records. A retry also repairs a previous failed refresh without recounting.
    await averages(event);
    // External side effects must not run inside a retried Mongo transaction.
    event.$session?.(null);
    if (deferCleanup) return event;
    if (event.product?.id && !await archiveStripeProduct(event.region || "", event.product.id)) {
      throw new Error("Stripe product archival did not complete");
    }
    await removeGuestTickets(String(event._id || event.id));
    dataPool(String(event._id || event.id), academicYearLabel(event.correctedDate || event.date), false);
    await assertOwned();
    event.archiveCleanupPending = false;
    event.archiveCleanupCompletedAt = new Date();
    await event.save();
    return event;
  });
}

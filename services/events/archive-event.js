import Event from "../../models/Event.js";
import mongoose from "mongoose";
import { withBillingLease } from "../subscriptions/lease.js";
import { updateEventStatistics, addEventToDataPool } from "../background-services/data-pool.js";
import { deleteProduct } from "../side-services/stripe.js";
import { deleteFolder } from "../../util/functions/cloudinary.js";
import { deleteEventGuestTickets } from "../tickets/ticket-storage.js";
import { dispatchSitemapRefresh } from "../public-content/sitemap-dispatch.js";

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
export async function archiveEvent(eventId, { cutoff, stamp, dependencies = {} } = {}) {
  const { lease = withBillingLease, load = (id, session) => Event.findById(id).session(session || null), statistics = updateEventStatistics,
    transaction = run => mongoose.connection.transaction(run),
    dataPool = addEventToDataPool, removeProduct = deleteProduct, removeFolder = deleteFolder,
    removeGuestTickets = deleteEventGuestTickets, refresh = dispatchSitemapRefresh } = dependencies;
  return lease(`event-archive:${eventId}`, async ({ assertOwned }) => {
    let event, skip, becameArchived;
    await transaction(async session => {
      skip = false;
      becameArchived = false;
      event = await load(eventId, session);
      if (!event) throw new Error("Event not found");
      if (event.status === "draft") throw new Error("Drafts cannot be archived");
      if (cutoff && event.status !== "archived" && (event.status === "cancelled" ||
        !(new Date(event.correctedDate || event.date) <= cutoff))) { event = null; return; }
      if (event.status === "archived" && event.archiveCleanupCompletedAt && !event.archiveCleanupPending) { skip = true; return; }
      await assertOwned(session);
      becameArchived = event.status !== "archived";
      if (event.status !== "archived") await statistics(event, true, { session });
      event.status = "archived";
      event.isSaleClosed = true;
      event.archiveCleanupPending = true;
      if (stamp) stamp(event);
      await event.save({ session });
    });
    if (!event || skip) return event;
    // The status is committed before external cleanup. A later storage failure
    // must not leave an archived event in the public sitemap.
    if (becameArchived) {
      try { await refresh("archived", event); } catch { /* Best effort. */ }
    }
    // External side effects must not run inside a retried Mongo transaction.
    event.$session?.(null);
    dataPool(String(event._id || event.id), "2024-2025", false);
    await removeGuestTickets(String(event._id || event.id));
    if (event.product?.id) await removeProduct(event.region || "", event.product.id);
    if (event.folder) await removeFolder(event.folder);
    await assertOwned();
    event.archiveCleanupPending = false;
    event.archiveCleanupCompletedAt = new Date();
    await event.save();
    return event;
  });
}

import HttpError from "../../models/Http-error.js";

/** Stamp administrative writes, preserving provenance when publishing a draft.
 * Background ticket/payment updates do not change the event editor attribution.
 */
export function stampEventMetadata(event, req, { source, now = new Date() } = {}) {
  const actor = req.account?._id || req.account?.id || req.user?.userId;
  if (!actor) throw new HttpError("Please login to save an event", 401);
  const actorId = String(actor);
  const origin = source || event;
  const creating = !source && event.isNew;
  const initializeMetadata = !event.metadata;
  event.set("metadata", {
    createdBy: creating ? actorId : origin.metadata?.createdBy ?? origin.draftOwner?.userId ?? null,
    createdAt: creating ? origin.createdAt ?? now : origin.metadata?.createdAt ?? origin.createdAt ?? null,
    updatedBy: actorId,
    updatedAt: now,
  }, { overwriteImmutable: initializeMetadata });
  return event.metadata;
}

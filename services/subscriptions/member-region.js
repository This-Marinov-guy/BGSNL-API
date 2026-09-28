import { randomUUID } from "node:crypto";
import { REGIONS } from "../../util/config/defines.js";
import HttpError from "../../models/Http-error.js";

// Profile region is not the Stripe account that owns a subscription.
export function selectedMemberRegion(plan, requested, current) {
  if (requested !== undefined && !REGIONS.includes(requested)) throw new HttpError("Select a valid local membership region", 422);
  if (plan.type !== "member") return undefined;
  // Older clients can omit this field; the new UI always requires a selection.
  return requested ?? (REGIONS.includes(current) ? current : undefined);
}

export function memberRegionMetadata(region, priceId, operationId = randomUUID()) {
  if (!region) return {};
  if (!REGIONS.includes(region)) throw new HttpError("Select a valid local membership region", 422);
  return { bgsnlMemberRegion: region, bgsnlMemberRegionPrice: priceId, bgsnlMemberRegionOperation: operationId };
}

export function confirmedMemberRegion(sub, state, subscription) {
  const metadata = sub.metadata || {};
  if (!state.hasBenefits || sub.pending_update || state.plan?.type !== "member" ||
      metadata.bgsnlMemberRegionPrice !== state.plan.priceId || !REGIONS.includes(metadata.bgsnlMemberRegion) ||
      !metadata.bgsnlMemberRegionOperation || metadata.bgsnlMemberRegionOperation === subscription.memberRegionOperation) return null;
  return { region: metadata.bgsnlMemberRegion, operation: metadata.bgsnlMemberRegionOperation };
}

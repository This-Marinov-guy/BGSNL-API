import HttpError from "../../models/Http-error.js";
import { accountIds, isSupportStaff } from "./policy.js";
import { publishGuestListChanged, streamGuestList, subscribeGuestList } from "../tickets/guest-list-live.js";

// Reuse the guest-list Redis transport; separate namespaces prevent cross-talk.
export async function publishSupportChanged(record) {
  const keys = ["support:inbox", `support:thread:${record._id}`];
  if (record.ownerAccountId) keys.push(`support:owner:${record.ownerAccountId}`);
  await Promise.all(keys.map(publishGuestListChanged));
}

export async function supportLiveScopes(input, actor, service) {
  if (input.conversationId) {
    const staff = input.staff === true;
    const record = await service.get(input.conversationId, { ...actor, staff });
    return [`support:thread:${record.id}`];
  }
  if (input.staff === true) {
    if (!isSupportStaff(actor.account)) throw new HttpError("Support staff access is required.", 403);
    return ["support:inbox"];
  }
  if (actor.account) return accountIds(actor.account).map(id => `support:owner:${id}`);
  if (!Array.isArray(input.guests) || !input.guests.length || input.guests.length > 20) throw new HttpError("Choose your saved support tickets.", 422);
  const keys = await Promise.all(input.guests.map(async access => {
    const record = await service.get(access?.id, { secret: access?.secret });
    return `support:thread:${record.id}`;
  }));
  return [...new Set(keys)];
}

export async function streamSupport(req, res, scopes, subscribe = subscribeGuestList) {
  return streamGuestList(req, res, scopes, async (keys, callback) => {
    const cleanup = [];
    try {
      for (const key of keys) cleanup.push(await subscribe(key, callback));
      return () => cleanup.forEach(stop => stop());
    } catch (error) {
      cleanup.forEach(stop => stop());
      throw error;
    }
  });
}

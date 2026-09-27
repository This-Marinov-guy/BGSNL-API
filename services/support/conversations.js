import { randomUUID } from "node:crypto";
import SupportConversation from "../../models/SupportConversation.js";
import HttpError from "../../models/Http-error.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";
import { assertSupportReplyAllowed, normalizeSupportStatus } from "./policy.js";
import { accountIds, authorizeConversation, digest, GUEST_ACCESS_MS, guestHash, isSupportStaff, MAX_MESSAGES,
  normalizeContact, pageNumber, publicConversation, safePagePath, supportAttachments, supportEnvironment, SUPPORT_STATUSES, SUPPORT_TYPES, textValue, uuid, validateStatus } from "./policy.js";

export function createSupportService({ records = SupportConversation, now = () => new Date(), notifyNewTicket = () => {}, notifyReply = () => {}, notifyChanged = () => {} } = {}) {
  const changed = record => {
    try { Promise.resolve(notifyChanged(record)).catch(() => console.warn("Support live update unavailable")); }
    catch { console.warn("Support live update unavailable"); }
  };
  const getRecord = (id) => records.findById(uuid(id)).select("+guestSecretHash +requestHash").lean();
  const load = async (id, actor) => authorizeConversation(await getRecord(id), actor, now().getTime());

  async function create(input, actor, context = {}) {
    const id = uuid(input.id);
    const contact = normalizeContact(input.contact, actor.account);
    const type = input.type === undefined ? "problem" : input.type;
    if (!SUPPORT_TYPES.includes(type)) throw new HttpError("Choose a problem report or recommendation.", 422);
    const subject = textValue(input.subject, "Subject", 140);
    const text = textValue(input.text, "Message", 4000);
    const pagePath = safePagePath(input.pagePath);
    const environment = type === "problem" ? supportEnvironment(input.environment, context.userAgent) : undefined;
    if (input.website) throw new HttpError("Report could not be submitted.", 422);
    const keyHash = actor.account ? undefined : guestHash(actor.secret);
    const requestHash = digest(JSON.stringify({ subject, text, pagePath, contact, ...(type === "recommendation" ? { type } : {}) }));
    const existing = await getRecord(id);
    const replay = (record) => {
      authorizeConversation(record, { ...actor, staff: false }, now().getTime());
      if (record.requestHash !== requestHash) throw new HttpError("This report reference was already used. Open the existing report or start a new one.", 409);
      return publicConversation(record);
    };
    if (existing) return replay(existing);
    const createdAt = now();
    try {
      const record = await records.create({
        _id: id, ownerAccountId: actor.account ? String(actor.account._id || actor.account.id) : null,
        contact, type, subject, pagePath, environment, requestHash, status: "open", revision: 0,
        ...(keyHash ? { guestSecretHash: keyHash, guestAccessExpiresAt: new Date(createdAt.getTime() + GUEST_ACCESS_MS) } : {}),
        createdAt, updatedAt: createdAt, lastMessageAt: createdAt, lastAuthor: "requester", messageCount: 1,
        messages: [{ id, author: "requester", authorAccountId: actor.account?.id || null, text, attachments: [], kind: "message", createdAt }],
      });
      const stored = record.toObject();
      changed(stored);
      try { notifyNewTicket(publicConversation(stored, { staff: true })); }
      catch (error) { logOperationalError("service.support-notification", error); console.error("Failed to enqueue support notification", { code: error?.code }); }
      return publicConversation(stored);
    } catch (error) {
      if (error.code === 11000) return replay(await getRecord(id));
      throw error;
    }
  }

  async function list(actor, { page, status, pageSize = "25" } = {}) {
    if (!actor.account || (actor.staff && !isSupportStaff(actor.account))) throw new HttpError("Please sign in with an authorized account.", 403);
    const filter = actor.staff ? {} : { ownerAccountId: { $in: accountIds(actor.account) } };
    if (status && status !== "all") {
      if (!SUPPORT_STATUSES.includes(status)) throw new HttpError("Unknown report status.", 422);
      filter.status = status === "open" ? { $in: ["open", "in_progress", "waiting_for_you"] } : status === "resolved" ? { $in: ["resolved", "closed"] } : status === "paused" ? { $in: ["paused", "frozen"] } : status;
    }
    const currentPage = pageNumber(page);
    if (!["10", "25", "50"].includes(String(pageSize))) throw new HttpError("Choose 10, 25 or 50 tickets per page.", 422);
    const size = Number(pageSize);
    const [items, count] = await Promise.all([
      records.find(filter).select("_id type subject status createdAt updatedAt lastMessageAt lastAuthor messageCount revision pagePath contact ownerAccountId")
        .sort({ lastMessageAt: -1, _id: -1 }).skip((currentPage - 1) * size).limit(size + 1).lean(),
      records.countDocuments(filter),
    ]);
    const total = Math.min(count, size * 200);
    return { conversations: items.slice(0, size).map((record) => publicConversation(record, actor)), page: currentPage,
      pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)), hasMore: currentPage < 200 && items.length > size };
  }

  async function prepareReply(id, input, actor) {
    const messageId = uuid(input.id);
    const record = await load(id, actor);
    // A confirmed message can still be retried after the ticket is locked.
    // reply() verifies the exact payload and author before returning a replay.
    if (!record.messages.some((message) => message.id === messageId)) assertSupportReplyAllowed(record, actor);
  }

  async function reply(id, input, actor) {
    const messageId = uuid(input.id);
    const text = textValue(input.text, "Message", 4000, false);
    const attachments = supportAttachments(input.attachments);
    const diagnostic = input.diagnostic === true || input.diagnostic === "true";
    if (diagnostic && (actor.staff || text !== "Automatic page screenshot" || attachments.length !== 1 || attachments[0].type !== "image")) {
      throw new HttpError("Invalid diagnostic screenshot.", 422);
    }
    if (!text && !attachments.length) throw new HttpError("Write a reply or attach a photo.", 422);
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = await load(id, actor);
      const author = actor.staff ? "staff" : "requester";
      const existing = record.messages.find((message) => message.id === messageId);
      if (existing) {
        if (existing.text !== text || existing.author !== author || existing.kind !== "message" || !!existing.diagnostic !== diagnostic ||
            JSON.stringify(existing.attachments || []) !== JSON.stringify(attachments) ||
            (actor.staff && existing.authorAccountId !== String(actor.account._id || actor.account.id))) throw new HttpError("This message reference was already used.", 409);
        return publicConversation(record, actor);
      }
      assertSupportReplyAllowed(record, actor);
      const previousStatus = normalizeSupportStatus(record.status);
      const reopened = !actor.staff && !diagnostic && previousStatus === "resolved";
      const createdAt = now();
      const updated = await records.findOneAndUpdate({ _id: record._id, revision: record.revision, "messages.id": { $ne: messageId } }, {
        $push: { messages: { id: messageId, author, authorAccountId: actor.account ? String(actor.account._id || actor.account.id) : null, kind: "message", text, attachments, createdAt, diagnostic } },
        $inc: { revision: 1, messageCount: 1 },
        ...(!diagnostic ? { $set: { lastMessageAt: createdAt, lastAuthor: author,
          status: previousStatus === "paused" ? "paused" : "open" } } : {}),
      }, { new: true, runValidators: true }).lean();
      if (updated) {
        changed(updated);
        // Notify only the successful write, not idempotent retries or conflicts.
        // Delivery must never turn a saved reply into an apparent failure.
        const failed = () => console.error("Failed to enqueue support reply notification");
        try {
          if (!diagnostic) Promise.resolve(notifyReply(publicConversation(updated, { staff: true }),
            { id: messageId, author, text, attachments, createdAt, reopened })).catch(failed);
        } catch { failed(); }
        return publicConversation(updated, actor);
      }
    }
    throw new HttpError("This report changed while you were replying. Refresh and try again.", 409);
  }

  async function changeStatus(id, input, actor) {
    const record = await load(id, actor);
    const status = validateStatus(input.status, normalizeSupportStatus(record.status), actor.staff);
    if (record.status === status) return publicConversation(record, actor);
    if (!Number.isInteger(input.revision) || input.revision !== record.revision) throw new HttpError("This report has changed. Refresh it before changing the status.", 409);
    if (record.messageCount >= MAX_MESSAGES) throw new HttpError("This conversation has reached its message limit.", 409);
    const createdAt = now();
    const updated = await records.findOneAndUpdate({ _id: record._id, revision: record.revision }, {
      $set: { status, lastMessageAt: createdAt, lastAuthor: actor.staff ? "staff" : "requester" }, $inc: { revision: 1, messageCount: 1 },
      $push: { messages: { id: randomUUID(), text: `Status changed to ${status.replaceAll("_", " ")}.`,
        author: actor.staff ? "staff" : "requester", authorAccountId: actor.account ? String(actor.account._id || actor.account.id) : null, kind: "status", createdAt } },
    }, { new: true, runValidators: true }).lean();
    if (!updated) throw new HttpError("This report has changed. Refresh and try again.", 409);
    changed(updated);
    return publicConversation(updated, actor);
  }

  async function activity(actor) {
    if (!actor.account) throw new HttpError("Please sign in to access ticket activity.", 403);
    const items = await records.find({ ownerAccountId: { $in: accountIds(actor.account) } })
      .select("_id revision lastAuthor").sort({ lastMessageAt: -1, _id: -1 }).limit(5000).lean();
    return { conversations: items.map(record => ({ id: record._id, revision: record.revision, lastAuthor: record.lastAuthor })) };
  }

  return { create, list, prepareReply, reply, changeStatus, activity,
    get: async (id, actor, options = {}) => publicConversation(await load(id, actor), { ...actor, ...options }),
  };
}

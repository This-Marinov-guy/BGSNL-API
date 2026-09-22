import { randomUUID } from "node:crypto";
import SupportConversation from "../../models/SupportConversation.js";
import HttpError from "../../models/Http-error.js";
import { accountIds, authorizeConversation, digest, GUEST_ACCESS_MS, guestHash, isSupportStaff, MAX_MESSAGES,
  normalizeContact, pageNumber, publicConversation, safePagePath, supportAttachments, supportEnvironment, SUPPORT_STATUSES, SUPPORT_TYPES, textValue, uuid, validateStatus } from "./policy.js";

export function createSupportService({ records = SupportConversation, now = () => new Date(), notifyNewTicket = () => {} } = {}) {
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
      try { notifyNewTicket(publicConversation(stored, { staff: true })); }
      catch (error) { console.error(`Failed to enqueue support notification for ${id}:`, error?.message || "unknown error"); }
      return publicConversation(stored);
    } catch (error) {
      if (error.code === 11000) return replay(await getRecord(id));
      throw error;
    }
  }

  async function list(actor, { page, status } = {}) {
    if (!actor.account || (actor.staff && !isSupportStaff(actor.account))) throw new HttpError("Please sign in with an authorized account.", 403);
    const filter = actor.staff ? {} : { ownerAccountId: { $in: accountIds(actor.account) } };
    if (status && status !== "all") {
      if (!SUPPORT_STATUSES.includes(status)) throw new HttpError("Unknown report status.", 422);
      filter.status = status;
    }
    const currentPage = pageNumber(page);
    const items = await records.find(filter).select("_id type subject status createdAt updatedAt lastMessageAt lastAuthor messageCount revision pagePath contact ownerAccountId")
      .sort({ lastMessageAt: -1, _id: -1 }).skip((currentPage - 1) * 25).limit(26).lean();
    return { conversations: items.slice(0, 25).map((record) => publicConversation(record, actor)), page: currentPage, hasMore: items.length > 25 };
  }

  async function reply(id, input, actor) {
    const messageId = uuid(input.id);
    const text = textValue(input.text, "Message", 4000, false);
    const attachments = supportAttachments(input.attachments);
    if (!text && !attachments.length) throw new HttpError("Write a reply or attach a photo.", 422);
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = await load(id, actor);
      const author = actor.staff ? "staff" : "requester";
      const existing = record.messages.find((message) => message.id === messageId);
      if (existing) {
        if (existing.text !== text || existing.author !== author || existing.kind !== "message" ||
            JSON.stringify(existing.attachments || []) !== JSON.stringify(attachments) ||
            (actor.staff && existing.authorAccountId !== String(actor.account._id || actor.account.id))) throw new HttpError("This message reference was already used.", 409);
        return publicConversation(record, actor);
      }
      if (record.status === "closed") throw new HttpError("This report is closed. Start a new report if you still need help.", 409);
      if (record.messageCount >= MAX_MESSAGES) throw new HttpError("This conversation has reached its message limit. Please start a new report.", 409);
      const createdAt = now();
      const updated = await records.findOneAndUpdate({ _id: record._id, revision: record.revision, "messages.id": { $ne: messageId } }, {
        $push: { messages: { id: messageId, author, authorAccountId: actor.account ? String(actor.account._id || actor.account.id) : null, kind: "message", text, attachments, createdAt } },
        $inc: { revision: 1, messageCount: 1 },
        $set: { lastMessageAt: createdAt, lastAuthor: author,
          status: actor.staff ? "waiting_for_you" : record.status === "in_progress" ? "in_progress" : "open" },
      }, { new: true, runValidators: true }).lean();
      if (updated) return publicConversation(updated, actor);
    }
    throw new HttpError("This report changed while you were replying. Refresh and try again.", 409);
  }

  async function changeStatus(id, input, actor) {
    const record = await load(id, actor);
    const status = validateStatus(input.status, record.status, actor.staff);
    if (record.status === status) return publicConversation(record, actor);
    if (!Number.isInteger(input.revision) || input.revision !== record.revision) throw new HttpError("This report has changed. Refresh it before changing the status.", 409);
    if (record.messageCount >= MAX_MESSAGES) throw new HttpError("This conversation has reached its message limit.", 409);
    const createdAt = now();
    const updated = await records.findOneAndUpdate({ _id: record._id, revision: record.revision }, {
      $set: { status, lastMessageAt: createdAt }, $inc: { revision: 1, messageCount: 1 },
      $push: { messages: { id: randomUUID(), text: `Status changed to ${status.replaceAll("_", " ")}.`,
        author: actor.staff ? "staff" : "requester", authorAccountId: actor.account ? String(actor.account._id || actor.account.id) : null, kind: "status", createdAt } },
    }, { new: true, runValidators: true }).lean();
    if (!updated) throw new HttpError("This report has changed. Refresh and try again.", 409);
    return publicConversation(updated, actor);
  }

  return { create, list, reply, changeStatus,
    get: async (id, actor, options = {}) => publicConversation(await load(id, actor), { ...actor, ...options }),
  };
}

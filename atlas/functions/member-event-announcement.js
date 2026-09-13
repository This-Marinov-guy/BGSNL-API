/* global context */
// Atlas Function source: paste into the trigger's Function editor.
exports = async function (changeEvent) {
  const event = changeEvent.fullDocument;
  const operation = changeEvent.operationType;
  if (!["insert", "update", "replace"].includes(operation) || !event ||
      !(event.memberAnnouncementQueuedAt instanceof Date) ||
      Object.prototype.hasOwnProperty.call(event, "memberAnnouncementCompletedAt") ||
      event.hidden === true || ["draft", "archived"].includes(event.status)) return { status: "ignored" };
  if (operation === "update") {
    const fields = changeEvent.updateDescription?.updatedFields || {};
    const removed = changeEvent.updateDescription?.removedFields || [];
    if (!Object.prototype.hasOwnProperty.call(fields, "memberAnnouncementQueuedAt") &&
        fields.hidden !== false && fields.status !== "opened" && !removed.includes("hidden")) return { status: "ignored" };
  }
  const eventId = String(changeEvent.documentKey?._id || "");
  if (!/^[a-f\d]{24}$/i.test(eventId) || String(event._id) !== eventId) throw new Error("Invalid event document key");
  const key = context.values.get("ATLAS_EVENT_TRIGGER_SECRET");
  if (typeof key !== "string" || key.length < 32) throw new Error("ATLAS_EVENT_TRIGGER_SECRET is not configured");
  // Fixed destination prevents forwarding the shared credential to a caller URL.
  const response = await context.http.post({
    url: "https://kanatitsa.bulgariansociety.nl/api/v1/integrations/atlas/member-event-announcement",
    headers: { "Content-Type": ["application/json"], "x-api-key": [key] },
    body: { eventId },
    encodeBodyAsJSON: true,
  });
  if (![200, 202].includes(response.statusCode)) throw new Error(`Event announcement API returned HTTP ${response.statusCode}`);
  // Do not log credentials, member data or response bodies in Atlas.
  return { status: response.statusCode === 202 ? "queued" : "ignored" };
};

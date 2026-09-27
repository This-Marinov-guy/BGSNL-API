import { createHash } from "node:crypto";
import HttpError from "../../models/Http-error.js";
import { validateEventPreferences } from "../../validation/form-validators.js";
import { checkDiscountsOnEvents } from "../main-services/event-action-service.js";
import { memberEventPrice, eventPageUrl } from "./member-event-links.js";

const plain = value => typeof value?.toObject === "function" ? value.toObject() : structuredClone(value);

export function memberEventPreferences(event, member, guest) {
  const data = plain(event);
  const price = guest ? (event.isFree ? 0 : checkDiscountsOnEvents(data).product?.guest?.price) : memberEventPrice(event, member)?.price;
  if (!Number.isFinite(Number(price)) || price == null) throw new HttpError("Ticket pricing is unavailable. Please try again later.", 503);
  const addOns = event.addOns?.isEnabled ? {
    isEnabled: true, isMandatory: !!event.addOns.isMandatory, multi: !!event.addOns.multi,
    title: event.addOns.title || "Add-ons", description: event.addOns.description || "",
    items: (event.addOns.items || []).map(item => ({ _id: String(item._id), title: item.title, description: item.description || "", price: Number(item.price || 0) })),
  } : { isEnabled: false, items: [] };
  // Deliberate allowlist: no account, guest list, billing IDs or saved answers.
  const result = {
    event: { id: String(event.id || event._id), title: event.title, description: event.description || "", text: event.text || "", poster: event.poster,
      date: event.date, correctedDate: event.correctedDate, location: event.location, region: event.region,
      ticketTimer: event.ticketTimer, isFree: !!event.isFree, isMemberFree: !!event.isMemberFree,
      addOns, extraInputsForm: plain(event.extraInputsForm || []) },
    price: Number(price), guest, eventUrl: eventPageUrl(event),
  };
  result.revision = createHash("sha256").update(JSON.stringify([result.price, guest, addOns, result.event.extraInputsForm])).digest("hex");
  return result;
}

export function validateMemberEventChoices(event, body = {}) {
  const ids = body.addOns ?? [];
  if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) {
    throw new HttpError("Please select valid add-ons.", 422);
  }
  const config = event.addOns;
  const items = config?.isEnabled ? config.items || [] : [];
  if ((!config?.multi && ids.length > 1) || (config?.isEnabled && config.isMandatory && ids.length === 0)) {
    throw new HttpError(config?.isMandatory && !ids.length ? "Please choose an add-on." : "Please choose only one add-on.", 422);
  }
  const addOns = ids.map(id => {
    const item = items.find(option => String(option._id) === id);
    if (!item) throw new HttpError("An add-on is no longer available. Please reload this page.", 422);
    if (Number(item.price) > 0 && !item.priceId) throw new HttpError("An add-on cannot be purchased right now.", 503);
    return { _id: String(item._id), title: item.title, price: Number(item.price || 0) };
  });
  const answers = body.preferences ?? {};
  if (!answers || Array.isArray(answers) || typeof answers !== "object") throw new HttpError("Please check your answers.", 422);
  const known = new Set((event.extraInputsForm || []).map(field => field.placeholder));
  if (Object.keys(answers).some(key => !known.has(key))) throw new HttpError("An answer does not belong to this event.", 422);
  const valid = validateEventPreferences(answers, event.extraInputsForm);
  if (valid !== true) throw new HttpError(valid, 422);
  const preferences = JSON.stringify(answers);
  const serializedAddOns = JSON.stringify(addOns);
  // Stripe metadata values have a 500-character limit. Never silently truncate.
  if (preferences.length > 500) throw new HttpError("Your answers are too long. Please shorten them before continuing.", 422);
  if (serializedAddOns.length > 500) throw new HttpError("Too many add-ons were selected. Please choose fewer options.", 422);
  return { addOns: serializedAddOns, preferences };
}

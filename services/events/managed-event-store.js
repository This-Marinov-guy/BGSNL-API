import mongoose from "mongoose";
import Event from "../../models/Event.js";
import ManagedNationalEvent from "../../models/ManagedNationalEvent.js";
import {
  ADMIN,
  DEFAULT_REGION,
  NATIONAL_BOARD_MEMBER,
  NATIONAL_COMMITTEE_MEMBER,
  SUPER_ADMIN,
} from "../../util/config/defines.js";

export const NATIONAL_URL_REGION = "national";
export const NATIONAL_EVENT_ROLES = [SUPER_ADMIN, ADMIN, NATIONAL_BOARD_MEMBER, NATIONAL_COMMITTEE_MEMBER];
export const isNationalEventRegion = region => region === DEFAULT_REGION || region === NATIONAL_URL_REGION;
export const storedEventRegion = region => region === NATIONAL_URL_REGION ? DEFAULT_REGION : region;
export const publicEventRegion = region => region === DEFAULT_REGION ? NATIONAL_URL_REGION : region;
export const isNationalEventManager = roles => Array.isArray(roles) && roles.some(role => NATIONAL_EVENT_ROLES.includes(role));
export const managedNationalEventQuery = { title: { $type: "string" } };

export const eventModelForRegion = region =>
  isNationalEventRegion(region) ? ManagedNationalEvent : Event;

export async function eventModelForId(id) {
  if (!mongoose.isValidObjectId(id)) return Event;
  if (await Event.exists({ _id: id })) return Event;
  if (await ManagedNationalEvent.exists({ _id: id, ...managedNationalEventQuery })) return ManagedNationalEvent;
  return Event;
}

export async function findManagedEventById(id) {
  const Model = await eventModelForId(id);
  return Model.findById(id);
}

import GuestMarketingEmail from "../../models/GuestMarketingEmail.js";
import MarketingEmail, { normalizeMarketingEmail } from "../../models/MarketingEmail.js";
import MemberUser from "../../models/MemberUser.js";
import AlumniUser from "../../models/AlumniUser.js";
import { REGIONS } from "../../util/config/defines.js";
import { academicYearLabel } from "../../util/config/academic-year.js";

const validEmail = email => typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const accountFilter = email => ({ $expr: { $eq: [{ $toLower: { $trim: { input: "$email" } } }, email] } });

export function guestMarketingKey(event, email) {
  const normalized = normalizeMarketingEmail(email);
  const eventDate = new Date(event.correctedDate || event.date);
  if (!validEmail(normalized) || !REGIONS.includes(event.region) || !Number.isFinite(eventDate.getTime())) return null;
  return { email: normalized, region: event.region, academicYear: academicYearLabel(eventDate) };
}

export async function removeGuestMarketingEmail(email, { GuestModel = GuestMarketingEmail, session } = {}) {
  const normalized = normalizeMarketingEmail(email);
  if (!validEmail(normalized)) return;
  await GuestModel.deleteMany({ email: normalized }, session ? { session } : {});
}

export async function recordGuestMarketingEmail(event, email, {
  GuestModel = GuestMarketingEmail, MemberModel = MemberUser, AlumniModel = AlumniUser,
  now = new Date(),
} = {}) {
  const key = guestMarketingKey(event, email);
  if (!key) return null;
  const [member, alumni] = await Promise.all([
    MemberModel.exists(accountFilter(key.email)), AlumniModel.exists(accountFilter(key.email)),
  ]);
  if (member || alumni) return null;
  const ticketAt = new Date(now);
  if (!Number.isFinite(ticketAt.getTime())) throw new Error("Invalid guest ticket date");
  try {
    await GuestModel.updateOne(key, {
      $setOnInsert: { ...key, firstTicketAt: ticketAt },
      $max: { lastTicketAt: ticketAt },
      $addToSet: { eventIds: event._id },
    }, { upsert: true, runValidators: true });
  } catch (error) {
    // Parallel ticket purchases for the same address can race to insert one key.
    if (error?.code !== 11000) throw error;
    await GuestModel.updateOne(key, { $max: { lastTicketAt: ticketAt }, $addToSet: { eventIds: event._id } });
  }
  // A signup may have completed while the ticket entry was being saved.
  const [newMember, newAlumni] = await Promise.all([
    MemberModel.exists(accountFilter(key.email)), AlumniModel.exists(accountFilter(key.email)),
  ]);
  if (newMember || newAlumni) {
    await removeGuestMarketingEmail(key.email, { GuestModel });
    return null;
  }
  return key;
}

// A stored guest address is an audience candidate, not permission to email it.
// Campaigns still require recorded consent and honor an unsubscribe in any city.
export async function findGuestMarketingAudience({ academicYear, region }, {
  GuestModel = GuestMarketingEmail, MarketingModel = MarketingEmail,
  MemberModel = MemberUser, AlumniModel = AlumniUser,
} = {}) {
  if (!/^\d{4}-\d{4}$/.test(academicYear) || !REGIONS.includes(region)) throw new Error("Invalid guest audience filter");
  const guests = await GuestModel.find({ academicYear, region }).select("email academicYear region firstTicketAt -_id").sort({ email: 1 }).lean();
  const emails = guests.map(row => row.email);
  if (!emails.length) return [];
  const [marketing, members, alumni] = await Promise.all([
    MarketingModel.find({ email: { $in: emails } }).select("email unsubscribed consent").lean(),
    MemberModel.find({ $expr: { $in: [{ $toLower: { $trim: { input: "$email" } } }, emails] } }).select("email").lean(),
    AlumniModel.find({ $expr: { $in: [{ $toLower: { $trim: { input: "$email" } } }, emails] } }).select("email").lean(),
  ]);
  const allowed = new Set(marketing.filter(row => row.consent?.granted === true && !row.unsubscribed).map(row => normalizeMarketingEmail(row.email)));
  const excluded = new Set([...marketing.filter(row => row.unsubscribed), ...members, ...alumni].map(row => normalizeMarketingEmail(row.email)));
  return guests.filter(row => allowed.has(row.email) && !excluded.has(row.email));
}

// Recheck immediately before an automatically triggered campaign is sent.
export async function isGuestMarketingRecipient(email, {
  GuestModel = GuestMarketingEmail, MarketingModel = MarketingEmail,
  MemberModel = MemberUser, AlumniModel = AlumniUser,
} = {}) {
  const normalized = normalizeMarketingEmail(email);
  if (!validEmail(normalized)) return false;
  const [guest, marketing, member, alumni] = await Promise.all([
    GuestModel.exists({ email: normalized }),
    MarketingModel.find({ email: normalized }).select("consent unsubscribed").lean(),
    MemberModel.exists(accountFilter(normalized)),
    AlumniModel.exists(accountFilter(normalized)),
  ]);
  return Boolean(guest && !member && !alumni && marketing.some(row => row.consent?.granted === true && !row.unsubscribed)
    && !marketing.some(row => row.unsubscribed));
}

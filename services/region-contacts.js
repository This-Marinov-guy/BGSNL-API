import RegionContact, { REGION_CONTACT_KEYS, REGION_CONTACT_EMAIL_PATTERN } from "../models/RegionContact.js";
import { logOperationalError } from "../middleware/axiom-logger.js";
import { diagnosticError } from "../util/http/public-error.js";

export async function loadRegionEmails({ ContactModel = RegionContact } = {}) {
  const rows = await ContactModel.find({ _id: { $in: REGION_CONTACT_KEYS } })
    .select({ _id: 1, email: 1 }).maxTimeMS(5000).lean();
  return Object.fromEntries(rows.flatMap(({ _id, email }) => {
    const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
    return REGION_CONTACT_KEYS.includes(_id) && normalized.length <= 254 && REGION_CONTACT_EMAIL_PATTERN.test(normalized)
      ? [[_id, normalized]] : [];
  }));
}

export const createRegionEmailsHandler = ({ loadContacts = loadRegionEmails } = {}) => async (_req, res) => {
  try {
    const emails = await loadContacts();
    if (!Object.keys(emails).length) {
      const error = new Error("No region contact emails available");
      logOperationalError("endpoint.region-contacts", error, diagnosticError(error));
      return res.status(503).json({ message: "We could not complete your request. Please try again." });
    }
    return res.json({ emails });
  } catch (error) {
    // Do not expose database errors or turn a public page into a fatal error.
    logOperationalError("endpoint.region-contacts", error, diagnosticError(error));
    return res.status(503).json({ message: "We could not complete your request. Please try again." });
  }
};

export const getRegionEmails = createRegionEmailsHandler();

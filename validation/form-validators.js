import { body, param } from "express-validator";
import {
  ALUMNI,
  DEFAULT_REGION,
  EVENT_DRAFT,
  EVENT_OPENED,
  MEMBER,
  REGIONS,
} from "../util/config/defines.js";
import { decryptData } from "../util/functions/helpers.js";
import Event from "../models/Event.js";

const EMAIL_MAX_LENGTH = 320;
const NAME_MAX_LENGTH = 120;
const TEXT_MAX_LENGTH = 5000;
const URL_MAX_LENGTH = 2048;
const PASSWORD_PATTERN = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z]).{8,}$/;
const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);
const LOGO_MIME_TYPES = new Set([...IMAGE_MIME_TYPES, "image/svg+xml"]);
const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

const isBooleanLike = (value) =>
  value === true || value === false || value === "true" || value === "false";

const isTrueLike = (value) => value === true || value === "true";

const isParsableDate = (value) =>
  isNonEmptyString(String(value ?? "")) && !Number.isNaN(new Date(value).getTime());

const isHttpUrl = (value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const parseJson = (value) => {
  if (typeof value === "string") {
    return JSON.parse(value);
  }

  return value;
};

const validateJsonValue = (value, predicate) => {
  try {
    return predicate(parseJson(value));
  } catch {
    return false;
  }
};

const fieldValidator = (field, condition) => {
  const validator = body(field);
  return condition ? validator.if(condition) : validator;
};

const requiredText = (field, label, max = NAME_MAX_LENGTH, condition) =>
  fieldValidator(field, condition)
    .isString()
    .withMessage(`${label} must be text`)
    .bail()
    .trim()
    .notEmpty()
    .withMessage(`${label} is required`)
    .bail()
    .isLength({ max })
    .withMessage(`${label} is too long`);

const optionalText = (field, label, max = TEXT_MAX_LENGTH, condition) =>
  fieldValidator(field, condition)
    .optional({ checkFalsy: true })
    .isString()
    .withMessage(`${label} must be text`)
    .bail()
    .trim()
    .isLength({ max })
    .withMessage(`${label} is too long`);

const requiredEmail = (field = "email") =>
  body(field)
    .isString()
    .withMessage("Email must be text")
    .bail()
    .trim()
    .isLength({ max: EMAIL_MAX_LENGTH })
    .withMessage("Email is too long")
    .bail()
    .isEmail()
    .withMessage("Please provide a valid email");

const requiredMongoId = (field, label) =>
  body(field).isMongoId().withMessage(`${label} is invalid`);

const optionalEmail = (field = "email") =>
  body(field)
    .optional({ checkFalsy: true })
    .isString()
    .withMessage("Email must be text")
    .bail()
    .trim()
    .isLength({ max: EMAIL_MAX_LENGTH })
    .withMessage("Email is too long")
    .bail()
    .isEmail()
    .withMessage("Please provide a valid email");

const requiredUrl = (field, label = "URL", condition) =>
  fieldValidator(field, condition)
    .isString()
    .withMessage(`${label} must be text`)
    .bail()
    .trim()
    .isLength({ max: URL_MAX_LENGTH })
    .withMessage(`${label} is too long`)
    .bail()
    .isURL({
      protocols: ["http", "https"],
      require_protocol: true,
      require_tld: false,
    })
    .withMessage(`${label} must be a valid HTTP(S) URL`);

const optionalUrl = (
  field,
  label = "URL",
  requireProtocol = false,
  condition
) =>
  fieldValidator(field, condition)
    .optional({ checkFalsy: true })
    .isString()
    .withMessage(`${label} must be text`)
    .bail()
    .trim()
    .isLength({ max: URL_MAX_LENGTH })
    .withMessage(`${label} is too long`)
    .bail()
    .isURL({
      protocols: ["http", "https"],
      require_protocol: requireProtocol,
      require_tld: false,
    })
    .withMessage(`${label} must be a valid URL`);

const optionalBoolean = (field, label = field, condition) =>
  fieldValidator(field, condition)
    .optional({ checkFalsy: false })
    .custom(isBooleanLike)
    .withMessage(`${label} must be true or false`);

const requiredBoolean = (field, label = field, condition) =>
  fieldValidator(field, condition)
    .custom(isBooleanLike)
    .withMessage(`${label} must be true or false`);

const requiredConsent = (field, label = "Consent", condition) =>
  fieldValidator(field, condition)
    .custom(
      (value) =>
        value === true ||
        value === "true" ||
        value === 1 ||
        value === "1" ||
        value === "on"
    )
    .withMessage(`${label} must be accepted`);

// User documents deliberately use string IDs such as
// `member_<ObjectId>`. Keep database-entity IDs on isMongoId(), but validate
// user IDs against their actual bounded string contract.
const requiredUserId = (field = "userId") =>
  requiredText(field, "User ID", 120);

const optionalUserId = (field = "userId") =>
  optionalText(field, "User ID", 120);

const optionalJson = (field, label, predicate, condition) =>
  fieldValidator(field, condition)
    .optional({ checkFalsy: true })
    .custom((value) => validateJsonValue(value, predicate))
    .withMessage(`${label} has an invalid format`);

const requiredJson = (field, label, predicate, condition) =>
  fieldValidator(field, condition)
    .custom((value) => validateJsonValue(value, predicate))
    .withMessage(`${label} has an invalid format`);

const uploadedFile = ({
  field,
  required = false,
  allowedMimeTypes,
  multiple = false,
}) =>
  body(field)
    .custom((_value, { req }) => {
      const value = multiple ? req.files?.[field] : req.file;
      const files = Array.isArray(value) ? value : value ? [value] : [];

      const isRequired =
        typeof required === "function" ? required(req) : required;

      if (isRequired && files.length === 0) {
        return false;
      }

      return files.every((file) => allowedMimeTypes.has(file.mimetype));
    })
    .withMessage(
      required
        ? `${field} is required and must have a supported file type`
        : `${field} must have a supported file type`
    );

const eventJsonObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parsePreferences = (value) => {
  if (value === undefined || value === null || value === "") return {};

  const parsed = parseJson(value);
  return eventJsonObject(parsed) ? parsed : null;
};

const isBlankPreference = (value) =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim().length === 0) ||
  (Array.isArray(value) && value.length === 0);

const normalizePreferenceDefinitions = (extraInputsForm) => {
  if (!Array.isArray(extraInputsForm) || extraInputsForm.length === 0) {
    return [];
  }

  const questions = new Set();
  const definitions = [];

  for (const input of extraInputsForm) {
    if (
      !eventJsonObject(input) ||
      !["text", "select"].includes(input.type) ||
      !isNonEmptyString(input.placeholder)
    ) {
      return null;
    }

    const question = input.placeholder;
    if (questions.has(question)) return null;
    questions.add(question);

    if (
      input.type === "select" &&
      (!Array.isArray(input.options) || input.options.length === 0)
    ) {
      return null;
    }

    definitions.push({
      question,
      type: input.type,
      required: isTrueLike(input.required),
      multiselect:
        input.type === "select" && isTrueLike(input.multiselect),
      options:
        input.type === "select"
          ? input.options.map((option) => String(option))
          : [],
    });
  }

  return definitions;
};

const serializedMultiselectValues = (value, options) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return [];

  // Current clients serialize a multi-select as `value1, value2`. Check for
  // an exact option first so a single option containing a comma remains valid.
  return options.includes(trimmed)
    ? [trimmed]
    : trimmed.split(/,\s*/).map((entry) => entry.trim());
};

/**
 * Validate the display-question keyed preferences object produced by the
 * purchase forms against an event's custom-field definition.
 *
 * A malformed legacy definition is intentionally treated as unenforceable so
 * an old event cannot make checkout unavailable. Newly written event schemas
 * are validated separately by eventExtraInputs().
 */
export const validateEventPreferences = (value, extraInputsForm) => {
  let preferences;

  try {
    preferences = parsePreferences(value);
  } catch {
    return "Custom-field answers have an invalid format";
  }

  if (!preferences) return "Custom-field answers have an invalid format";

  const definitions = normalizePreferenceDefinitions(extraInputsForm);
  if (definitions === null || definitions.length === 0) return true;

  const knownQuestions = new Set(
    definitions.map((definition) => definition.question)
  );
  const unknownQuestion = Object.keys(preferences).find(
    (question) => !knownQuestions.has(question)
  );

  if (unknownQuestion) {
    return `Custom-field answer "${unknownQuestion}" is not part of this event`;
  }

  for (const definition of definitions) {
    const answer = preferences[definition.question];

    if (isBlankPreference(answer)) {
      if (definition.required) {
        return `Answer for "${definition.question}" is required`;
      }
      continue;
    }

    if (definition.type === "text") {
      if (typeof answer !== "string" || answer.length > TEXT_MAX_LENGTH) {
        return `Answer for "${definition.question}" must be text`;
      }
      continue;
    }

    if (!definition.multiselect) {
      if (
        typeof answer !== "string" ||
        !definition.options.includes(answer)
      ) {
        return `Answer for "${definition.question}" must be an available option`;
      }
      continue;
    }

    const selections = serializedMultiselectValues(
      answer,
      definition.options
    );
    if (
      !selections ||
      selections.some(
        (selection) =>
          typeof selection !== "string" ||
          !definition.options.includes(selection)
      ) ||
      new Set(selections).size !== selections.length
    ) {
      return `Answer for "${definition.question}" must contain available options`;
    }
  }

  return true;
};

const eventPreferencesValidator = body("preferences").custom(
  async (value, { req }) => {
    const eventId = req.body?.eventId;
    if (!/^[a-f\d]{24}$/i.test(String(eventId ?? ""))) return true;

    let event;
    try {
      event = await Event.findById(eventId)
        .select("extraInputsForm")
        .lean();
    } catch {
      // The route's controller owns not-found/database failure responses. Do
      // not turn an infrastructure error into a misleading validation 422.
      return true;
    }

    if (!event) return true;

    const result = validateEventPreferences(value, event.extraInputsForm);
    if (result !== true) throw new Error(result);
    return true;
  }
);

const eventExtraInputs = (value) => {
  if (value === null) return true;
  if (!Array.isArray(value) || value.length > 50) return false;

  const questions = new Set();

  return value.every((item) => {
    if (
      !eventJsonObject(item) ||
      !["text", "select"].includes(item.type) ||
      !isNonEmptyString(item.placeholder) ||
      String(item.placeholder).length > 200 ||
      (item.required !== undefined && !isBooleanLike(item.required)) ||
      (item.multiselect !== undefined && !isBooleanLike(item.multiselect))
    ) {
      return false;
    }

    const question = item.placeholder.trim().toLocaleLowerCase();
    if (questions.has(question)) return false;
    questions.add(question);

    if (item.type !== "select") return true;

    return (
      Array.isArray(item.options) &&
      item.options.length > 0 &&
      item.options.length <= 100 &&
      item.options.every(
        (option) =>
          isNonEmptyString(option) && String(option).length <= 200
      )
    );
  });
};

const eventAddOns = (value) => {
  if (!eventJsonObject(value) || !isBooleanLike(value.isEnabled)) return false;
  if (!isTrueLike(value.isEnabled)) return true;
  if (!isNonEmptyString(value.title)) return false;
  if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > 50) {
    return false;
  }

  return value.items.every(
    (item) =>
      eventJsonObject(item) &&
      isNonEmptyString(item.title) &&
      item.title.length <= 200 &&
      (item.price === "" ||
        item.price === null ||
        item.price === undefined ||
        (Number.isFinite(Number(item.price)) && Number(item.price) >= 0))
  );
};

const eventPromotion = (value) => {
  if (!eventJsonObject(value) || !isBooleanLike(value.isEnabled)) return false;
  if (!isTrueLike(value.isEnabled)) return true;

  return (
    Number.isFinite(Number(value.discount)) &&
    Number(value.discount) >= 5 &&
    Number(value.discount) <= 95 &&
    isParsableDate(value.startTimer) &&
    isParsableDate(value.endTimer)
  );
};

const eventBirdPrice = (value, timerField) => {
  if (!eventJsonObject(value) || !isBooleanLike(value.isEnabled)) return false;
  if (!isTrueLike(value.isEnabled)) return true;

  const hasLimit =
    value.ticketLimit !== "" &&
    value.ticketLimit !== null &&
    value.ticketLimit !== undefined &&
    Number.isInteger(Number(value.ticketLimit)) &&
    Number(value.ticketLimit) >= 1;
  const hasTimer = isParsableDate(value[timerField]);

  return (
    Number.isFinite(Number(value.price)) &&
    Number(value.price) >= 1 &&
    Number.isFinite(Number(value.memberPrice)) &&
    Number(value.memberPrice) >= 1 &&
    (hasLimit || hasTimer)
  );
};

const eventPromoCodes = (value) =>
  Array.isArray(value) &&
  value.length <= 100 &&
  value.every(
    (item) =>
      eventJsonObject(item) &&
      isNonEmptyString(item.code) &&
      item.code.length <= 100 &&
      [1, 2, "1", "2"].includes(item.discountType) &&
      Number.isFinite(Number(item.discount)) &&
      Number(item.discount) > 0 &&
      (Number(item.discountType) !== 2 || Number(item.discount) <= 100) &&
      (item.useLimit === "" ||
        item.useLimit === null ||
        item.useLimit === undefined ||
        (Number.isInteger(Number(item.useLimit)) && Number(item.useLimit) >= 1)) &&
      (item.minAmount === "" ||
        item.minAmount === null ||
        item.minAmount === undefined ||
        (Number.isFinite(Number(item.minAmount)) && Number(item.minAmount) >= 0.01)) &&
      (item.active === undefined || isBooleanLike(item.active))
  );

const eventSubEvent = (value) => {
  if (value === null) return true;
  if (!eventJsonObject(value)) return false;
  if (
    value.description !== undefined &&
    (typeof value.description !== "string" || value.description.length > 1000)
  ) {
    return false;
  }
  if (!Array.isArray(value.links) || value.links.length > 50) return false;

  return value.links.every((link) => {
    if (!eventJsonObject(link)) return false;

    const name = String(link.name ?? "").trim();
    const href = String(link.href ?? "").trim();
    if (!name && !href) return true;

    return (
      name.length > 0 &&
      name.length <= 200 &&
      href.length <= URL_MAX_LENGTH &&
      isHttpUrl(href)
    );
  });
};

const eventImagesOrder = (value) =>
  Array.isArray(value) &&
  value.length <= 20 &&
  value.every(
    (item) =>
      eventJsonObject(item) &&
      (item.type === "existing"
        ? isNonEmptyString(item.url) && item.url.length <= URL_MAX_LENGTH
        : item.type === "new" && /^image_\d+$/.test(String(item.fileName || "")))
  );

const eventExistingImages = (value) =>
  Array.isArray(value) &&
  value.length <= 20 &&
  value.every((item) => isNonEmptyString(item) && item.length <= URL_MAX_LENGTH);

const isPublishedEvent = (_value, { req }) =>
  req.body?.status !== EVENT_DRAFT;

const requiresGuestPrice = (_value, { req }) =>
  req.body?.status !== EVENT_DRAFT &&
  !isTrueLike(req.body?.isSaleClosed) &&
  !isTrueLike(req.body?.isFree) &&
  !isTrueLike(req.body?.isTicketLink);

const requiresMemberPrice = (_value, { req }) =>
  req.body?.status !== EVENT_DRAFT &&
  !isTrueLike(req.body?.isSaleClosed) &&
  !isTrueLike(req.body?.isFree) &&
  !isTrueLike(req.body?.isMemberFree) &&
  !isTrueLike(req.body?.isTicketLink);

const requiresExternalTicketLink = (_value, { req }) =>
  req.body?.status !== EVENT_DRAFT &&
  !isTrueLike(req.body?.isSaleClosed) &&
  !isTrueLike(req.body?.isFree) &&
  isTrueLike(req.body?.isTicketLink);

const commonEventAdminValidators = [
  body("status")
    .optional({ checkFalsy: true })
    .isIn([EVENT_DRAFT, EVENT_OPENED])
    .withMessage("Event status is invalid"),
  body("draftData")
    .if(body("status").equals(EVENT_DRAFT))
    .optional({ checkFalsy: true })
    .custom((value) => validateJsonValue(value, eventJsonObject))
    .withMessage("Draft data has an invalid format"),
  requiredText("region", "Region", 80, isPublishedEvent),
  requiredText("title", "Title", 200, isPublishedEvent),
  body("date")
    .if(isPublishedEvent)
    .custom(isParsableDate)
    .withMessage("Date is invalid"),
  requiredText("location", "Location", 300, isPublishedEvent),
  body("ticketTimer")
    .if(isPublishedEvent)
    .custom(isParsableDate)
    .withMessage("Ticket closing date is invalid"),
  body("ticketLimit")
    .if(isPublishedEvent)
    .isInt({ min: 1, max: 100000 })
    .withMessage("Ticket limit must be a positive whole number"),
  requiredText("text", "Event content", 100000, isPublishedEvent),
  optionalText("description", "Description", 10000, isPublishedEvent),
  optionalText("entryIncluding", "Entry details", 5000, isPublishedEvent),
  optionalText("memberIncluding", "Member entry details", 5000, isPublishedEvent),
  optionalText("including", "Included details", 5000, isPublishedEvent),
  optionalUrl("ticketLink", "Ticket link", true, isPublishedEvent),
  requiredUrl(
    "ticketLink",
    "Ticket link",
    requiresExternalTicketLink
  ),
  optionalText("ticketColor", "Ticket color", 30, isPublishedEvent),
  body("guestPrice")
    .if(isPublishedEvent)
    .optional({ checkFalsy: true })
    .isFloat({ min: 0 })
    .withMessage("Guest price must be zero or greater"),
  body("guestPrice")
    .if(requiresGuestPrice)
    .isFloat({ min: 1 })
    .withMessage("Guest price must be at least 1 for a paid event"),
  body("memberPrice")
    .if(isPublishedEvent)
    .optional({ checkFalsy: true })
    .isFloat({ min: 0 })
    .withMessage("Member price must be zero or greater"),
  body("memberPrice")
    .if(requiresMemberPrice)
    .isFloat({ min: 1 })
    .withMessage("Member price must be at least 1 for this event"),
  body("activeMemberPrice")
    .if(requiresMemberPrice)
    .optional({ checkFalsy: true })
    .isFloat({ min: 1 })
    .withMessage("Active-member price must be at least 1"),
  optionalBoolean("memberOnly", "Member only", isPublishedEvent),
  optionalBoolean("hidden", "Hidden", isPublishedEvent),
  optionalBoolean("isTicketLink", "External ticket link", isPublishedEvent),
  optionalBoolean("isSaleClosed", "Sale closed", isPublishedEvent),
  body("bgImage")
    .if(isPublishedEvent)
    .isInt({ min: 1, max: 100 })
    .withMessage("Background image is invalid"),
  body("bgImageSelection")
    .if(isPublishedEvent)
    .isInt({ min: 1, max: 2 })
    .withMessage("Background image selection is invalid"),
  requiredBoolean("isFree", "Free event", isPublishedEvent),
  requiredBoolean("isMemberFree", "Free for members", isPublishedEvent),
  optionalBoolean("ticketQR", "Ticket QR", isPublishedEvent),
  optionalBoolean("ticketName", "Ticket name", isPublishedEvent),
  requiredJson("earlyBird", "Early-bird settings", (value) =>
    eventBirdPrice(value, "ticketTimer"), isPublishedEvent
  ),
  requiredJson("lateBird", "Late-bird settings", (value) =>
    eventBirdPrice(value, "startTimer"), isPublishedEvent
  ),
  requiredJson("guestPromotion", "Guest promotion", eventPromotion, isPublishedEvent),
  requiredJson("memberPromotion", "Member promotion", eventPromotion, isPublishedEvent),
  requiredJson("addOns", "Add-ons", eventAddOns, isPublishedEvent),
  requiredJson("subEvent", "Sub-event", eventSubEvent, isPublishedEvent),
  optionalJson("extraInputsForm", "Custom fields", eventExtraInputs, isPublishedEvent),
  optionalJson("promoCodes", "Promo codes", eventPromoCodes, isPublishedEvent),
  optionalJson("imagesOrder", "Image order", eventImagesOrder),
  optionalJson("existingImages", "Existing images", eventExistingImages),
];

export const checkEmailValidators = [requiredEmail()];

export const loginValidators = [
  requiredEmail(),
  requiredText("password", "Password", 256),
];

export const passwordResetEmailValidators = [requiredEmail()];

export const passwordTokenValidators = [
  requiredEmail(),
  body("token")
    .custom((value) => /^\d{6}$/.test(String(value ?? "")))
    .withMessage("Token must contain exactly 6 digits"),
];

export const changePasswordValidators = [
  ...passwordTokenValidators,
  body("password")
    .isString()
    .withMessage("Password must be text")
    .bail()
    .matches(PASSWORD_PATTERN)
    .withMessage(
      "Password must be at least 8 characters and include uppercase, lowercase and a number"
    ),
];

export const forceChangePasswordValidators = [
  requiredEmail(),
  body("password")
    .optional({ checkFalsy: true })
    .custom((value) => PASSWORD_PATTERN.test(String(value)))
    .withMessage(
      "Password must be at least 8 characters and include uppercase, lowercase and a number"
    ),
];

export const encryptDataValidators = [
  body("data")
    .isString()
    .withMessage("Data must be text")
    .bail()
    .isLength({ min: 1, max: 2000 })
    .withMessage("Data must contain between 1 and 2000 characters"),
];

export const activeMemberValidators = [
  requiredEmail(),
  body("phone")
    .isString()
    .withMessage("Phone must be text")
    .bail()
    .trim()
    .isLength({ min: 8, max: 40 })
    .withMessage("Please provide a valid phone number"),
  body("questions")
    .custom((value) => {
      let questions = value;

      if (typeof value === "string") {
        try {
          questions = JSON.parse(value);
        } catch {
          // Compatibility for clients that previously serialized an array via
          // String(array). New clients send JSON so commas in answers are safe.
          questions = value.split(",");
        }
      }

      return (
        Array.isArray(questions) &&
        questions.length === 4 &&
        questions.every((answer) => {
          if (!isNonEmptyString(answer) || answer.length > 5000) return false;
          return answer.trim().split(/\s+/).length <= 200;
        })
      );
    })
    .withMessage("Please provide exactly 4 answers of no more than 200 words each"),
  optionalText("positions", "Positions", 1000),
  body("date")
    .optional({ checkFalsy: true })
    .custom(
      (value) =>
        (typeof value === "string" && value.length <= 1000) ||
        (Array.isArray(value) &&
          value.length <= 20 &&
          value.every(
            (item) => isNonEmptyString(item) && item.length <= 200
          ))
    )
    .withMessage("Availability has an invalid format"),
  uploadedFile({ field: "cv", allowedMimeTypes: DOCUMENT_MIME_TYPES, multiple: true }),
];

export const editUserValidators = [
  requiredText("name", "Name"),
  requiredText("surname", "Surname"),
  requiredEmail(),
  body("phone")
    .optional({ checkFalsy: true })
    .isString()
    .withMessage("Phone must be text")
    .bail()
    .trim()
    .isLength({ min: 8, max: 40 })
    .withMessage("Please provide a valid phone number"),
  optionalText("university", "University", 200),
  optionalText("otherUniversityName", "Other university", 200),
  body("graduationDate")
    .optional({ checkFalsy: true })
    .isInt({ min: 1900, max: 2200 })
    .withMessage("Graduation year is invalid"),
  optionalText("course", "Course", 300),
  optionalText("studentNumber", "Student number", 100),
  optionalText("profession", "Profession", 200),
  requiredText(
    "profession",
    "Profession",
    200,
    (_value, { req }) => req.body?.university === "working"
  ),
  optionalText("notificationTypeTerms", "Notification preference", 100),
  body("password")
    .optional({ checkFalsy: true })
    .custom((value) => PASSWORD_PATTERN.test(String(value)))
    .withMessage(
      "Password must be at least 8 characters and include uppercase, lowercase and a number"
    ),
];

export const calendarVerificationValidators = [
  uploadedFile({ field: "image", required: true, allowedMimeTypes: IMAGE_MIME_TYPES }),
];

export const alumniQuoteValidators = [
  body("quote")
    .exists()
    .withMessage("Quote is required")
    .bail()
    .isString()
    .withMessage("Quote must be text")
    .bail()
    .trim()
    .isLength({ max: 200 })
    .withMessage("Quote must not exceed 200 characters"),
];

const documentFileValidator = (required) =>
  uploadedFile({
    field: "content",
    required,
    allowedMimeTypes: DOCUMENT_MIME_TYPES,
  });

export const addDocumentValidators = [
  body("type")
    .isInt({ min: 1, max: 2 })
    .withMessage("Document type must be 1 or 2"),
  optionalUrl("content", "Document link", true),
  optionalText("name", "Document name", 255),
  documentFileValidator(false),
  body("content")
    .custom((value, { req }) => Boolean(req.file || (value && String(value).trim())))
    .withMessage("A document file or link is required"),
];

export const editDocumentValidators = [
  param("documentId").isMongoId().withMessage("Document ID is invalid"),
  body("type")
    .optional({ checkFalsy: true })
    .isInt({ min: 1, max: 2 })
    .withMessage("Document type must be 1 or 2"),
  documentFileValidator(true),
];

export const deleteDocumentValidators = [
  param("documentId").isMongoId().withMessage("Document ID is invalid"),
];

export const convertAlumniToUserValidators = [
  body("alumniId").isMongoId().withMessage("Alumni ID is invalid"),
];

export const convertUserToAlumniValidators = [requiredEmail()];

export const marketingEmailValidators = [
  requiredEmail(),
  requiredText("city", "City", 120),
];

export const contactFormValidators = [
  requiredText("name", "Name", 100),
  body("name")
    .isLength({ min: 2 })
    .withMessage("Name must contain at least 2 characters"),
  requiredEmail(),
  requiredText("subject", "Subject", 200),
  body("subject")
    .isLength({ min: 2 })
    .withMessage("Subject must contain at least 2 characters"),
  requiredText("message", "Message", 5000),
  body("message")
    .isLength({ min: 10 })
    .withMessage("Message must contain at least 10 characters"),
  body("region")
    .isIn([...REGIONS, DEFAULT_REGION])
    .withMessage("Region is invalid"),
];

export const contestRegistrationValidators = [
  requiredText("contestName", "Contest", 120),
  requiredText("name", "Name"),
  requiredText("surname", "Surname"),
  requiredEmail(),
  optionalText("comments", "Comments", 2000),
  requiredConsent("policyTerms", "Policy"),
];

export const christmasCardValidators = [
  requiredText("text", "Message", 2000),
  optionalUrl("gif", "GIF URL", true),
  optionalText("sender", "Sender", NAME_MAX_LENGTH * 2),
  body("sender")
    .custom((value, { req }) =>
      req.body.hideSender === true || req.body.hideSender === "true"
        ? true
        : isNonEmptyString(value)
    )
    .withMessage("Sender is required unless it is hidden"),
  optionalText("receiver", "Receiver", NAME_MAX_LENGTH * 2),
  requiredBoolean("randomReceiver", "Random receiver"),
  requiredBoolean("hideSender", "Hide sender"),
  body("receiver")
    .custom((value, { req }) =>
      req.body.randomReceiver === true || req.body.randomReceiver === "true"
        ? true
        : isNonEmptyString(value)
    )
    .withMessage("Receiver is required unless a random receiver is selected"),
];

export const addInternshipValidators = [
  requiredText("company", "Company", 200),
  requiredText("specialty", "Specialty", 200),
  requiredText("location", "Location", 200),
  body("label")
    .isIn(["Bulgarian", "International & Remote"])
    .withMessage("Internship label is invalid"),
  optionalText("duration", "Duration", 200),
  optionalText("description", "Description", 10000),
  optionalText("bonuses", "Bonuses", 5000),
  optionalText("requirements", "Requirements", 10000),
  optionalText("languages", "Languages", 1000),
  optionalEmail("contactMail"),
  optionalUrl("website", "Website"),
  optionalUrl("applyLink", "Application link"),
  optionalUrl("existingLogoUrl", "Existing logo", true),
  uploadedFile({ field: "logo", allowedMimeTypes: LOGO_MIME_TYPES }),
];

export const editInternshipValidators = [
  param("id").isMongoId().withMessage("Internship ID is invalid"),
  optionalText("company", "Company", 200),
  optionalText("specialty", "Specialty", 200),
  optionalText("location", "Location", 200),
  body("label")
    .optional({ checkFalsy: true })
    .isIn(["Bulgarian", "International & Remote"])
    .withMessage("Internship label is invalid"),
  optionalText("duration", "Duration", 200),
  optionalText("description", "Description", 10000),
  optionalText("bonuses", "Bonuses", 5000),
  optionalText("requirements", "Requirements", 10000),
  optionalText("languages", "Languages", 1000),
  optionalEmail("contactMail"),
  optionalUrl("website", "Website"),
  optionalUrl("applyLink", "Application link"),
  optionalUrl("existingLogoUrl", "Existing logo", true),
  optionalBoolean("isActive", "Active status"),
  uploadedFile({ field: "logo", allowedMimeTypes: LOGO_MIME_TYPES }),
];

export const deleteInternshipValidators = [
  param("id").isMongoId().withMessage("Internship ID is invalid"),
];

export const reorderInternshipsValidators = [
  body("internshipIds")
    .isArray({ min: 1, max: 10000 })
    .withMessage("Internship IDs must be a non-empty array")
    .bail()
    .custom((ids) => new Set(ids).size === ids.length)
    .withMessage("Internship IDs must not contain duplicates"),
  body("internshipIds.*").isMongoId().withMessage("Internship ID is invalid"),
];

export const internshipApplicationValidators = [
  requiredText("companyId", "Company ID", 120),
  requiredText("companyName", "Company name", 200),
  requiredText("position", "Position", 200),
  body("internshipId")
    .optional({ checkFalsy: true })
    .isMongoId()
    .withMessage("Internship ID is invalid"),
  optionalBoolean("skipCoverLetter", "Skip cover letter"),
  uploadedFile({ field: "coverLetter", allowedMimeTypes: DOCUMENT_MIME_TYPES }),
];

export const checkTicketEligibilityValidators = [
  requiredMongoId("eventId", "Event ID"),
  optionalUserId(),
  optionalBoolean("normalTicket", "Normal ticket"),
];

const ticketMetadataValidators = [
  requiredMongoId("eventId", "Event ID"),
  requiredUrl("origin_url", "Return URL"),
  requiredText("code", "Ticket code", 100),
  body("quantity")
    .optional({ checkFalsy: true })
    .isInt({ min: 1, max: 10 })
    .withMessage("Quantity must be a whole number between 1 and 10"),
  eventPreferencesValidator,
  optionalJson(
    "addOns",
    "Add-ons",
    (value) => Array.isArray(value) && value.length <= 50 && value.every(eventJsonObject)
  ),
];

export const guestTicketValidators = [
  ...ticketMetadataValidators,
  requiredEmail("guestEmail"),
  requiredText("guestName", "Guest name", NAME_MAX_LENGTH * 2),
  requiredText("guestPhone", "Guest phone", 50),
  body("method")
    .optional({ checkFalsy: true })
    .equals("buy_guest_ticket")
    .withMessage("Checkout method is invalid"),
];

export const guestCheckoutValidators = [
  ...guestTicketValidators,
  body("guestPhone")
    .isLength({ min: 8, max: 40 })
    .withMessage("Please provide a valid phone number"),
  requiredConsent("policyTerms", "Policy"),
  requiredConsent("payTerms", "Information-sharing consent"),
];

export const memberTicketValidators = [
  ...ticketMetadataValidators,
  requiredUserId(),
  optionalBoolean("normalTicket", "Normal ticket"),
  body("method")
    .optional({ checkFalsy: true })
    .equals("buy_member_ticket")
    .withMessage("Checkout method is invalid"),
];

export const manualMemberTicketValidators = [
  requiredMongoId("eventId", "Event ID"),
  requiredUserId(),
  requiredText("code", "Ticket code", 100),
  eventPreferencesValidator,
  optionalJson(
    "addOns",
    "Add-ons",
    (value) => Array.isArray(value) && value.length <= 50 && value.every(eventJsonObject)
  ),
  uploadedFile({ field: "image", required: true, allowedMimeTypes: IMAGE_MIME_TYPES }),
];

export const nonSocietyRegistrationValidators = [
  requiredText("event", "Event", 300),
  requiredText("name", "Name", NAME_MAX_LENGTH * 2),
  requiredEmail(),
  requiredText("university", "University", 300),
  requiredText("course", "Course", 300),
  body("date").custom(isParsableDate).withMessage("Event date is invalid"),
  optionalText("phone", "Phone", 50),
  optionalText("questions", "Questions", 1500),
  optionalText("referenceCode", "Reference code", 200),
  optionalText("timezone", "Timezone", 100),
  body("ticketImg")
    .isString()
    .withMessage("Ticket image must be text")
    .bail()
    .isLength({ min: 1, max: URL_MAX_LENGTH })
    .withMessage("Ticket image is invalid"),
  requiredUrl("origin_url", "Return URL"),
  body("user")
    .optional({ checkFalsy: true })
    .isIn(["member", "guest"])
    .withMessage("Registration user type is invalid"),
  optionalText("notificationTypeTerms", "Notification preference", 100),
  optionalText("extraData", "Extra data", 5000),
  requiredConsent("policyTerms", "Policy"),
  requiredConsent("payTerms", "Information-sharing consent"),
];

export const guestCheckInValidators = [
  requiredMongoId("eventId", "Event ID"),
  requiredText("code", "Ticket code", 100),
  body("count")
    .optional({ checkFalsy: true })
    .isInt({ min: 1, max: 1000 })
    .withMessage("Count must be a positive whole number"),
];

export const nonSocietyEmailValidators = [
  optionalBoolean("testOnly", "Test-only mode"),
  body("customEmails")
    .optional()
    .isArray({ max: 5000 })
    .withMessage("Custom emails must be an array"),
  body("customEmails.*")
    .optional()
    .isEmail()
    .withMessage("Custom email is invalid"),
  body("templateVariables")
    .optional({ checkFalsy: true })
    .custom((value) => eventJsonObject(value))
    .withMessage("Template variables must be an object"),
];

export const addEventValidators = [
  ...commonEventAdminValidators,
  uploadedFile({
    field: "poster",
    required: (req) => req.body?.status !== EVENT_DRAFT,
    allowedMimeTypes: IMAGE_MIME_TYPES,
    multiple: true,
  }),
  uploadedFile({
    field: "ticketImg",
    required: (req) => req.body?.status !== EVENT_DRAFT,
    allowedMimeTypes: IMAGE_MIME_TYPES,
    multiple: true,
  }),
  uploadedFile({ field: "images", allowedMimeTypes: IMAGE_MIME_TYPES, multiple: true }),
  uploadedFile({
    field: "bgImageExtra",
    allowedMimeTypes: IMAGE_MIME_TYPES,
    multiple: true,
  }),
];

export const editEventValidators = [
  param("eventId").isMongoId().withMessage("Event ID is invalid"),
  ...commonEventAdminValidators,
  uploadedFile({ field: "poster", allowedMimeTypes: IMAGE_MIME_TYPES, multiple: true }),
  uploadedFile({ field: "ticketImg", allowedMimeTypes: IMAGE_MIME_TYPES, multiple: true }),
  uploadedFile({ field: "images", allowedMimeTypes: IMAGE_MIME_TYPES, multiple: true }),
  uploadedFile({
    field: "bgImageExtra",
    allowedMimeTypes: IMAGE_MIME_TYPES,
    multiple: true,
  }),
];

export const deleteEventValidators = [
  param("eventId").isMongoId().withMessage("Event ID is invalid"),
];

const stripePrice = (field = "itemId") =>
  body(field)
    .isString()
    .withMessage("Price ID must be text")
    .bail()
    .matches(/^price_[A-Za-z0-9]+$/)
    .withMessage("Price ID is invalid");

const encryptedPassword = body("password")
  .isString()
  .withMessage("Password is invalid")
  .bail()
  .custom((value) => {
    try {
      const password = decryptData(value);
      return typeof password === "string" && PASSWORD_PATTERN.test(password);
    } catch {
      return false;
    }
  })
  .withMessage(
    "Password must be at least 8 characters and include uppercase, lowercase and a number"
  );

const isSignupStudent = (_value, { req }) =>
  req.body?.method === "signup" &&
  isNonEmptyString(req.body?.university) &&
  req.body.university !== "working";

const isSignupOtherUniversity = (_value, { req }) =>
  req.body?.method === "signup" && req.body?.university === "other";

const isSignupWorking = (_value, { req }) =>
  req.body?.method === "signup" && req.body?.university === "working";

export const signupCheckoutValidators = [
  body("method")
    .isIn(["signup", "alumni-signup"])
    .withMessage("Signup method is invalid"),
  stripePrice(),
  requiredUrl("origin_url", "Return URL"),
  requiredText("name", "Name"),
  requiredText("surname", "Surname"),
  requiredEmail(),
  encryptedPassword,
  body("period")
    .isInt({ min: 1, max: 120 })
    .withMessage("Membership period is invalid"),
  body("tier")
    .if(body("method").equals("alumni-signup"))
    .isInt({ min: 1, max: 4 })
    .withMessage("Alumni tier is invalid"),
  body("region")
    .if(body("method").equals("signup"))
    .isIn([...REGIONS, DEFAULT_REGION])
    .withMessage("Region is invalid"),
  body("birth")
    .if(body("method").equals("signup"))
    .custom(isParsableDate)
    .withMessage("Date of birth is invalid"),
  body("phone")
    .isString()
    .withMessage("Phone must be text")
    .bail()
    .trim()
    .isLength({ min: 8, max: 40 })
    .withMessage("Please provide a valid phone number"),
  body("university")
    .if(body("method").equals("signup"))
    .isString()
    .withMessage("University must be text")
    .bail()
    .trim()
    .notEmpty()
    .withMessage("University is required")
    .bail()
    .isLength({ max: 200 })
    .withMessage("University is too long"),
  optionalText("otherUniversityName", "Other university", 200),
  requiredText(
    "otherUniversityName",
    "Other university",
    200,
    isSignupOtherUniversity
  ),
  body("graduationDate")
    .if(isSignupStudent)
    .notEmpty()
    .withMessage("Graduation year is required"),
  body("graduationDate")
    .optional({ checkFalsy: true })
    .isInt({ min: 1900, max: 2050 })
    .withMessage("Graduation year is invalid"),
  optionalText("course", "Course", 300),
  requiredText("course", "Course", 300, isSignupStudent),
  optionalText("studentNumber", "Student number", 100),
  requiredText("studentNumber", "Student number", 100, isSignupStudent),
  optionalText("profession", "Profession", 200),
  requiredText("profession", "Profession", 200, isSignupWorking),
  optionalText("notificationTypeTerms", "Notification preference", 100),
  requiredConsent("policyTerms", "Policy"),
  requiredConsent(
    "dataTerms",
    "Data-processing consent",
    body("method").equals("signup")
  ),
  requiredConsent(
    "payTerms",
    "Payment consent",
    body("method").equals("signup")
  ),
  optionalBoolean("notificationTerms", "Notification consent"),
  uploadedFile({ field: "image", allowedMimeTypes: IMAGE_MIME_TYPES }),
];

export const subscriptionCheckoutValidators = [
  body("method")
    .isIn(["unlock_account", "alumni_migration"])
    .withMessage("Subscription method is invalid"),
  stripePrice(),
  requiredUrl("origin_url", "Return URL"),
  body("period")
    .isInt({ min: 1, max: 120 })
    .withMessage("Membership period is invalid"),
  body("tier")
    .if(body("method").equals("alumni_migration"))
    .isInt({ min: 1, max: 4 })
    .withMessage("Alumni tier is invalid"),
  body("region")
    .optional({ checkFalsy: true })
    .isIn([...REGIONS, DEFAULT_REGION])
    .withMessage("Region is invalid"),
];

export const generalCheckoutValidators = [
  requiredMongoId("eventId", "Event ID"),
  requiredUrl("origin_url", "Return URL"),
  body("method")
    .optional({ checkFalsy: true })
    .isIn(["buy_guest_ticket", "buy_member_ticket"])
    .withMessage("Checkout method is invalid"),
  body("quantity")
    .optional({ checkFalsy: true })
    .isInt({ min: 1, max: 10 })
    .withMessage("Quantity must be a whole number between 1 and 10"),
  optionalBoolean("normalTicket", "Normal ticket"),
  eventPreferencesValidator,
  optionalJson(
    "addOns",
    "Add-ons",
    (value) => Array.isArray(value) && value.length <= 50 && value.every(eventJsonObject)
  ),
];

export const customerPortalValidators = [
  requiredUrl("url", "Return URL"),
  body("type")
    .optional({ checkFalsy: true })
    .isIn([MEMBER, ALUMNI])
    .withMessage("Membership type is invalid"),
];

export const donationValidators = [
  body("amount")
    .isFloat({ min: 2, max: 10000 })
    .withMessage("Amount must be between 2 and 10000 euro"),
  body("name")
    .isString()
    .withMessage("Name must be text")
    .bail()
    .trim()
    .isLength({ max: 50 })
    .withMessage("Name must not exceed 50 characters"),
  body("comments")
    .isString()
    .withMessage("Comments must be text")
    .bail()
    .trim()
    .isLength({ max: 100 })
    .withMessage("Comments must not exceed 100 characters"),
];

export const playgroundTicketValidators = [
  requiredText("name", "Name"),
  requiredText("surname", "Surname"),
  body("quantity")
    .isInt({ min: 1, max: 20 })
    .withMessage("Quantity must be a whole number between 1 and 20"),
  requiredUrl("origin_url", "Return URL"),
];

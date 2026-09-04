import assert from "node:assert/strict";
import test from "node:test";
import {
  addDocumentValidators,
  addEventValidators,
  activeMemberValidators,
  alumniQuoteValidators,
  calendarVerificationValidators,
  checkTicketEligibilityValidators,
  contactFormValidators,
  contestRegistrationValidators,
  convertUserToAlumniValidators,
  editUserValidators,
  editInternshipValidators,
  generalCheckoutValidators,
  guestCheckInValidators,
  guestCheckoutValidators,
  guestTicketValidators,
  internshipApplicationValidators,
  loginValidators,
  manualMemberTicketValidators,
  marketingEmailValidators,
  memberTicketValidators,
  nonSocietyRegistrationValidators,
  passwordTokenValidators,
  signupCheckoutValidators,
  subscriptionCheckoutValidators,
} from "../validation/form-validators.js";
import AlumniUser from "../models/AlumniUser.js";
import Event from "../models/Event.js";
import User from "../models/User.js";
import { validateRequest } from "../middleware/validate-request.js";
import {
  formatUploadValidationError,
  unsupportedUploadError,
} from "../middleware/upload-validation-error.js";
import { encryptData } from "../util/functions/helpers.js";

const OBJECT_ID = "507f1f77bcf86cd799439011";
const MEMBER_ID = `member_${OBJECT_ID}`;
const CUSTOM_EVENT_FIELDS = [
  {
    type: "text",
    placeholder: "Dietary notes",
    required: true,
    multiselect: false,
  },
  {
    type: "select",
    placeholder: "Meal",
    required: true,
    multiselect: false,
    options: ["Vegetarian", "Vegan"],
  },
  {
    type: "select",
    placeholder: "Accessibility",
    required: false,
    multiselect: true,
    options: ["Wheelchair access", "Sign language"],
  },
];

const guestCheckoutBody = (preferences, quantity = "1") => ({
  quantity,
  origin_url: "https://bulgariansociety.nl",
  method: "buy_guest_ticket",
  eventId: OBJECT_ID,
  code: "1770000000000",
  guestEmail: "guest@example.com",
  guestName: "Guest User",
  guestPhone: "+31612345678",
  policyTerms: "true",
  payTerms: "true",
  ...(preferences === undefined ? {} : { preferences }),
});

const memberCheckoutBody = (preferences) => ({
  origin_url: "https://bulgariansociety.nl",
  method: "buy_member_ticket",
  eventId: OBJECT_ID,
  code: "1770000000001",
  userId: MEMBER_ID,
  normalTicket: "false",
  ...(preferences === undefined ? {} : { preferences }),
});

const validate = async (
  validators,
  request = {},
  { event = { extraInputsForm: [] }, lookupError = null, onLookup } = {}
) => {
  const req = {
    body: {},
    params: {},
    query: {},
    ...request,
  };

  const originalFindById = Event.findById;
  Event.findById = (eventId) => ({
    select(projection) {
      onLookup?.({ eventId, projection });
      return this;
    },
    async lean() {
      if (lookupError) throw lookupError;
      return event;
    },
  });

  try {
    for (const validator of validators) {
      await validator.run(req);
    }
  } finally {
    Event.findById = originalFindById;
  }

  const response = {
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  let nextCalled = false;

  validateRequest(req, response, () => {
    nextCalled = true;
  });

  return { nextCalled, response, req };
};

test("validation middleware returns a consistent field-keyed 422 payload", async () => {
  const { nextCalled, response } = await validate(loginValidators, {
    body: { email: "not-an-email", password: "" },
  });

  assert.equal(nextCalled, false);
  assert.equal(response.statusCode, 422);
  assert.equal(response.payload.message, "Please correct the invalid fields");
  assert.equal(response.payload.errors.email, "Please provide a valid email");
  assert.ok(response.payload.errors.password);
});

test("user-to-alumni conversion validates its documented email input", async () => {
  const missing = await validate(convertUserToAlumniValidators);
  assert.equal(missing.response.statusCode, 422);
  assert.ok(missing.response.payload.errors.email);

  const malformed = await validate(convertUserToAlumniValidators, {
    body: { email: "not-an-email" },
  });
  assert.equal(malformed.response.statusCode, 422);
  assert.equal(
    malformed.response.payload.errors.email,
    "Please provide a valid email"
  );

  const valid = await validate(convertUserToAlumniValidators, {
    body: { email: "member@example.com" },
  });
  assert.equal(valid.nextCalled, true);
});

test("password token validation matches the current email/token form", async () => {
  const { nextCalled } = await validate(passwordTokenValidators, {
    body: {
      email: "member@example.com",
      token: "123456",
      birth: "Invalid date",
    },
  });

  assert.equal(nextCalled, true);
});

test("guest check-in validates eventId/code instead of stale name/email fields", async () => {
  const { nextCalled } = await validate(guestCheckInValidators, {
    body: { eventId: OBJECT_ID, code: "ticket-123", count: null },
  });

  assert.equal(nextCalled, true);
});

test("manual member ticket accepts the controller's eventId contract", async () => {
  const { nextCalled } = await validate(manualMemberTicketValidators, {
    body: { eventId: OBJECT_ID, userId: MEMBER_ID, code: "ticket-123" },
    file: { mimetype: "image/png" },
  });

  assert.equal(nextCalled, true);
});

test("ticket JSON fields are rejected before controllers parse them", async () => {
  const { response } = await validate(guestTicketValidators, {
    body: {
      eventId: OBJECT_ID,
      origin_url: "https://example.com",
      code: "ticket-123",
      guestEmail: "guest@example.com",
      guestName: "Guest User",
      guestPhone: "-",
      addOns: "{bad-json",
    },
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.payload.errors.addOns, "Add-ons has an invalid format");
});

test("event drafts allow incomplete fields while validating draft JSON", async () => {
  const validDraft = await validate(addEventValidators, {
    body: { status: "draft", draftData: "{}" },
    files: {},
  });
  assert.equal(validDraft.nextCalled, true);

  const invalidDraft = await validate(addEventValidators, {
    body: { status: "draft", draftData: "{bad-json" },
    files: {},
  });
  assert.equal(invalidDraft.response.statusCode, 422);
  assert.ok(invalidDraft.response.payload.errors.draftData);
});

test("published event validation requires core fields and images", async () => {
  const { response } = await validate(addEventValidators, {
    body: { status: "opened" },
    files: {},
  });

  assert.equal(response.statusCode, 422);
  assert.ok(response.payload.errors.title);
  assert.ok(response.payload.errors.poster);
  assert.ok(response.payload.errors.ticketImg);
  assert.ok(response.payload.errors.guestPrice);
  assert.ok(response.payload.errors.memberPrice);
});

test("published event validation enforces conditional ticket and builder fields", async () => {
  const { response } = await validate(addEventValidators, {
    body: {
      status: "opened",
      region: "groningen",
      title: "External autumn gathering",
      date: "2026-10-10T18:00:00.000Z",
      location: "Groningen",
      ticketTimer: "2026-10-09T18:00:00.000Z",
      ticketLimit: "100",
      text: "Event content",
      isFree: "false",
      isMemberFree: "false",
      memberOnly: "false",
      isTicketLink: "true",
      isSaleClosed: "false",
      bgImage: "1",
      bgImageSelection: "1",
      earlyBird: JSON.stringify({ isEnabled: false }),
      lateBird: JSON.stringify({ isEnabled: false }),
      guestPromotion: JSON.stringify({ isEnabled: false }),
      memberPromotion: JSON.stringify({ isEnabled: false }),
      addOns: JSON.stringify({
        isEnabled: true,
        title: "",
        items: [{ title: "Dinner", price: 10 }],
      }),
      subEvent: JSON.stringify({
        description: "Related event",
        links: [{ name: "Details", href: "javascript:alert(1)" }],
      }),
      extraInputsForm: JSON.stringify([
        {
          type: "select",
          placeholder: "",
          required: false,
          multiselect: false,
          options: [],
        },
      ]),
      promoCodes: JSON.stringify([
        {
          code: "SAVE",
          discountType: 2,
          discount: 10,
          useLimit: 0,
          minAmount: 0,
          active: true,
        },
      ]),
    },
    files: {
      poster: [{ mimetype: "image/png" }],
      ticketImg: [{ mimetype: "image/png" }],
    },
  });

  assert.equal(response.statusCode, 422);
  assert.ok(response.payload.errors.ticketLink);
  assert.equal(response.payload.errors.memberPrice, undefined);
  assert.ok(response.payload.errors.addOns);
  assert.ok(response.payload.errors.subEvent);
  assert.ok(response.payload.errors.extraInputsForm);
  assert.ok(response.payload.errors.promoCodes);
});

test("published event validation ignores price fields hidden by closed sales", async () => {
  const { response } = await validate(addEventValidators, {
    body: {
      status: "opened",
      isSaleClosed: "true",
      isFree: "false",
      isMemberFree: "false",
      isTicketLink: "true",
    },
    files: {},
  });

  assert.equal(response.statusCode, 422);
  assert.equal(response.payload.errors.guestPrice, undefined);
  assert.equal(response.payload.errors.memberPrice, undefined);
  assert.equal(response.payload.errors.activeMemberPrice, undefined);
  assert.equal(response.payload.errors.ticketLink, undefined);
});

test("published EventForm multipart payload passes backend validation", async () => {
  const { nextCalled } = await validate(addEventValidators, {
    body: {
      status: "opened",
      region: "groningen",
      title: "Autumn gathering",
      description: "Event description",
      date: "2026-10-10T18:00:00.000Z",
      location: "Groningen",
      ticketTimer: "2026-10-09T18:00:00.000Z",
      ticketLimit: "100",
      text: "Event content",
      isFree: "false",
      isMemberFree: "false",
      memberOnly: "false",
      hidden: "false",
      isTicketLink: "false",
      isSaleClosed: "false",
      bgImage: "1",
      bgImageSelection: "1",
      ticketQR: "true",
      ticketName: "true",
      ticketColor: "#faf9f6",
      guestPrice: "15",
      memberPrice: "10",
      activeMemberPrice: "8",
      earlyBird: JSON.stringify({ isEnabled: false }),
      lateBird: JSON.stringify({ isEnabled: false }),
      guestPromotion: JSON.stringify({ isEnabled: false }),
      memberPromotion: JSON.stringify({ isEnabled: false }),
      addOns: JSON.stringify({ isEnabled: false, items: [] }),
      subEvent: "null",
      extraInputsForm: JSON.stringify([
        {
          type: "select",
          placeholder: "Dietary preference",
          required: "false",
          multiselect: "false",
          options: ["None", "Vegetarian"],
        },
      ]),
      imagesOrder: "[]",
      existingImages: "[]",
    },
    files: {
      poster: [{ mimetype: "image/png" }],
      ticketImg: [{ mimetype: "image/webp" }],
    },
  });

  assert.equal(nextCalled, true);
});

test("current guest and member checkout multipart payloads pass", async () => {
  const guest = await validate(guestCheckoutValidators, {
    body: {
      quantity: "2",
      origin_url: "http://localhost:3000",
      method: "buy_guest_ticket",
      eventId: OBJECT_ID,
      code: "1770000000000",
      guestEmail: "guest@example.com",
      guestName: "Guest User",
      guestPhone: "+31612345678",
      policyTerms: "true",
      payTerms: "true",
      preferences: JSON.stringify({ dietary: "vegetarian" }),
      addOns: JSON.stringify([{ id: "dinner", quantity: 1 }]),
    },
  });
  assert.equal(guest.nextCalled, true);

  const member = await validate(memberTicketValidators, {
    body: {
      origin_url: "https://bulgariansociety.nl",
      method: "buy_member_ticket",
      eventId: OBJECT_ID,
      code: "1770000000001",
      userId: MEMBER_ID,
      normalTicket: "false",
      preferences: JSON.stringify({ dietary: "none" }),
    },
  });
  assert.equal(member.nextCalled, true);
});

test("ticket checkout rejects a missing required custom answer", async () => {
  const result = await validate(
    guestCheckoutValidators,
    {
      body: guestCheckoutBody(
        JSON.stringify({ Meal: "Vegetarian", Accessibility: "" })
      ),
    },
    { event: { extraInputsForm: CUSTOM_EVENT_FIELDS } }
  );

  assert.equal(result.response.statusCode, 422);
  assert.equal(
    result.response.payload.errors.preferences,
    'Answer for "Dietary notes" is required'
  );
});

test("ticket checkout rejects select answers outside the event options", async () => {
  const result = await validate(
    memberTicketValidators,
    {
      body: memberCheckoutBody(
        JSON.stringify({
          "Dietary notes": "No allergies",
          Meal: "Steak",
        })
      ),
    },
    { event: { extraInputsForm: CUSTOM_EVENT_FIELDS } }
  );

  assert.equal(result.response.statusCode, 422);
  assert.equal(
    result.response.payload.errors.preferences,
    'Answer for "Meal" must be an available option'
  );
});

test("manual and public ticket validators enforce scalar and multiselect shapes", async () => {
  const scalarAsArray = await validate(
    manualMemberTicketValidators,
    {
      body: {
        eventId: OBJECT_ID,
        userId: MEMBER_ID,
        code: "manual-ticket-1",
        preferences: {
          "Dietary notes": "No allergies",
          Meal: ["Vegetarian"],
        },
      },
      file: { mimetype: "image/png" },
    },
    { event: { extraInputsForm: CUSTOM_EVENT_FIELDS } }
  );
  assert.equal(scalarAsArray.response.statusCode, 422);
  assert.equal(
    scalarAsArray.response.payload.errors.preferences,
    'Answer for "Meal" must be an available option'
  );

  const invalidMultiselect = await validate(
    guestTicketValidators,
    {
      body: {
        ...guestCheckoutBody({
          "Dietary notes": "No allergies",
          Meal: "Vegetarian",
          Accessibility: { selection: "Wheelchair access" },
        }),
      },
    },
    { event: { extraInputsForm: CUSTOM_EVENT_FIELDS } }
  );
  assert.equal(invalidMultiselect.response.statusCode, 422);
  assert.equal(
    invalidMultiselect.response.payload.errors.preferences,
    'Answer for "Accessibility" must contain available options'
  );
});

test("guest, member, and manual tickets accept valid display-question answers", async () => {
  const serializedAnswers = JSON.stringify({
    "Dietary notes": "No allergies",
    Meal: "Vegan",
    Accessibility: "Wheelchair access, Sign language",
  });
  let lookup;

  const guest = await validate(
    guestCheckoutValidators,
    { body: guestCheckoutBody(serializedAnswers) },
    {
      event: { extraInputsForm: CUSTOM_EVENT_FIELDS },
      onLookup: (details) => {
        lookup = details;
      },
    }
  );
  assert.equal(guest.nextCalled, true);
  assert.deepEqual(lookup, {
    eventId: OBJECT_ID,
    projection: "extraInputsForm",
  });

  const member = await validate(
    memberTicketValidators,
    {
      body: memberCheckoutBody({
        "Dietary notes": "No allergies",
        Meal: "Vegetarian",
        Accessibility: ["Sign language"],
      }),
    },
    { event: { extraInputsForm: CUSTOM_EVENT_FIELDS } }
  );
  assert.equal(member.nextCalled, true);

  const manual = await validate(
    manualMemberTicketValidators,
    {
      body: {
        eventId: OBJECT_ID,
        userId: MEMBER_ID,
        code: "manual-ticket-2",
        preferences: serializedAnswers,
      },
      file: { mimetype: "image/png" },
    },
    { event: { extraInputsForm: CUSTOM_EVENT_FIELDS } }
  );
  assert.equal(manual.nextCalled, true);
});

test("ticket preferences remain safe for no-field and malformed legacy events", async () => {
  const noFields = await validate(guestCheckoutValidators, {
    body: guestCheckoutBody(),
  });
  assert.equal(noFields.nextCalled, true);

  const legacy = await validate(
    memberTicketValidators,
    {
      body: memberCheckoutBody(
        JSON.stringify({ "Old custom answer": "Preserved" })
      ),
    },
    { event: { extraInputsForm: { legacy: true } } }
  );
  assert.equal(legacy.nextCalled, true);
});

test("ticket quantity is capped at the public purchase limit of 10", async () => {
  const boundary = await validate(guestCheckoutValidators, {
    body: guestCheckoutBody(undefined, "10"),
  });
  assert.equal(boundary.nextCalled, true);

  const guest = await validate(guestCheckoutValidators, {
    body: guestCheckoutBody(undefined, "11"),
  });
  assert.equal(guest.response.statusCode, 422);
  assert.equal(
    guest.response.payload.errors.quantity,
    "Quantity must be a whole number between 1 and 10"
  );

  const legacyCheckout = await validate(generalCheckoutValidators, {
    body: {
      eventId: OBJECT_ID,
      origin_url: "https://bulgariansociety.nl",
      method: "buy_guest_ticket",
      quantity: "11",
    },
  });
  assert.equal(legacyCheckout.response.statusCode, 422);
  assert.ok(legacyCheckout.response.payload.errors.quantity);
});

test("public guest checkout rejects an incomplete phone number", async () => {
  const guest = await validate(guestCheckoutValidators, {
    body: {
      ...guestCheckoutBody(),
      guestPhone: "+31 1",
    },
  });

  assert.equal(guest.response.statusCode, 422);
  assert.equal(
    guest.response.payload.errors.guestPhone,
    "Please provide a valid phone number"
  );
});

test("admin guest-ticket generation does not require public checkout consent", async () => {
  const adminGuest = await validate(guestTicketValidators, {
    body: {
      origin_url: "https://bulgariansociety.nl",
      method: "buy_guest_ticket",
      eventId: OBJECT_ID,
      code: "admin-ticket-1",
      guestEmail: "guest@example.com",
      guestName: "Guest User",
      guestPhone: "+31612345678",
    },
  });

  assert.equal(adminGuest.nextCalled, true);
});

test("current signup and subscription checkout payloads pass", async () => {
  const password = encryptData(JSON.stringify("StrongPass1"));
  const signup = await validate(signupCheckoutValidators, {
    body: {
      image: "null",
      period: "12",
      itemId: "price_1QOg1XAShinXgMFZyH0F4P9i",
      origin_url: "https://bulgariansociety.nl",
      method: "signup",
      region: "groningen",
      name: "Member",
      surname: "User",
      birth: "2000-01-01",
      phone: "+31612345678",
      email: "member@example.com",
      university: "rug",
      otherUniversityName: "",
      graduationDate: "2027",
      course: "Computer Science",
      studentNumber: "s1234567",
      password,
      notificationTypeTerms: "Any",
      policyTerms: "true",
      dataTerms: "true",
      payTerms: "true",
      notificationTerms: "false",
    },
  });
  assert.equal(signup.nextCalled, true);

  const alumniSignup = await validate(signupCheckoutValidators, {
    body: {
      image: "null",
      period: "12",
      itemId: "price_1Rx1XKAShinXgMFZqWsg4V0D",
      tier: "1",
      origin_url: "https://bulgariansociety.nl",
      method: "alumni-signup",
      name: "Alumni",
      surname: "Member",
      email: "alumni@example.com",
      password,
      policyTerms: "true",
      notificationTerms: "true",
      notificationTypeTerms: "whatsapp & email",
    },
  });
  assert.equal(alumniSignup.nextCalled, true);

  const unlock = await validate(subscriptionCheckoutValidators, {
    body: {
      method: "unlock_account",
      itemId: "price_1QOg1XAShinXgMFZyH0F4P9i",
      origin_url: "https://bulgariansociety.nl",
      period: "12",
      region: "groningen",
    },
  });
  assert.equal(unlock.nextCalled, true);
});

test("signup validation mirrors conditional student details", async () => {
  const password = encryptData(JSON.stringify("StrongPass1"));
  const base = {
    period: "12",
    itemId: "price_1QOg1XAShinXgMFZyH0F4P9i",
    origin_url: "https://bulgariansociety.nl",
    method: "signup",
    region: "groningen",
    name: "Member",
    surname: "User",
    birth: "2000-01-01",
    phone: "+31612345678",
    email: "member@example.com",
    password,
    policyTerms: "true",
    dataTerms: "true",
    payTerms: "true",
  };

  const missingStudentDetails = await validate(signupCheckoutValidators, {
    body: { ...base, university: "rug" },
  });
  assert.equal(missingStudentDetails.response.statusCode, 422);
  assert.ok(missingStudentDetails.response.payload.errors.graduationDate);
  assert.ok(missingStudentDetails.response.payload.errors.course);
  assert.ok(missingStudentDetails.response.payload.errors.studentNumber);

  const missingOtherUniversity = await validate(signupCheckoutValidators, {
    body: {
      ...base,
      university: "other",
      graduationDate: "2027",
      course: "Computer Science",
      studentNumber: "s1234567",
    },
  });
  assert.equal(missingOtherUniversity.response.statusCode, 422);
  assert.ok(missingOtherUniversity.response.payload.errors.otherUniversityName);

  const missingWorkingProfession = await validate(signupCheckoutValidators, {
    body: { ...base, university: "working" },
  });
  assert.equal(missingWorkingProfession.response.statusCode, 422);
  assert.ok(missingWorkingProfession.response.payload.errors.profession);

  const working = await validate(signupCheckoutValidators, {
    body: {
      ...base,
      university: "working",
      profession: "Software engineer",
    },
  });
  assert.equal(working.nextCalled, true);
});

test("working member profile updates require a profession", async () => {
  const base = {
    name: "Member",
    surname: "User",
    email: "member@example.com",
    university: "working",
  };

  const missingProfession = await validate(editUserValidators, { body: base });
  assert.equal(missingProfession.response.statusCode, 422);
  assert.ok(missingProfession.response.payload.errors.profession);

  const validWorkingUpdate = await validate(editUserValidators, {
    body: { ...base, profession: "Product designer" },
  });
  assert.equal(validWorkingUpdate.nextCalled, true);
});

test("user model includes the optional profession field", () => {
  assert.equal(User.schema.path("profession")?.instance, "String");
  assert.notEqual(User.schema.path("profession")?.isRequired, true);

  const workingMember = new User({ profession: "Software engineer" });
  assert.equal(workingMember.toObject().profession, "Software engineer");
});

test("alumni model stores optional contact consent", () => {
  assert.equal(AlumniUser.schema.path("notificationTerms")?.instance, "Boolean");
  assert.equal(
    AlumniUser.schema.path("notificationTypeTerms")?.instance,
    "String"
  );

  const alumni = new AlumniUser({
    notificationTerms: true,
    notificationTypeTerms: "whatsapp & email",
  });
  assert.equal(alumni.toObject().notificationTerms, true);
  assert.equal(alumni.toObject().notificationTypeTerms, "whatsapp & email");
});

test("current active-member and internship mutations pass", async () => {
  const activeMember = await validate(activeMemberValidators, {
    body: {
      positions: "PR of Integration Committee",
      date: ["1st September"],
      email: "member@example.com",
      phone: "+31612345678",
      cv: "undefined",
      questions: JSON.stringify([
        "First answer",
        "Second answer",
        "Third answer",
        "Fourth answer",
      ]),
    },
    files: {},
  });
  assert.equal(activeMember.nextCalled, true);

  const internshipToggle = await validate(editInternshipValidators, {
    params: { id: OBJECT_ID },
    body: { isActive: "false" },
  });
  assert.equal(internshipToggle.nextCalled, true);

  const application = await validate(internshipApplicationValidators, {
    body: {
      companyId: OBJECT_ID,
      companyName: "Example Company",
      position: "Software Engineering Intern",
      internshipId: OBJECT_ID,
      skipCoverLetter: "true",
    },
    files: {},
  });
  assert.equal(application.nextCalled, true);
});

test("active-member validation preserves four ordered answers", async () => {
  const base = {
    positions: "PR of Integration Committee",
    email: "member@example.com",
    phone: "+31612345678",
  };
  const fiveAnswers = await validate(activeMemberValidators, {
    body: {
      ...base,
      questions: JSON.stringify(["One", "Two", "Three", "Four", "Five"]),
    },
    files: {},
  });
  assert.equal(fiveAnswers.response.statusCode, 422);
  assert.ok(fiveAnswers.response.payload.errors.questions);

  const longAnswer = Array.from({ length: 201 }, () => "word").join(" ");
  const tooLong = await validate(activeMemberValidators, {
    body: {
      ...base,
      questions: JSON.stringify([longAnswer, "Two", "Three", "Four"]),
    },
    files: {},
  });
  assert.equal(tooLong.response.statusCode, 422);
  assert.ok(tooLong.response.payload.errors.questions);
});

test("alumni quote limit matches the UserCard form", async () => {
  const accepted = await validate(alumniQuoteValidators, {
    body: { quote: "a".repeat(200) },
  });
  assert.equal(accepted.nextCalled, true);

  const rejected = await validate(alumniQuoteValidators, {
    body: { quote: "a".repeat(201) },
  });
  assert.equal(rejected.response.statusCode, 422);
  assert.ok(rejected.response.payload.errors.quote);
});

test("document and calendar validators inspect multipart file metadata", async () => {
  const documentLink = await validate(addDocumentValidators, {
    body: {
      type: "1",
      name: "CV",
      content: "https://example.com/cv.pdf",
    },
  });
  assert.equal(documentLink.nextCalled, true);

  const badCalendarFile = await validate(calendarVerificationValidators, {
    body: {},
    file: { mimetype: "application/pdf" },
  });
  assert.equal(badCalendarFile.response.statusCode, 422);
  assert.ok(badCalendarFile.response.payload.errors.image);
});

test("marketing capture validates both email syntax and city", async () => {
  const { response } = await validate(marketingEmailValidators, {
    body: { email: "wrong", city: "" },
  });

  assert.equal(response.statusCode, 422);
  assert.ok(response.payload.errors.email);
  assert.ok(response.payload.errors.city);
});

test("contact preflight validates the complete browser payload", async () => {
  const valid = await validate(contactFormValidators, {
    body: {
      name: "Ada Lovelace",
      email: "ada@example.com",
      subject: "Volunteering",
      message: "I would like to help at the next event.",
      region: "groningen",
    },
  });
  assert.equal(valid.nextCalled, true);

  const invalid = await validate(contactFormValidators, {
    body: {
      name: "Ada Lovelace",
      email: "wrong",
      subject: "Volunteering",
      message: "Too short",
      region: "unknown",
    },
  });
  assert.equal(invalid.response.statusCode, 422);
  assert.ok(invalid.response.payload.errors.email);
  assert.ok(invalid.response.payload.errors.message);
  assert.ok(invalid.response.payload.errors.region);
});

test("platform user IDs are accepted without weakening Mongo entity IDs", async () => {
  const eligible = await validate(checkTicketEligibilityValidators, {
    body: { eventId: OBJECT_ID, userId: MEMBER_ID, normalTicket: "false" },
  });
  assert.equal(eligible.nextCalled, true);

  const invalidEvent = await validate(checkTicketEligibilityValidators, {
    body: { eventId: MEMBER_ID, userId: MEMBER_ID },
  });
  assert.equal(invalidEvent.response.statusCode, 422);
  assert.ok(invalidEvent.response.payload.errors.eventId);
});

test("purchase and signup validators enforce submitted consent", async () => {
  const guest = await validate(guestCheckoutValidators, {
    body: {
      eventId: OBJECT_ID,
      origin_url: "https://bulgariansociety.nl",
      code: "ticket-123",
      guestEmail: "guest@example.com",
      guestName: "Guest User",
      guestPhone: "+31612345678",
      policyTerms: "false",
      payTerms: "true",
    },
  });
  assert.equal(guest.response.statusCode, 422);
  assert.ok(guest.response.payload.errors.policyTerms);

  const password = encryptData(JSON.stringify("StrongPass1"));
  const signup = await validate(signupCheckoutValidators, {
    body: {
      period: "12",
      itemId: "price_1QOg1XAShinXgMFZyH0F4P9i",
      origin_url: "https://bulgariansociety.nl",
      method: "signup",
      region: "groningen",
      name: "Member",
      surname: "User",
      birth: "2000-01-01",
      phone: "+31612345678",
      email: "member@example.com",
      university: "rug",
      graduationDate: "2027",
      course: "Computer Science",
      studentNumber: "s1234567",
      password,
      policyTerms: "true",
      dataTerms: "true",
      payTerms: "false",
    },
  });
  assert.equal(signup.response.statusCode, 422);
  assert.ok(signup.response.payload.errors.payTerms);
});

test("contest and non-society registration enforce their visible consents", async () => {
  const contest = await validate(contestRegistrationValidators, {
    body: {
      contestName: "video-creation",
      name: "Ada",
      surname: "Lovelace",
      email: "ada@example.com",
      policyTerms: false,
    },
  });
  assert.equal(contest.response.statusCode, 422);
  assert.ok(contest.response.payload.errors.policyTerms);

  const nonSociety = await validate(nonSocietyRegistrationValidators, {
    body: {
      event: "Career evening",
      name: "Ada Lovelace",
      email: "ada@example.com",
      university: "RUG",
      course: "Computer Science",
      date: "2026-10-10T18:00:00.000Z",
      ticketImg: "https://example.com/ticket.png",
      origin_url: "https://bulgariansociety.nl",
      policyTerms: "true",
      payTerms: "false",
    },
  });
  assert.equal(nonSociety.response.statusCode, 422);
  assert.ok(nonSociety.response.payload.errors.payTerms);
});

test("unsupported supplied files carry a field-keyed 422 validation error", () => {
  const error = unsupportedUploadError(
    { fieldname: "logo" },
    "a JPEG, PNG, WebP or SVG image"
  );

  assert.equal(error.statusCode, 422);
  assert.deepEqual(error.validationErrors, {
    logo: "logo must be a JPEG, PNG, WebP or SVG image",
  });

  assert.deepEqual(
    formatUploadValidationError({
      name: "MulterError",
      code: "LIMIT_FILE_SIZE",
      field: "image",
    }),
    {
      message: "Please correct the invalid fields",
      errors: { image: "File must not exceed 5 MB" },
    }
  );
});

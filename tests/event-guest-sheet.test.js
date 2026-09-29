import assert from "node:assert/strict";
import test from "node:test";
import { eventSheetRange, presenceFormatRequests, writeEventGuestSheet } from "../services/background-services/event-guest-sheet.js";
import { syncEventToSpreadsheet, syncSpecialEventToSpreadsheet } from "../services/background-services/google-spreadsheets.js";

const legacyRule = { booleanRule: { condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: '=$A$5:$A="present"' }] } } };
const unrelatedRule = { booleanRule: { condition: { type: "NUMBER_GREATER", values: [{ userEnteredValue: "1" }] } } };

const fakeSheets = (initialSheets) => {
  const sheets = initialSheets;
  const writes = [];
  const googleSheets = { spreadsheets: {
    get: async () => ({ data: { sheets } }),
    batchUpdate: async ({ resource }) => {
      const replies = [];
      for (const request of resource.requests) {
        if (request.addSheet) {
          const sheet = { properties: { ...request.addSheet.properties, sheetId: sheets.length } };
          sheets.push(sheet);
          replies.push({ addSheet: sheet });
        } else if (request.addConditionalFormatRule) {
          sheets[0].conditionalFormats ||= [];
          sheets[0].conditionalFormats.splice(request.addConditionalFormatRule.index, 0, request.addConditionalFormatRule.rule);
        } else if (request.updateConditionalFormatRule) {
          sheets[0].conditionalFormats[request.updateConditionalFormatRule.index] = request.updateConditionalFormatRule.rule;
        } else if (request.deleteConditionalFormatRule) {
          sheets[0].conditionalFormats.splice(request.deleteConditionalFormatRule.index, 1);
        }
      }
      return { data: { replies } };
    },
    values: {
      update: async (request) => { writes.push(["update", request]); },
      clear: async (request) => { writes.push(["clear", request]); },
    },
  } };
  return { googleSheets, sheets, writes };
};

test("guest-list ranges quote titles containing spaces and apostrophes", () => {
  assert.equal(eventSheetRange("Members' dinner", "A1"), "'Members'' dinner'!A1");
});

test("existing sheet ID zero is updated and presence formatting remains single across repeated syncs", async () => {
  const fake = fakeSheets([{ properties: { title: "Members' dinner", sheetId: 0 }, conditionalFormats: [unrelatedRule] }]);
  const options = { googleSheets: fake.googleSheets, auth: {}, spreadsheetId: "spreadsheet", sheetName: "Members' dinner",
    values: [["header"], ["guest"]], guestCount: 1 };
  await writeEventGuestSheet(options);
  await writeEventGuestSheet(options);
  assert.equal(fake.sheets.length, 1);
  assert.equal(fake.sheets[0].conditionalFormats.length, 2);
  assert.equal(fake.sheets[0].conditionalFormats[0].booleanRule.condition.values[0].userEnteredValue, '=$A6="present"');
  assert.deepEqual(fake.sheets[0].conditionalFormats[0].ranges[0], {
    sheetId: 0, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 10,
  });
  assert.deepEqual(fake.writes.map(([type, request]) => [type, request.range]), [
    ["update", "'Members'' dinner'!A1"], ["clear", "'Members'' dinner'!A3:ZZ"],
    ["update", "'Members'' dinner'!A1"], ["clear", "'Members'' dinner'!A3:ZZ"],
  ]);
});

test("old duplicate presence rules are replaced and removed when the list becomes empty", async () => {
  const fake = fakeSheets([{ properties: { title: "Guest list", sheetId: 0 }, conditionalFormats: [legacyRule, unrelatedRule, legacyRule] }]);
  const options = { googleSheets: fake.googleSheets, auth: {}, spreadsheetId: "spreadsheet", sheetName: "Guest list",
    values: [["header"]], guestCount: 2 };
  await writeEventGuestSheet(options);
  assert.equal(fake.sheets[0].conditionalFormats.length, 2);
  assert.equal(fake.sheets[0].conditionalFormats[0].ranges[0].endRowIndex, 7);
  await writeEventGuestSheet({ ...options, guestCount: 0 });
  assert.deepEqual(fake.sheets[0].conditionalFormats, [unrelatedRule]);
});

test("a missing sheet is created, while a destination write failure remains retryable", async () => {
  const fake = fakeSheets([]);
  const options = { googleSheets: fake.googleSheets, auth: {}, spreadsheetId: "spreadsheet", sheetName: "Guest list",
    values: [["header"]], guestCount: 0 };
  await writeEventGuestSheet(options);
  assert.equal(fake.sheets[0].properties.sheetId, 0);
  fake.googleSheets.spreadsheets.values.update = async () => { throw new Error("Google Sheets unavailable"); };
  await assert.rejects(writeEventGuestSheet(options), /Google Sheets unavailable/);
});

test("format requests keep unrelated rules and use the guest rows only", () => {
  const requests = presenceFormatRequests(0, [unrelatedRule, legacyRule, legacyRule], 3);
  assert.deepEqual(requests[0], { deleteConditionalFormatRule: { sheetId: 0, index: 2 } });
  assert.equal(requests[1].updateConditionalFormatRule.index, 1);
  assert.equal(requests[1].updateConditionalFormatRule.rule.ranges[0].endRowIndex, 8);
});

test("special-event guest lists use quoted ranges without society attendance formatting", async () => {
  const fake = fakeSheets([{ properties: { title: "Members' dinner", sheetId: 0 }, conditionalFormats: [unrelatedRule] }]);
  await writeEventGuestSheet({ googleSheets: fake.googleSheets, auth: {}, spreadsheetId: "spreadsheet",
    sheetName: "Members' dinner", values: [["header"]], guestCount: 1, formatPresence: false });
  assert.deepEqual(fake.sheets[0].conditionalFormats, [unrelatedRule]);
  assert.equal(fake.writes[0][1].range, "'Members'' dinner'!A1");

  const writes = [];
  await syncSpecialEventToSpreadsheet({ id: "special-1" }, {
    getClient: async () => ({ auth: {}, googleSheets: {} }),
    findEvent: async () => ({ event: "Members' dinner", date: new Date("2026-10-01T18:00:00Z"),
      guestList: [{ userId: "member-1", timestamp: new Date("2026-09-29T12:00:00Z"), name: "Ada", email: "ada@example.com" }] }),
    writeSheet: async input => { writes.push(input); },
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].formatPresence, false);
  assert.equal(writes[0].values[5][3], "ada@example.com");
});

test("the queued event handler reads current guests and exports their attendance", async () => {
  const writes = [];
  const event = {
    id: "event-123", region: "groningen", title: "Members' dinner", sheetName: "Members' dinner",
    status: "opened", date: new Date("2026-10-01T18:00:00Z"), ticketTimer: new Date("2026-09-30T18:00:00Z"),
    location: "Groningen", ticketLimit: 30, guestList: [
      { status: 1, type: "member", timestamp: new Date("2026-09-29T12:00:00Z"), name: "Ada", email: "ada@example.com", phone: "+31600000000", ticket: "ticket-a" },
      { status: 0, type: "guest", timestamp: new Date("2026-09-29T12:00:00Z"), name: "Grace", email: "grace@example.com", phone: "+31600000001", ticket: "ticket-b" },
    ],
  };
  await syncEventToSpreadsheet({ id: event.id }, {
    getClient: async () => ({ auth: {}, googleSheets: {} }),
    findEvent: async () => event,
    writeSheet: async (input) => { writes.push(input); },
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].guestCount, 2);
  assert.deepEqual(writes[0].values[4], ["Status", "Type", "Timestamp", "Name", "Email", "Phone", "Preferences", "AddOns", "Ticket", "Transaction Id"]);
  assert.deepEqual(writes[0].values.slice(5).map(row => [row[0], row[3], row[4]]), [
    ["present", "Ada", "ada@example.com"], ["missing", "Grace", "grace@example.com"],
  ]);
});

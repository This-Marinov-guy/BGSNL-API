// Google Sheets A1 notation requires quoted titles when they contain spaces or
// punctuation. Doubling an apostrophe keeps it inside the quoted sheet title.
export const eventSheetRange = (title, cells) => `'${String(title).replaceAll("'", "''")}'!${cells}`;

const PRESENCE_FORMULAS = new Set(['=$A$5:$A="present"', '=$A6="present"']);

export const presenceFormatRequests = (sheetId, existingRules = [], guestCount = 0) => {
  const managedIndexes = existingRules.flatMap((rule, index) =>
    rule?.booleanRule?.condition?.type === "CUSTOM_FORMULA" &&
    rule.booleanRule.condition.values?.some(value => PRESENCE_FORMULAS.has(value.userEnteredValue))
      ? [index] : []);
  const retainedIndex = guestCount > 0 ? managedIndexes[0] : undefined;
  const requests = managedIndexes.filter(index => index !== retainedIndex).sort((a, b) => b - a)
    .map(index => ({ deleteConditionalFormatRule: { sheetId, index } }));
  if (guestCount === 0) return requests;
  const rule = {
    ranges: [{ sheetId, startRowIndex: 5, endRowIndex: 5 + guestCount,
      startColumnIndex: 0, endColumnIndex: 10 }],
    booleanRule: {
      condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: '=$A6="present"' }] },
      format: { backgroundColor: { red: 0, green: 1, blue: 0 } },
    },
  };
  requests.push(retainedIndex === undefined
    ? { addConditionalFormatRule: { rule, index: 0 } }
    : { updateConditionalFormatRule: { rule, index: retainedIndex } });
  return requests;
};

export async function writeEventGuestSheet({ googleSheets, auth, spreadsheetId, sheetName, values, guestCount, formatPresence = true }) {
  const readSheet = async () => {
    const metadata = await googleSheets.spreadsheets.get({ auth, spreadsheetId,
      fields: "sheets(properties(sheetId,title),conditionalFormats)" });
    return metadata.data.sheets?.find(sheet => sheet.properties?.title === sheetName);
  };
  let sheet = await readSheet();
  if (!sheet) {
    try {
      const created = await googleSheets.spreadsheets.batchUpdate({ auth, spreadsheetId,
        resource: { requests: [{ addSheet: { properties: { title: sheetName, index: 0 } } }] } });
      sheet = created.data.replies?.[0]?.addSheet;
    } catch (error) {
      if (!/already exists/i.test(error?.message || "")) throw error;
      sheet = await readSheet();
    }
  }
  const sheetId = sheet?.properties?.sheetId;
  if (!Number.isInteger(sheetId)) throw new Error(`Guest list sheet could not be found: ${sheetName}`);

  await googleSheets.spreadsheets.values.update({ auth, spreadsheetId,
    range: eventSheetRange(sheetName, "A1"), valueInputOption: "RAW", resource: { values } });
  await googleSheets.spreadsheets.values.clear({ auth, spreadsheetId,
    range: eventSheetRange(sheetName, `A${values.length + 1}:ZZ`) });

  if (formatPresence) {
    const requests = presenceFormatRequests(sheetId, sheet.conditionalFormats || [], guestCount);
    if (requests.length) await googleSheets.spreadsheets.batchUpdate({ auth, spreadsheetId, resource: { requests } });
  }
}

import moment from "moment-timezone";
import Event from "../../models/Event.js";
import Statistics from "../../models/Statistics.js";
import { DATA_POOL } from "../../util/config/SPREEDSHEATS.js";
import { refactorToKeyValuePairs } from "../../util/functions/helpers.js";
import { MOMENT_DATE_TIME_YEAR } from "../../util/functions/dateConvert.js";
import { enqueueJob, getSheetsClient } from "./google-spreadsheets.js";

/**
 * Appends guest data for a specific event to the shared data pool spreadsheet.
 * Runs inside the existing background job queue defined in google-spreadsheets.js.
 */
export const addEventToDataPool = (eventId, sheetName = "2024-2025") => {
  enqueueJob(`addEventToDataPool:${eventId}:${sheetName}`, async () => {
    const { auth, googleSheets } = await getSheetsClient();
    try {
      const event = await Event.findById(eventId);

      if (!event) {
        console.log("Event not found in data pool fetching.");
        return;
      }

      if (!event?.guestList || event?.guestList?.length === 0) {
        console.log("No tickets to add.");
        return;
      }

      try {
        const eventStatistics = await Statistics.findOne({ type: "event" });
        eventStatistics.data.totalTickets += event.guestList.length;
        eventStatistics.data.count++;
        await eventStatistics.save();
      } catch (error) {
        console.error("Error updating event statistics:", error);
      }

      const rows = event.guestList.map((guest) => [
        guest.status === 0 ? "missing" : "present",
        guest.type ?? "-",
        guest.timestamp
          ? moment(guest.timestamp).format(MOMENT_DATE_TIME_YEAR)
          : "-",
        guest.name ?? "-",
        guest.email ?? "-",
        guest.phone ?? "-",
        guest.preferences ? refactorToKeyValuePairs(guest.preferences) : "N/A",
        guest.ticket ?? "-",
        event.sheetName ?? "-",
        event.id ?? "-",
        event.status ?? "-",
        event.region ?? "-",
        event.title ?? "-",
        event.date
          ? moment(event.correctedDate ?? event.date).format(
              MOMENT_DATE_TIME_YEAR
            )
          : "-",
        event.location ?? "-",
        event.ticketTimer
          ? moment(event.ticketTimer).format(MOMENT_DATE_TIME_YEAR)
          : "-",
        event.ticketLimit ?? "-",
        event.product?.guest.price ?? "-",
        event.product?.member.price ?? "-",
        event.product?.activeMember.price ?? event.product?.member.price ?? "-",
        event.ticketLink ?? "-",
        event.createdAt
          ? moment(event.createdAt).format(MOMENT_DATE_TIME_YEAR)
          : "-",
        guest.transactionId ?? "-",
      ]);

      if (rows.length === 0) {
        console.log("No tickets to add.");
        return;
      }

      const sheets = googleSheets;

      const { data } = await sheets.spreadsheets.values.get({
        auth,
        spreadsheetId: DATA_POOL,
        range: `${sheetName}!A:A`,
      });

      const nextRow = (data.values?.length || 1) + 1;

      await sheets.spreadsheets.values.append({
        auth,
        spreadsheetId: DATA_POOL,
        range: `${sheetName}!A${nextRow}`,
        valueInputOption: "RAW",
        resource: { values: rows },
      });

      console.log(`Tickets for event "${event.title}" added successfully!`);
    } catch (error) {
      console.error("Error adding tickets:", error);
    }
  });
};

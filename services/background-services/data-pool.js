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
 * @param {string} eventId - The ID of the event to add to data pool
 * @param {string} sheetName - The sheet name in the data pool (default: "2024-2025")
 * @param {boolean} updateStatistics - Whether to update event statistics (default: true)
 */
export const addEventToDataPool = (
  eventId,
  sheetName = "2024-2025",
  updateStatistics = true
) => {
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

      // Only update statistics if explicitly requested (e.g., when creating new events)
      if (updateStatistics) {
        await updateEventStatistics(event, true);
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

/**
 * Updates event statistics when an event is created or deleted
 * @param {Object} event - The event object
 * @param {boolean} increment - If true, increment statistics; if false, decrement
 */
export const updateEventStatistics = async (event, increment = true) => {
  try {
    if (!event) {
      console.log("Event not found for statistics update.");
      return;
    }

    // Find or create the statistics document
    let eventStatistics = await Statistics.findOne({ type: "event" });

    if (!eventStatistics) {
      console.log("Event statistics document not found. Creating new one...");
      eventStatistics = await Statistics.create({
        type: "event",
        data: {
          count: 0,
          totalTickets: 0,
          regions: 0,
        },
      });
    }

    // Ensure data object exists
    if (!eventStatistics.data) {
      eventStatistics.data = {
        count: 0,
        totalTickets: 0,
        regions: 0,
      };
    }

    // Ensure numeric fields exist
    if (typeof eventStatistics.data.count !== "number") {
      eventStatistics.data.count = 0;
    }
    if (typeof eventStatistics.data.totalTickets !== "number") {
      eventStatistics.data.totalTickets = 0;
    }

    const guestCount = event.guestList?.length || 0;

    if (increment) {
      // Increment statistics
      eventStatistics.data.totalTickets += guestCount;
      eventStatistics.data.count += 1;
      console.log(
        `Event statistics incremented for event "${event.title}" (${guestCount} tickets, new count: ${eventStatistics.data.count})`
      );
    } else {
      eventStatistics.data.totalTickets -= guestCount;
      eventStatistics.data.count -= 1;
      console.log(
        `Event statistics decremented for event "${event.title}" (${guestCount} tickets, new count: ${eventStatistics.data.count})`
      );
    }

    // Mark the data field as modified to ensure Mongoose saves it
    eventStatistics.markModified("data");

    const saved = await eventStatistics.save();
    console.log("Statistics saved successfully:", {
      count: saved.data.count,
      totalTickets: saved.data.totalTickets,
    });
  } catch (error) {
    console.error("Error updating event statistics:", error);
    throw error; // Re-throw to see the full error
  }
};

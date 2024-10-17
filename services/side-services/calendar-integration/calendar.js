import { calendar } from "./auth.js";
import dotenv from "dotenv";

dotenv.config();

const calendarId = process.env.CALENDAR_ID;

export async function fetchExistingEvents() {
  const now = new Date();
  const yesterday = new Date(now.setDate(now.getDate() - 1));
  // const yesterday = new Date(now);
  // yesterday.setDate(now.getDate() - 1);
  // const timeMin = yesterday.toISOString();

  try {
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: yesterday.toISOString(), // fetching events from yesterday onwards
      singleEvents: true,
      orderBy: "startTime",
    });
    return response.data.items;
  } catch (error) {
    console.error(
      "Error fetching existing events from Google Calendar:",
      error
    );
    return [];
  }
}

export async function insertOrUpdateEvent(eventData) {
  const startDate = new Date(eventData.date);
  if (isNaN(startDate.getTime())) {
    console.error("Invalid event date:", eventData.date);
    return;
  }

  const event = {
    summary: eventData.title || "No Title",
    location: eventData.location || "",
    description: eventData.region || "",
    start: { dateTime: startDate.toISOString(), timeZone: "Europe/Amsterdam" },
    end: {
      dateTime: new Date(
        startDate.getTime() + 2 * 60 * 60 * 1000
      ).toISOString(),
      timeZone: "Europe/Amsterdam",
    },
  };

  try {
    const existingEvents = await fetchExistingEvents();
    const existingEvent = existingEvents.find(
      (e) =>
        e.summary === eventData.title &&
        new Date(e.start.dateTime).getTime() === startDate.getTime()
    );

    if (existingEvent) {
      await calendar.events.update({
        calendarId: calendarId,
        eventId: existingEvent.id,
        resource: event,
      });
      console.log("Event updated:", existingEvent.htmlLink);
    } else {
      const response = await calendar.events.insert({
        calendarId: calendarId,
        resource: event,
      });
      console.log("Event created:", response.data.htmlLink);
    }
  } catch (error) {
    console.error(
      "Error inserting or updating event:",
      error.response ? error.response.data : error
    );
  }
}

export async function deleteEvent(eventId) {
  try {
    await calendar.events.delete({ calendarId: calendarId, eventId });
    console.log(`Event deleted from Google Calendar: ${eventId}`);
  } catch (error) {
    console.error(
      `Error deleting event ${eventId}:`,
      error.response ? error.response.data : error
    );
  }
}

export async function deletePastEvents() {
  const now = new Date().toISOString(); // Current time in ISO format

  try {
    // Fetch all events from the calendar
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: "1970-01-01T00:00:00Z", // Fetch events from the beginning of time
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = response.data.items;

    // Filter events that have already ended
    const pastEvents = events.filter((event) => {
      const eventEnd = new Date(event.end.dateTime || event.end.date).getTime();
      return eventEnd < new Date().getTime();
    });

    // Delete each past event
    for (const event of pastEvents) {
      try {
        await deleteEvent(event.id); // Reuse the existing deleteEvent function
        console.log(`Deleted past event: ${event.summary}`);
      } catch (error) {
        console.error(
          `Error deleting past event ${event.id}:`,
          error.response ? error.response.data : error
        );
      }
    }

    console.log(`Successfully deleted ${pastEvents.length} past events.`);
  } catch (error) {
    console.error("Error fetching events for deletion:", error);
  }
}

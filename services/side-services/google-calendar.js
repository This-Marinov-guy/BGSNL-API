import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

const calendarId = process.env.CALENDAR_ID;

const getCalendarClient = async () => {
  const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_ADMIN_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials: credentials,
    scopes: "https://www.googleapis.com/auth/calendar",
  });

  const googleClient = await auth.getClient();
  return google.calendar({ version: "v3", auth: googleClient });
};

export const addEventToGoogleCalendar = async (eventData) => {
  if (eventData.hidden) {
    console.log("Event is hidden, not adding to Google Calendar");
    return;
  }

  const calendar = await getCalendarClient();

  const event = {
    summary: eventData.title,
    location: eventData.location,
    description: eventData.description,
    start: {
      dateTime: new Date(eventData.date).toISOString(),
      timeZone: "Europe/Amsterdam",
    },
    end: {
      dateTime: new Date(eventData.date).toISOString(),
      timeZone: "Europe/Amsterdam",
    },
  };

  try {
    const response = await calendar.events.insert({
      calendarId: calendarId,
      resource: event,
    });
    console.log("Event created:", response.data.htmlLink);

    eventData.googleEventId = response.data.id;
    await eventData.save();

    return response.data;
  } catch (error) {
    console.error("Error creating event:", error.response ? error.response.data : error);
    throw new Error("Failed to create event in Google Calendar");
  }
};

export const insertOrUpdateEvent = async (eventData) => {
  if (eventData.hidden) {
    console.log("Event is hidden, not updating in Google Calendar");
    return;
  }

  const calendar = await getCalendarClient();

  const event = {
    summary: eventData.title,
    location: eventData.location,
    description: eventData.description,
    start: {
      dateTime: new Date(eventData.date).toISOString(),
      timeZone: "Europe/Amsterdam",
    },
    end: {
      dateTime: new Date(eventData.date).toISOString(),
      timeZone: "Europe/Amsterdam",
    },
  };

  try {
    const response = await calendar.events.update({
      calendarId: calendarId,
      eventId: eventData.googleEventId,
      resource: event,
    });
    console.log("Event updated:", response.data.htmlLink);
    return response.data;
  } catch (error) {
    console.error("Error updating event:", error.response ? error.response.data : error);
    throw new Error("Failed to update event in Google Calendar");
  }
};

export const deleteCalendarEvent = async (googleEventId) => {
  const calendar = await getCalendarClient();

  try {
    await calendar.events.delete({
      calendarId: calendarId,
      eventId: googleEventId,
    });
    console.log("Event deleted:", googleEventId);
  } catch (error) {
    console.error("Error deleting event:", error.response ? error.response.data : error);
    throw new Error("Failed to delete event in Google Calendar");
  }
};
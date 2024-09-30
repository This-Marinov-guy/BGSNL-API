import { calendar } from './auth.js';
import dotenv from 'dotenv';

dotenv.config();

const calendarId = process.env.CALENDAR_ID;

export async function fetchExistingEvents() {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const timeMin = yesterday.toISOString();
  
  try {
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: timeMin,  // fetching only future events, starting from yesterday
      singleEvents: true,
      orderBy: 'startTime',
    });
    return response.data.items;
  } catch (error) {
    console.error('Error fetching existing events from Google Calendar:', error);
    return [];
  }
}

export async function insertOrUpdateEvent(eventData) {
  const startDate = new Date(eventData.date);
  if (isNaN(startDate.getTime())) {
    console.error('Invalid event date:', eventData.date);
    return;
  }

  const event = {
    summary: eventData.title || 'No Title',
    location: eventData.location || '',
    description: eventData.description || '',
    start: { dateTime: startDate.toISOString(), timeZone: 'Europe/Amsterdam' },
    end: { dateTime: new Date(startDate.getTime() + 2 * 60 * 60 * 1000).toISOString(), timeZone: 'Europe/Amsterdam' },
  };

  try {
    const existingEvents = await fetchExistingEvents();
    const existingEvent = existingEvents.find(e => e.summary === eventData.title && new Date(e.start.dateTime).getTime() === startDate.getTime());

    if (existingEvent) {
      await calendar.events.update({
        calendarId: calendarId,
        eventId: existingEvent.id,
        resource: event,
      });
      console.log('Event updated:', existingEvent.htmlLink);
    } else {
      const response = await calendar.events.insert({ calendarId: calendarId, resource: event });
      console.log('Event created:', response.data.htmlLink);
    }
  } catch (error) {
    console.error('Error inserting or updating event:', error.response ? error.response.data : error);
  }
}

export async function deleteEvent(eventId) {
  try {
    await calendar.events.delete({ calendarId: calendarId, eventId });
    console.log(`Event deleted from Google Calendar: ${eventId}`);
  } catch (error) {
    console.error(`Error deleting event ${eventId}:`, error.response ? error.response.data : error);
  }
}

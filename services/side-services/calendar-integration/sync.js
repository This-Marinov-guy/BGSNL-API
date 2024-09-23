import { fetchExistingEvents, insertOrUpdateEvent, deleteEvent } from './calendar.js';
import { fetchEventsFromDB } from './mongodb.js';

export async function syncEvents() {
  try {
    const googleEvents = await fetchExistingEvents();
    const mongoEvents = await fetchEventsFromDB();

    const googleEventsMap = {};
    googleEvents.forEach(event => {
      const key = `${event.summary}-${new Date(event.start.dateTime).getTime()}`;
      googleEventsMap[key] = event;
    });

    const mongoEventsMap = {};
    mongoEvents.forEach(event => {
      const startDate = new Date(event.date).getTime();
      const key = `${event.title}-${startDate}`;
      mongoEventsMap[key] = event;
    });

    // Update or delete events in Google Calendar based on MongoDB
    for (const [key, googleEvent] of Object.entries(googleEventsMap)) {
      if (mongoEventsMap[key]) {
        const mongoEvent = mongoEventsMap[key];
        await insertOrUpdateEvent(mongoEvent);
        delete mongoEventsMap[key];
      } else {
        await deleteEvent(googleEvent.id);
      }
    }

    // Insert remaining MongoDB events that don't exist in Google Calendar
    for (const [key, mongoEvent] of Object.entries(mongoEventsMap)) {
      await insertOrUpdateEvent(mongoEvent);
    }

  } catch (error) {
    console.error('Error syncing events:', error);
  }
}

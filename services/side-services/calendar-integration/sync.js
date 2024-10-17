import Event from '../../../models/Event.js';
import { fetchExistingEvents, insertOrUpdateEvent, deleteEvent, deletePastEvents } from './calendar.js';

export async function syncEvents() {
  try {
    await deletePastEvents(); 

    const googleEvents = await fetchExistingEvents();
    const mongoEvents = await Event.find({ hidden: false }).exec();

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

    for (const [key, googleEvent] of Object.entries(googleEventsMap)) {
      if (mongoEventsMap[key]) {
        const mongoEvent = mongoEventsMap[key];
        await insertOrUpdateEvent(mongoEvent);
        delete mongoEventsMap[key];
      } else {
        await deleteEvent(googleEvent.id);
      }
    }

    for (const [key, mongoEvent] of Object.entries(mongoEventsMap)) {
      await insertOrUpdateEvent(mongoEvent);
    }

  } catch (error) {
    console.error('Error syncing events:', error);
  }
}

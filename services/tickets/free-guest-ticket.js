import mongoose from "mongoose";
import Event from "../../models/Event.js";
import MemberUser from "../../models/MemberUser.js";
import AlumniUser from "../../models/AlumniUser.js";
import HttpError from "../../models/Http-error.js";

export const isFreeGuestTicket = (guest) => {
  const transactionId = String(guest?.transactionId || "").trim();
  const type = String(guest?.type || "").trim().toLowerCase();
  return transactionId.startsWith("free_") ||
    ((!transactionId || transactionId === "-") && type.startsWith("free "));
};

export function createFreeGuestTicketDeletion({
  EventModel = Event,
  MemberModel = MemberUser,
  AlumniModel = AlumniUser,
  transaction = work => mongoose.connection.transaction(work),
} = {}) {
  return async (eventId, guestId, canManageEvent) => {
    let deletedGuest;
    await transaction(async session => {
      const event = await EventModel.findById(eventId).select("region guestList").session(session);
      if (!event) throw new HttpError("Event not found", 404);
      if (!canManageEvent(event)) throw new HttpError("No access to this event guest list", 403);

      const guest = event.guestList.id(guestId);
      if (!guest) throw new HttpError("Ticket not found. Refresh the guest list and try again.", 404);
      if (!isFreeGuestTicket(guest)) throw new HttpError("Only free tickets can be deleted. Refund a paid ticket instead.", 422);

      const result = await EventModel.updateOne(
        { _id: eventId, "guestList._id": guest._id },
        { $pull: { guestList: { _id: guest._id } } },
        { session }
      );
      if (result.modifiedCount !== 1) throw new HttpError("This ticket changed. Refresh the guest list and try again.", 409);

      const isAccountTicket = Boolean(guest.userId) || /member|alumni/.test(String(guest.type || "").toLowerCase());
      const hasOtherCopy = event.guestList.some(entry => String(entry._id) !== String(guest._id) && entry.ticket === guest.ticket);
      if (isAccountTicket && guest.ticket && !hasOtherCopy) {
        const accountMatch = guest.userId
          ? { $or: [{ _id: guest.userId }, { email: guest.email }] }
          : { email: guest.email };
        const update = { $pull: { tickets: { image: guest.ticket } } };
        await MemberModel.updateMany(accountMatch, update, { session });
        await AlumniModel.updateMany(accountMatch, update, { session });
      }
      deletedGuest = { id: String(guest._id), name: guest.name };
    });
    return deletedGuest;
  };
}

export const deleteFreeGuestTicket = createFreeGuestTicketDeletion();

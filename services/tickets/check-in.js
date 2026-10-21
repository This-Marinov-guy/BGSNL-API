const normalizedEmail = email => typeof email === "string" ? email.trim().toLowerCase() : "";

// The issued code identifies the scanned purchase. Once found, other active
// tickets for that email at this event join its quantity choice.
export function planCheckIn(guests, code, count, { preview = false } = {}) {
  const matches = guests.filter(guest => guest.code != null && String(guest.code) === String(code));
  if (!matches.length) return { outcome: "not_found", statusCode: 404 };
  const scannedTickets = matches.filter(guest => !guest.refunded);
  if (!scannedTickets.length) return { outcome: "refunded", statusCode: 422 };
  const email = normalizedEmail(scannedTickets[0].email);
  const valid = [...scannedTickets, ...guests.filter(guest => !guest.refunded &&
    guest.code != null && String(guest.code) !== String(code) &&
    email && normalizedEmail(guest.email) === email)];
  const remaining = valid.filter(guest => Number(guest.status) !== 1);
  const details = { name: scannedTickets[0].name, total: valid.length,
    remaining: remaining.length, groupIds: valid.map(guest => guest._id) };
  if (!remaining.length) return { ...details, outcome: "already_present", status: 0 };
  if (count == null && valid.length > 1) return { ...details, outcome: "choose_quantity", status: 2 };
  if (preview) return { ...details, outcome: "confirm_required", status: 2 };
  const quantity = count == null ? 1 : Number(count);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > remaining.length) {
    return { ...details, outcome: "invalid_quantity", statusCode: 422 };
  }
  return { ...details, outcome: "present", status: 1, ids: remaining.slice(0, quantity).map(guest => guest._id), admitted: quantity };
}

// An all-or-nothing compare-and-set: simultaneous scanners cannot admit the
// same seat twice, and a concurrent refund invalidates the whole selection.
export function checkInMutation(event, plan, now = new Date()) {
  return {
    filter: { _id: event._id, region: event.region, cancellationRequestedAt: null, $and: plan.ids.map(id => ({
      guestList: { $elemMatch: { _id: id, status: { $ne: 1 }, refunded: { $ne: true } } },
    })) },
    update: { $set: { "guestList.$[guest].status": 1, "guestList.$[guest].checkedInAt": now } },
    options: { arrayFilters: [{ "guest._id": { $in: plan.ids } }], runValidators: true },
  };
}

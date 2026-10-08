import assert from "node:assert/strict";
import test from "node:test";
import Event from "../models/Event.js";

test("event tickets accept string add-on IDs and existing numeric IDs", async () => {
  const event = new Event({
    region: "groningen", title: "Test", date: new Date("2099-10-20"),
    location: "Groningen", ticketTimer: new Date("2099-10-19"),
    ticketLimit: 50, text: "Test", ticketImg: "ticket.png", poster: "poster.png",
    folder: "test", sheetName: "test",
    guestList: [
      { name: "New", email: "new@example.test", phone: "0", addOns: [{ id: "6ac7f2d2907e891ffc4a543a", title: "Meal", price: 3 }] },
      { name: "Legacy", email: "legacy@example.test", phone: "0", addOns: [{ id: 0, title: "Drink", price: 2 }] },
    ],
  });

  await event.validate();
  assert.equal(event.guestList[0].addOns[0].id, "6ac7f2d2907e891ffc4a543a");
  assert.equal(event.guestList[1].addOns[0].id, "0");
});

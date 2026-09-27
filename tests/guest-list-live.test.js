import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { streamGuestList } from "../services/tickets/guest-list-live.js";

function response() {
  const res = new EventEmitter();
  res.frames = [];
  res.set = headers => { res.headers = headers; };
  res.flushHeaders = () => {};
  res.write = frame => { res.frames.push(frame); return true; };
  res.end = () => { res.writableEnded = true; res.emit("close"); };
  return res;
}
test("stream sends only invalidations and cleans up on disconnect", async () => {
  const res = response(); let notify, removed = 0;
  await streamGuestList({}, res, "event-a", async (id, callback) => {
    assert.equal(id, "event-a"); notify = callback; return () => { removed++; };
  });
  assert.match(res.headers["Cache-Control"], /no-transform/);
  assert.match(res.frames[0], /event: ready/);
  notify(true); assert.equal(res.frames[1], 'event: changed\ndata: {}\n\n');
  notify(false); assert.equal(res.writableEnded, true); assert.equal(removed, 1);
  assert.equal(res.listenerCount("close"), 0);
});
test("disconnect during subscription does not leak its listener", async () => {
  const res = response(); let removed = 0;
  await streamGuestList({}, res, "event-a", async () => {
    res.emit("close"); return () => { removed++; };
  });
  assert.equal(removed, 1); assert.deepEqual(res.frames, []);
});
test("unavailable broker fails before streaming headers", async () => {
  const res = response();
  await assert.rejects(streamGuestList({}, res, "event-a", async () => { throw new Error("offline"); }), /offline/);
  assert.equal(res.headers, undefined); assert.equal(res.listenerCount("close"), 0);
});

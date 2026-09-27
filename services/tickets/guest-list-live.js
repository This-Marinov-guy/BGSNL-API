import { redisClient, redisPrefix } from "../storage/redis.js";
import { logOperationalError } from "../../middleware/axiom-logger.js";

// One Redis subscriber per API process; browsers only receive invalidations.
const listeners = new Map();
let connecting;
const channel = () => `${redisPrefix()}guest-list-changed`;
async function ensureSubscriber() {
  if (!connecting) connecting = (async () => {
    const subscriber = (await redisClient()).duplicate();
    const disconnect = () => {
      for (const callbacks of listeners.values()) for (const callback of [...callbacks]) callback(false);
    };
    subscriber.on("error", (error) => { logOperationalError("service.guest-list-subscription", error); disconnect(); });
    subscriber.on("reconnecting", disconnect);
    subscriber.on("end", () => { connecting = undefined; disconnect(); });
    try {
      await subscriber.connect();
      await subscriber.subscribe(channel(), eventId => {
        for (const callback of listeners.get(eventId) || []) callback(true);
      });
      return subscriber;
    } catch (error) {
      if (subscriber.isOpen) subscriber.destroy();
      throw error;
    }
  })().catch(error => { connecting = undefined; throw error; });
  const subscriber = await connecting;
  if (!subscriber.isReady) throw new Error("Live guest lists unavailable");
}

export async function subscribeGuestList(eventId, callback) {
  await ensureSubscriber();
  const key = String(eventId);
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(callback);
  return () => {
    const callbacks = listeners.get(key);
    callbacks?.delete(callback);
    if (!callbacks?.size) listeners.delete(key);
  };
}

export async function publishGuestListChanged(eventId) {
  try { await (await redisClient()).publish(channel(), String(eventId)); }
  catch (error) { logOperationalError("service.guest-list-publish", error); console.warn("Guest list live notification unavailable; clients will reconcile on refresh"); }
}

export async function streamGuestList(req, res, eventId, subscribe = subscribeGuestList) {
  let closed = false, ready = false, unsubscribe, heartbeat, lifetime;
  const close = () => {
    closed = true;
    clearInterval(heartbeat); clearTimeout(lifetime);
    unsubscribe?.();
    res.off("close", close);
    if (!res.writableEnded) res.end();
  };
  res.on("close", close);
  try {
    unsubscribe = await subscribe(eventId, connected => {
      if (!connected) close();
      else if (ready && !closed && !res.write('event: changed\ndata: {}\n\n')) close();
    });
    if (closed || res.destroyed) { close(); return; }
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "private, no-store, no-transform", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    ready = true;
    res.write('retry: 3000\nevent: ready\ndata: {}\n\n');
    heartbeat = setInterval(() => { if (!res.write(": heartbeat\n\n")) close(); }, 15000);
    // Reconnect rechecks account/region permissions and reconciles missed events.
    lifetime = setTimeout(close, 45000);
  } catch (error) {
    res.off("close", close);
    unsubscribe?.();
    if (!closed) throw error;
  }
}

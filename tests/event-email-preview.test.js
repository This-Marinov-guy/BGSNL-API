import test from "node:test";
import assert from "node:assert/strict";
import { formatEventEmailDate, renderEventEmailPreview } from "../services/events/event-email-preview.js";

test("event email preview uses the ticket card layout without a ticket", () => {
  const date = formatEventEmailDate({ date: new Date("2026-10-17T17:00:00Z") });
  const html = renderEventEmailPreview({ title: "Autumn & <Social>", date,
    poster: "https://example.org/poster.jpg?x=1&y=2" });
  assert.match(html, /class="bgsnl-event-preview"/);
  assert.ok(html.indexOf("Autumn &amp; &lt;Social&gt;") < html.indexOf("poster.jpg"));
  assert.match(html, /17\.10 \| 19:00/);
  assert.match(html, /border-radius:12px/);
  assert.doesNotMatch(html, /border-green/);
  assert.match(html, /class="bgsnl-event-details" align="center" valign="middle" height="220"/);
  assert.match(html, /vertical-align:middle;text-align:center/);
  assert.match(html, /class="bgsnl-event-poster" width="32%" height="220"/);
  assert.match(html, /width="148"[^>]*max-width:148px;height:auto;max-height:208px;object-fit:contain/);
  assert.doesNotMatch(html, /bgsnl-event-tickets|Event ticket/);
  assert.match(html, /poster\.jpg\?x=1&amp;y=2/);
  assert.doesNotMatch(renderEventEmailPreview({ title: "Event", date, poster: "javascript:alert(1)" }), /<img /);
  assert.match(renderEventEmailPreview({ title: "Event", date, region: "groningen" }), />Groningen<\/span>/);
});

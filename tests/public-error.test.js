import test from "node:test";
import assert from "node:assert/strict";
import HttpError from "../models/Http-error.js";
import { diagnosticError, publicError } from "../util/http/public-error.js";

test("system failures never expose internal messages or data", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const error = new HttpError("Database URI and token=secret", status);
    error.data = { connection: "private" };
    const response = publicError(error);
    assert.equal(response.status, status);
    assert.doesNotMatch(JSON.stringify(response.body), /Database|secret|private/);
    assert.deepEqual(Object.keys(response.body), ["message"]);
  }
});

test("unknown routes and missing items have general messages", () => {
  const route = new HttpError("/api/internal/secret", 404);
  route.endpointNotFound = true;
  assert.equal(publicError(route).body.message, "This request could not be completed.");
  assert.equal(publicError(new HttpError("Member with email private@example.org not found", 404)).body.message,
    "The requested item could not be found.");
});

test("access and expected validation feedback remain available", () => {
  assert.equal(publicError(new HttpError("You do not have access to this page", 403)).body.message,
    "You do not have access to this page");
  assert.equal(publicError(new HttpError("Choose a region", 422)).body.message, "Choose a region");
  assert.doesNotMatch(publicError(new HttpError("Invalid token=private@example.org", 422)).body.message, /private@example/);
  assert.doesNotMatch(publicError(Object.assign(new Error("provider secret"), { statusCode: 422 })).body.message, /secret/);
});

test("Axiom diagnostics retain useful messages while redacting obvious identifiers", () => {
  assert.equal(diagnosticError(new Error("Unable to connect to mongodb://private.example" )).message,
    "Unable to connect to <redacted>");
  assert.equal(diagnosticError(new HttpError("Contact private@example.org at https://private.test", 503)).message,
    "Contact <redacted> at <redacted>");
  assert.doesNotMatch(diagnosticError(new HttpError("Call +31 6 12345678 with token=private", 503)).message, /12345678|private/);
});

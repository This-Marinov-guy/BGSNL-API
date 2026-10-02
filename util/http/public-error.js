import HttpError from "../../models/Http-error.js";

export const errorStatus = (error) => {
  const status = Number(error?.statusCode || error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
};

export const isSystemError = (status, endpointNotFound = false) =>
  endpointNotFound || status === 408 || status === 429 || status >= 500;

export const publicError = (error) => {
  const status = errorStatus(error);
  if (error?.endpointNotFound) return { status, body: { message: "This request could not be completed." } };
  if (status === 429) return { status, body: { message: "Please wait a moment and try again." } };
  if (status === 408 || status >= 500) return { status, body: { message: "We could not complete your request. Please try again." } };
  if (status === 404) return { status, body: { message: "The requested item could not be found." } };
  // Access decisions and expected validation/conflict feedback remain useful.
  // Never forward messages from arbitrary provider/parser errors.
  if (error instanceof HttpError && typeof error.message === "string" && error.message.length <= 300 &&
      !/[\r\n]|https?:\/\/|\S+@\S+|bearer\s|token\s*[:=]|(?:mongodb|postgres):\/\//i.test(error.message)) {
    return { status, body: { message: error.message } };
  }
  return { status, body: { message: "We could not complete your request. Please check your input and try again." } };
};

// Keep useful diagnostics in Axiom without logging arbitrary provider messages,
// which can contain credentials, personal data or submitted content.
export const diagnosticError = (error) => ({
  ...(error instanceof Error && typeof error.message === "string"
    ? { message: error.message
      .replace(/\S+@\S+|(?:https?|mongodb(?:\+srv)?|postgres(?:ql)?):\/\/\S+|\b[a-f0-9]{24,}\b|\+?\d[\d\s().-]{6,}\d/gi, "<redacted>")
      .replace(/\b(password|secret|token|key|credential)\s*[:=]\s*\S+/gi, "$1=<redacted>")
      .replace(/(["'`])[^"'`]{1,160}\1/g, "<redacted>")
      .slice(0, 160) }
    : {}),
  ...(error?.endpointNotFound ? { code: "ENDPOINT_NOT_FOUND" } : {}),
});

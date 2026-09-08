// Express 4 does not forward rejected async handlers automatically.
export const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve().then(() => handler(req, res, next)).catch(next);

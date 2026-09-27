// Only identity verified by the authentication middleware is trusted.
// Decoding a JWT payload is not signature verification.
export const extractUserFromRequest = (req) => req.user || {};
export const getTokenFromHeader = (req) => req.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1] || null;

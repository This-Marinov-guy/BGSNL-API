import {
  DEFAULT_API_VERSION,
  ENABLED_API_VERSIONS,
  getApiRoutePath,
} from "../util/config/api-versions.js";

const API_PREFIX_PATTERN = /^\/api(?=\/|\?|$)/i;
const VERSIONED_API_PREFIX_PATTERN = /^\/api\/(v[1-9]\d*)(?=\/|\?|$)/i;

export const API_VERSION_HEADER = "X-API-Version";

export const apiVersionMiddleware = (req, res, next) => {
  if (!API_PREFIX_PATTERN.test(req.url)) {
    return next();
  }

  const versionMatch = req.url.match(VERSIONED_API_PREFIX_PATTERN);
  const requestedVersion = versionMatch?.[1]?.toLowerCase();
  const resolvedVersion = requestedVersion || DEFAULT_API_VERSION;

  req.apiVersion = resolvedVersion;
  res.setHeader(API_VERSION_HEADER, resolvedVersion);

  if (!requestedVersion) {
    req.url = `${getApiRoutePath()}${req.url.slice("/api".length)}`;
  }

  return next();
};

export const requireEnabledApiVersion = (req, res, next) => {
  if (!req.apiVersion || ENABLED_API_VERSIONS.includes(req.apiVersion)) {
    return next();
  }

  return res.status(404).json({
    message: `API version ${req.apiVersion} is not available.`,
    defaultVersion: DEFAULT_API_VERSION,
    supportedVersions: ENABLED_API_VERSIONS,
  });
};

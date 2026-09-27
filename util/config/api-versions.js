export const API_VERSIONS = Object.freeze({
  V1: "v1",
  V2: "v2",
  V3: "v3",
});

export const DEFAULT_API_VERSION = API_VERSIONS.V1;

// Add a version here only after its routers have been mounted in app.js.
export const ENABLED_API_VERSIONS = Object.freeze([API_VERSIONS.V1]);

export const getApiRoutePath = (
  routePath = "",
  version = DEFAULT_API_VERSION
) => {
  const normalizedRoutePath = routePath
    ? `/${String(routePath).replace(/^\/+/, "")}`
    : "";

  return `/api/${version}${normalizedRoutePath}`;
};

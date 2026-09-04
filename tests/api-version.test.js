import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import {
  API_VERSION_HEADER,
  apiVersionMiddleware,
  requireEnabledApiVersion,
} from "../middleware/api-version.js";
import {
  API_VERSIONS,
  DEFAULT_API_VERSION,
  ENABLED_API_VERSIONS,
  getApiRoutePath,
} from "../util/config/api-versions.js";

const runMiddleware = (url) => {
  const req = { url };
  const responseState = {
    body: null,
    headers: {},
    statusCode: 200,
  };
  let nextCalled = false;
  const res = {
    json(body) {
      responseState.body = body;
      return this;
    },
    setHeader(name, value) {
      responseState.headers[name] = value;
    },
    status(statusCode) {
      responseState.statusCode = statusCode;
      return this;
    },
  };

  apiVersionMiddleware(req, res, () => {
    nextCalled = true;
  });

  return { nextCalled, req, responseState };
};

const requestJson = (server, path) =>
  new Promise((resolve, reject) => {
    const address = server.address();
    const request = http.get(
      { host: "127.0.0.1", path, port: address.port },
      (response) => {
        let responseBody = "";

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          resolve({
            body: JSON.parse(responseBody),
            headers: response.headers,
            statusCode: response.statusCode,
          });
        });
      }
    );

    request.on("error", reject);
  });

test("builds explicit API paths for current and future versions", () => {
  assert.equal(getApiRoutePath("/user"), "/api/v1/user");
  assert.equal(getApiRoutePath("future-event", API_VERSIONS.V2), "/api/v2/future-event");
  assert.equal(getApiRoutePath("/common", API_VERSIONS.V3), "/api/v3/common");
});

test("defaults an unversioned API URL to v1 and preserves its query", () => {
  const result = runMiddleware("/api/common/get-about-data?region=groningen");

  assert.equal(result.nextCalled, true);
  assert.equal(result.req.url, "/api/v1/common/get-about-data?region=groningen");
  assert.equal(result.req.apiVersion, DEFAULT_API_VERSION);
  assert.equal(
    result.responseState.headers[API_VERSION_HEADER],
    DEFAULT_API_VERSION
  );
});

test("keeps an explicit v1 API URL unchanged", () => {
  const result = runMiddleware("/api/v1/user/current");

  assert.equal(result.nextCalled, true);
  assert.equal(result.req.url, "/api/v1/user/current");
  assert.equal(result.req.apiVersion, API_VERSIONS.V1);
});

test("does not rewrite non-API URLs", () => {
  const result = runMiddleware("/health");

  assert.equal(result.nextCalled, true);
  assert.equal(result.req.url, "/health");
  assert.equal(result.req.apiVersion, undefined);
});

test("rejects an explicit API version until it is enabled", () => {
  const result = runMiddleware("/api/v2/common/get-about-data");

  assert.equal(result.nextCalled, true);

  let nextCalled = false;
  requireEnabledApiVersion(result.req, {
    json(body) {
      result.responseState.body = body;
      return this;
    },
    status(statusCode) {
      result.responseState.statusCode = statusCode;
      return this;
    },
  }, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(result.responseState.statusCode, 404);
  assert.deepEqual(
    result.responseState.body.supportedVersions,
    ENABLED_API_VERSIONS
  );
  assert.equal(result.responseState.body.defaultVersion, API_VERSIONS.V1);
});

test("serves explicit v1 and unversioned paths through the same router", async (t) => {
  const app = express();
  const router = express.Router();

  app.use(apiVersionMiddleware);
  app.use(requireEnabledApiVersion);
  router.get("/ping", (req, res) => {
    res.json({ version: req.apiVersion });
  });
  app.use(getApiRoutePath("/common"), router);

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  const [legacyResponse, versionedResponse] = await Promise.all([
    requestJson(server, "/api/common/ping"),
    requestJson(server, "/api/v1/common/ping"),
  ]);

  assert.equal(legacyResponse.statusCode, 200);
  assert.equal(versionedResponse.statusCode, 200);
  assert.deepEqual(legacyResponse.body, { version: API_VERSIONS.V1 });
  assert.deepEqual(versionedResponse.body, { version: API_VERSIONS.V1 });
  assert.equal(legacyResponse.headers["x-api-version"], API_VERSIONS.V1);
  assert.equal(versionedResponse.headers["x-api-version"], API_VERSIONS.V1);
});

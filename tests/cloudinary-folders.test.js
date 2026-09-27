import test from "node:test";
import assert from "node:assert/strict";
import { cloudinaryFolder, cloudinaryUploadOptions } from "../util/functions/cloudinary-folders.js";

const dev = { APP_ENV: "dev", NODE_ENV: "production" };
const prod = { APP_ENV: "prod", NODE_ENV: "production" };

test("development uploads keep their subfolders under development", () => {
  for (const folder of ["support/conversation", "Amsterdam_event", "drafts/event", "spare"]) {
    assert.equal(cloudinaryUploadOptions({ folder }, dev).folder, `development/${folder}`);
  }
  assert.equal(cloudinaryUploadOptions({}, dev).folder, "development");
});

test("existing development folders are not prefixed twice", () => {
  for (const folder of ["development", "development/drafts/event", "development/support/conversation"]) {
    assert.equal(cloudinaryFolder(folder, dev), folder);
  }
  assert.equal(cloudinaryFolder("development-other", dev), "development/development-other");
  assert.equal(cloudinaryFolder("/support/conversation/", dev), "development/support/conversation");
});

test("production upload options and folder paths stay unchanged", () => {
  const options = { folder: "events/one", public_id: "poster", asset_folder: "media", public_id_prefix: "events", overwrite: false };
  assert.deepEqual(cloudinaryUploadOptions(options, prod), options);
  assert.deepEqual(cloudinaryUploadOptions({}, prod), { overwrite: true });
  assert.equal(cloudinaryFolder("events/one", prod), "events/one");
});

test("APP_ENV takes precedence, with NODE_ENV as fallback", () => {
  assert.equal(cloudinaryFolder("events", dev), "development/events");
  assert.equal(cloudinaryFolder("events", { APP_ENV: "prod", NODE_ENV: "development" }), "events");
  assert.equal(cloudinaryFolder("events", { NODE_ENV: "production" }), "events");
  assert.equal(cloudinaryFolder("events", { NODE_ENV: "development" }), "development/events");
  assert.equal(cloudinaryFolder("events", {}), "development/events");
});

test("dynamic-folder overrides are also scoped without mutating callers", () => {
  const options = { folder: "events", asset_folder: "library/events", public_id_prefix: "events", public_id: "poster", format: "webp", overwrite: false };
  const original = { ...options };
  assert.deepEqual(cloudinaryUploadOptions(options, dev), { ...options, folder: "development/events", asset_folder: "development/library/events", public_id_prefix: "development/events" });
  assert.deepEqual(options, original);
});

test("development folder paths cannot escape the development namespace", () => {
  for (const folder of ["../events", "development/../events", "events/./one"]) {
    assert.throws(() => cloudinaryFolder(folder, dev), /Invalid Cloudinary folder/);
  }
});

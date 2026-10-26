import test from "node:test";
import assert from "node:assert/strict";
import { v2 as cloudinary } from "cloudinary";
import { uploadToCloudinary, deleteFolder, deleteArchivedEventPoster } from "../util/functions/cloudinary.js";

test("shared upload and cleanup helpers isolate development assets", async (t) => {
  const originalEnvironment = process.env.APP_ENV;
  t.after(() => {
    if (originalEnvironment === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalEnvironment;
  });
  process.env.APP_ENV = "dev";
  const uploads = [];
  const deletedPrefixes = [];
  const deletedFolders = [];
  t.mock.method(cloudinary.uploader, "upload", async (data, options) => {
    uploads.push({ data, options });
    return { secure_url: "https://res.cloudinary.com/test/image/upload/development/image.png" };
  });
  t.mock.method(cloudinary.api, "delete_resources_by_prefix", async (prefix) => { deletedPrefixes.push(prefix); });
  t.mock.method(cloudinary.api, "delete_folder", async (folder) => { deletedFolders.push(folder); });
  t.mock.method(cloudinary.api, "resources_by_asset_folder", async () => { throw { http_code: 404 }; });
  t.mock.method(console, "log", () => {});
  const file = { buffer: Buffer.from("test image"), mimetype: "image/png" };
  const options = { folder: "support/conversation", public_id: "image", format: "webp" };
  const url = await uploadToCloudinary(file, options);
  assert.equal(url, "https://res.cloudinary.com/test/image/upload/development/image.png");
  assert.equal(uploads[0].data, `data:image/png;base64,${file.buffer.toString("base64")}`);
  assert.deepEqual(uploads[0].options, { ...options, overwrite: true, folder: "development/support/conversation" });
  await uploadToCloudinary(file, { folder: "development/drafts/event", public_id: "poster" });
  assert.equal(uploads[1].options.folder, "development/drafts/event");
  await uploadToCloudinary(file);
  assert.equal(uploads[2].options.folder, "development");
  await deleteFolder("copied-production-event");
  assert.deepEqual(deletedPrefixes, ["development/copied-production-event/"]);
  assert.deepEqual(deletedFolders, ["development/copied-production-event"]);
  process.env.APP_ENV = "prod";
  await uploadToCloudinary(file, options);
  assert.deepEqual(uploads[3].options, { overwrite: true, ...options });
});

test("annual cleanup removes a legacy archived poster individually", async (t) => {
  const previousEnvironment = process.env.APP_ENV;
  const previousCloud = process.env.CLOUDINARY_CLOUD_NAME;
  t.after(() => {
    if (previousEnvironment === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previousEnvironment;
    if (previousCloud === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
    else process.env.CLOUDINARY_CLOUD_NAME = previousCloud;
  });
  process.env.APP_ENV = "dev";
  process.env.CLOUDINARY_CLOUD_NAME = "test";
  const deleted = [];
  t.mock.method(cloudinary.uploader, "destroy", async (id, options) => {
    deleted.push({ id, options });
    return { result: "ok" };
  });
  const id = "a".repeat(24);
  await deleteArchivedEventPoster({ _id: id,
    poster: `https://res.cloudinary.com/test/image/upload/v2/development/archived-event-posters/${id}.jpg` });
  await deleteArchivedEventPoster({ _id: id, poster: "https://res.cloudinary.com/test/image/upload/v1/event-folder/poster.jpg" });
  assert.deepEqual(deleted, [{ id: `development/archived-event-posters/${id}`,
    options: { resource_type: "image", invalidate: true } }]);
});

test("folder cleanup follows Cloudinary cursors and rejects unsafe folders", async (t) => {
  const previousEnvironment = process.env.APP_ENV;
  t.after(() => { if (previousEnvironment === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = previousEnvironment; });
  process.env.APP_ENV = "prod";
  const calls = [];
  t.mock.method(cloudinary.api, "resources_by_asset_folder", async () => { throw { http_code: 404 }; });
  t.mock.method(cloudinary.api, "delete_resources_by_prefix", async (_prefix, options) => {
    calls.push(options);
    return options.next_cursor ? { partial: false } : { partial: true, next_cursor: "second-page" };
  });
  const folders = [];
  t.mock.method(cloudinary.api, "delete_folder", async folder => { folders.push(folder); });
  await deleteFolder("region_event");
  assert.deepEqual(calls, [{}, { next_cursor: "second-page" }]);
  assert.deepEqual(folders, ["region_event"]);
  await assert.rejects(deleteFolder("../other"), /Invalid Cloudinary event folder/);
  await assert.rejects(deleteFolder("spare"), /Invalid Cloudinary event folder/);
});

test("folder cleanup accepts Cloudinary's wrapped 404 for a missing folder", async (t) => {
  t.mock.method(cloudinary.api, "resources_by_asset_folder", async () => {
    throw { error: { http_code: 404, message: "Not found" } };
  });
  t.mock.method(cloudinary.api, "delete_resources_by_prefix", async () => ({ partial: false }));
  t.mock.method(cloudinary.api, "delete_folder", async () => {
    throw { error: { http_code: 404, message: "Not found" } };
  });
  await deleteFolder("missing-event-folder");
});

test("dynamic Cloudinary folders are emptied by asset ID before folder removal", async (t) => {
  const previousEnvironment = process.env.APP_ENV;
  t.after(() => { if (previousEnvironment === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = previousEnvironment; });
  process.env.APP_ENV = "prod";
  let listed = 0;
  const calls = [];
  t.mock.method(cloudinary.api, "resources_by_asset_folder", async folder => {
    calls.push(`list:${folder}`);
    return ++listed === 1 ? { resources: [{ asset_id: "asset-one" }, { asset_id: "asset-two" }] } : { resources: [] };
  });
  t.mock.method(cloudinary.api, "delete_resources_by_asset_ids", async ids => { calls.push(`delete:${ids.join(",")}`); });
  t.mock.method(cloudinary.api, "delete_resources_by_prefix", () => assert.fail("Must not use a public ID prefix for dynamic folders"));
  t.mock.method(cloudinary.api, "delete_folder", async folder => { calls.push(`folder:${folder}`); });
  await deleteFolder("event-assets");
  assert.deepEqual(calls, ["list:event-assets", "delete:asset-one,asset-two", "list:event-assets", "folder:event-assets"]);
});

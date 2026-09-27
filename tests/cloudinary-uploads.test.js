import test from "node:test";
import assert from "node:assert/strict";
import { v2 as cloudinary } from "cloudinary";
import { uploadToCloudinary, deleteFolder } from "../util/functions/cloudinary.js";

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

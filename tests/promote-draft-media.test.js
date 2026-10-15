import assert from "node:assert/strict";
import test from "node:test";
import { v2 as cloudinary } from "cloudinary";
import { copyCloudinaryImage } from "../util/functions/cloudinary.js";
import { copyDraftEventMedia, publishedEventFolder } from "../services/events/promote-draft-media.js";

test("publishing copies retained draft media into an event folder and leaves new uploads alone", async () => {
  const id = "507f1f77bcf86cd799439011";
  const folder = publishedEventFolder(id);
  const poster = "https://res.cloudinary.com/test/image/upload/v1/drafts/id/poster.jpg";
  const ticket = "https://res.cloudinary.com/test/image/upload/v1/drafts/id/ticket.jpg";
  const gallery = "https://res.cloudinary.com/test/image/upload/v1/drafts/id/image.jpg";
  const restoredGallery = "https://res.cloudinary.com/test/image/upload/v1/drafts/id/restored.jpg";
  const newImage = `https://res.cloudinary.com/test/image/upload/v2/${folder}/new.jpg`;
  const copied = [];
  const copy = async (source, options) => {
    copied.push({ source, options });
    return `https://res.cloudinary.com/test/image/upload/v3/${folder}/${options.public_id}.jpg`;
  };
  const media = await copyDraftEventMedia(
    { poster, ticketImg: ticket, images: [gallery], folder: "drafts/id" },
    { poster, ticketImg: ticket, images: [gallery, gallery, restoredGallery, newImage] }, folder, { copy }
  );
  assert.equal(copied.length, 4);
  assert.equal(media.poster, `https://res.cloudinary.com/test/image/upload/v3/${folder}/poster.jpg`);
  assert.equal(media.ticketImg, `https://res.cloudinary.com/test/image/upload/v3/${folder}/ticket.jpg`);
  assert.equal(media.images[0], media.images[1]);
  assert.match(media.images[2], new RegExp(`/${folder}/image_`));
  assert.equal(media.images[3], newImage);
  assert.ok(copied.every(({ options }) => options.folder === folder && options.asset_folder === folder));
});

test("Cloudinary draft copying uses the configured cloud and rejects other image hosts", async (t) => {
  const previousCloud = process.env.CLOUDINARY_CLOUD_NAME;
  t.after(() => {
    if (previousCloud === undefined) delete process.env.CLOUDINARY_CLOUD_NAME;
    else process.env.CLOUDINARY_CLOUD_NAME = previousCloud;
  });
  process.env.CLOUDINARY_CLOUD_NAME = "test";
  const uploads = [];
  t.mock.method(cloudinary.uploader, "upload", async (url, options) => {
    uploads.push({ url, options });
    return { secure_url: "https://res.cloudinary.com/test/image/upload/v3/events/id/poster.jpg" };
  });
  const source = "https://res.cloudinary.com/test/image/upload/v1/drafts/id/poster.jpg";
  await copyCloudinaryImage(source, { folder: "events/id", asset_folder: "events/id", public_id_prefix: "events/id", public_id: "poster" });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].url, source);
  await assert.rejects(copyCloudinaryImage("https://example.com/image.jpg", { folder: "events/id" }), /Invalid draft image URL/);
  assert.equal(uploads.length, 1);
});

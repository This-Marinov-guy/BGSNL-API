import { createHash } from "node:crypto";
import { uploadToCloudinary } from "../../util/functions/cloudinary.js";
import { SUPPORT_IMAGE_LIMIT } from "../../middleware/support-image-upload.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeId(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid support upload reference");
  return value.toLowerCase();
}

function stableCloudinaryUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com" || !url.pathname.includes("/image/upload/")) {
    throw new Error("Cloudinary returned an invalid support image URL");
  }
  url.pathname = url.pathname.replace(/\/image\/upload\/v\d+\//, "/image/upload/");
  return url.toString();
}

export async function uploadSupportImages(files = [], { conversationId, messageId, upload = uploadToCloudinary } = {}) {
  if (!Array.isArray(files) || files.length > SUPPORT_IMAGE_LIMIT) throw new Error("Invalid support image upload");
  if (!files.length) return [];
  const conversation = safeId(conversationId);
  const message = safeId(messageId);

  return Promise.all(files.map(async (file, index) => {
    const hash = createHash("sha256").update(file.buffer).digest("hex").slice(0, 20);
    const url = await upload(file, {
      folder: `support/${conversation}`,
      public_id: `${message}-${index + 1}-${hash}`,
      resource_type: "image",
      format: "webp",
      transformation: [{ width: 2000, height: 2000, crop: "limit", quality: "auto" }],
    });
    return { type: "image", url: stableCloudinaryUrl(url) };
  }));
}

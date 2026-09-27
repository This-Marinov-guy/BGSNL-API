import { createHash } from "node:crypto";
import { uploadToCloudinary } from "../../util/functions/cloudinary.js";
import { SUPPORT_IMAGE_LIMIT, SUPPORT_IMAGE_TYPES, SUPPORT_FILE_TYPES } from "../../middleware/support-image-upload.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeId(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid support upload reference");
  return value.toLowerCase();
}

function stableCloudinaryUrl(value, resource = "image") {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com" || !url.pathname.includes(`/${resource}/upload/`)) {
    throw new Error("Cloudinary returned an invalid support image URL");
  }
  url.pathname = url.pathname.replace(new RegExp(`/${resource}/upload/v\\d+/`), `/${resource}/upload/`);
  return url.toString();
}

export async function uploadSupportImages(files = [], { conversationId, messageId, upload = uploadToCloudinary } = {}) {
  if (!Array.isArray(files) || files.length > SUPPORT_IMAGE_LIMIT) throw new Error("Invalid support image upload");
  if (!files.length) return [];
  const conversation = safeId(conversationId);
  const message = safeId(messageId);

  return Promise.all(files.map(async (file, index) => {
    const image = SUPPORT_IMAGE_TYPES.has(file.mimetype);
    if (!image && !SUPPORT_FILE_TYPES.has(file.mimetype)) throw new Error("Unsupported support attachment");
    const hash = createHash("sha256").update(file.buffer).digest("hex").slice(0, 20);
    const extension = image ? "" : file.mimetype === "application/pdf" ? ".pdf" : ".txt";
    const url = await upload(file, {
      folder: `support/${conversation}`,
      public_id: `${message}-${index + 1}-${hash}${extension}`,
      resource_type: image ? "image" : "raw",
      ...(image ? {
      format: "webp",
      transformation: [{ width: 2000, height: 8192, crop: "limit", quality: "auto" }],
      } : {}),
    });
    return { type: image ? "image" : "file", url: stableCloudinaryUrl(url, image ? "image" : "raw"),
      ...(!image ? { name: Array.from(String(file.originalname || `attachment${extension}`)).filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join("").trim().slice(0, 200) || `attachment${extension}` } : {}) };
  }));
}

import multer from "multer";
import { unsupportedUploadError } from "./upload-validation-error.js";

export const SUPPORT_IMAGE_LIMIT = 3;
export const SUPPORT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const SUPPORT_IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

export function supportImageFilter(_req, file, callback) {
  if (SUPPORT_IMAGE_TYPES.has(file?.mimetype)) return callback(null, true);
  return callback(unsupportedUploadError(file, "a JPEG, PNG or WebP image"));
}

const supportImageUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: supportImageFilter,
  limits: { fileSize: SUPPORT_IMAGE_MAX_BYTES, files: SUPPORT_IMAGE_LIMIT },
});

export default supportImageUpload;

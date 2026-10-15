import { v2 as cloudinary } from "cloudinary";
import { logIntegrationError, observeIntegrationRequest } from "../../middleware/axiom-logger.js";
import { cloudinaryFolder, cloudinaryUploadOptions } from "./cloudinary-folders.js";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const uploadToCloudinary = async (file, options = {}) => {
  const b64 = Buffer.from(file.buffer).toString("base64");
  const dataURI = `data:${file.mimetype};base64,${b64}`;

  let response;
  try { response = await observeIntegrationRequest("cloudinary", "upload", "POST", () =>
    cloudinary.uploader.upload(dataURI, cloudinaryUploadOptions(options))); }
  catch (error) { logIntegrationError("cloudinary", error, "upload"); throw error; }

  return response.secure_url;
};

export const copyCloudinaryImage = async (sourceUrl, options = {}) => {
  const source = new URL(sourceUrl);
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (source.protocol !== "https:" || source.hostname !== "res.cloudinary.com" ||
    !cloudName || source.pathname.split("/")[1] !== cloudName ||
    !source.pathname.includes("/image/upload/")) {
    throw new Error("Invalid draft image URL");
  }
  try {
    const response = await observeIntegrationRequest("cloudinary", "copy-draft-image", "POST", () =>
      cloudinary.uploader.upload(source.href, cloudinaryUploadOptions(options)));
    if (!response?.secure_url) throw new Error("Cloudinary did not return an image URL");
    return response.secure_url;
  } catch (error) {
    logIntegrationError("cloudinary", error, "copy-draft-image");
    throw error;
  }
};

export const deleteFolder = async (folderName = "") => {
  const folder = String(folderName || "").replace(/^\/+|\/+$/g, "");
  const reserved = new Set(["development", "spare", "development/spare", "drafts", "development/drafts",
    "archived-event-posters", "development/archived-event-posters"]);
  if (!folder || reserved.has(folder) || folder.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid Cloudinary event folder");
  }
  const scopedFolder = cloudinaryFolder(folder);
  try {
    let page;
    try {
      page = await observeIntegrationRequest("cloudinary", "list-folder-assets", "GET", () =>
        cloudinary.api.resources_by_asset_folder(scopedFolder, { max_results: 500 }));
    } catch (error) {
      if (error?.http_code !== 404) throw error;
    }
    if (page) {
      let previousIds;
      for (;;) {
        const assets = page?.resources || [];
        if (!assets.length) break;
        const currentIds = assets.map(asset => asset.asset_id).join("|");
        if (currentIds === previousIds) throw new Error("Cloudinary folder assets were not removed");
        previousIds = currentIds;
        for (let start = 0; start < assets.length; start += 100) {
          const ids = assets.slice(start, start + 100).map(asset => asset.asset_id);
          if (ids.some(id => !id)) throw new Error("Cloudinary folder asset has no asset ID");
          await observeIntegrationRequest("cloudinary", "delete-folder-assets", "POST", () =>
            cloudinary.api.delete_resources_by_asset_ids(ids));
        }
        page = await observeIntegrationRequest("cloudinary", "list-folder-assets", "GET", () =>
          cloudinary.api.resources_by_asset_folder(scopedFolder, { max_results: 500 }));
      }
    }
    else {
      let nextCursor;
      do {
        const result = await observeIntegrationRequest("cloudinary", "delete-folder-assets", "POST", () =>
          cloudinary.api.delete_resources_by_prefix(`${scopedFolder}/`, nextCursor ? { next_cursor: nextCursor } : {}));
        if (result?.partial && !result.next_cursor) throw new Error("Cloudinary returned a partial deletion without a cursor");
        nextCursor = result?.next_cursor;
      } while (nextCursor);
    }
  } catch (error) {
    if (error?.http_code !== 404) { logIntegrationError("cloudinary", error, "delete-folder-assets"); throw error; }
  }
  try {
    await observeIntegrationRequest("cloudinary", "delete-folder", "DELETE", () => cloudinary.api.delete_folder(scopedFolder));
  } catch (error) {
    if (error?.http_code !== 404) { logIntegrationError("cloudinary", error, "delete-folder"); throw error; }
  }
};

export const deleteArchivedEventPoster = async (event) => {
  const id = String(event?._id || event?.id || "");
  if (!/^[a-f\d]{24}$/i.test(id) || typeof event?.poster !== "string") return;
  const folder = cloudinaryFolder("archived-event-posters");
  let url;
  try { url = new URL(event.poster); }
  catch { return; }
  if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com" ||
    !url.pathname.includes(`/${folder}/${id}`)) return;
  try {
    const result = await observeIntegrationRequest("cloudinary", "delete-archived-event-poster", "DELETE", () =>
      cloudinary.uploader.destroy(`${folder}/${id}`, { resource_type: "image", invalidate: true }));
    if (result?.result !== "ok" && result?.result !== "not found") throw new Error("Cloudinary did not confirm archived poster deletion.");
  } catch (error) {
    logIntegrationError("cloudinary", error, "delete-archived-event-poster");
    throw error;
  }
};

export const getFolders = async (exclude = []) => {
  let result;
  try { result = await observeIntegrationRequest("cloudinary", "list-folders", "GET", () => cloudinary.api.root_folders()); }
  catch (error) { logIntegrationError("cloudinary", error, "list-folders"); throw error; }
  const folders = result.folders.map((f) => f.name);

  return folders;
};

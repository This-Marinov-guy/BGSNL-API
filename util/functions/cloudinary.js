import { v2 as cloudinary } from "cloudinary";
import { logIntegrationError } from "../../middleware/axiom-logger.js";
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
  try { response = await cloudinary.uploader.upload(dataURI, cloudinaryUploadOptions(options)); }
  catch (error) { logIntegrationError("cloudinary", error, "upload"); throw error; }

  return response.secure_url;
};

export const deleteFolder = async (folderName = "") => {
  if (!folderName) {
    console.log("No folder provided");
    return;
  }

  try {
    const scopedFolder = cloudinaryFolder(folderName);
    await cloudinary.api.delete_resources_by_prefix(`${scopedFolder}/`);
    await cloudinary.api.delete_folder(scopedFolder);

    console.log(`Deleted ${folderName}`);
  } catch (error) {
    logIntegrationError("cloudinary", error, "delete-folder");
    console.error("Error deleting folder:", error.message);
  }
};

export const getFolders = async (exclude = []) => {
  let result;
  try { result = await cloudinary.api.root_folders(); }
  catch (error) { logIntegrationError("cloudinary", error, "list-folders"); throw error; }
  const folders = result.folders.map((f) => f.name);

  return folders;
};

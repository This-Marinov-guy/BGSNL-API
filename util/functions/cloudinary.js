import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const uploadToCloudinary = async (file, options = {}) => {
  const b64 = Buffer.from(file.buffer).toString("base64");
  const dataURI = `data:${file.mimetype};base64,${b64}`;

  const response = await cloudinary.uploader.upload(dataURI, {
    overwrite: true,
    ...options,
  });

  return response.secure_url;
};

export const deleteFolder = async (folderName = "") => {
  if (!folderName) {
    return console.log("No folder provided");
  }

  try {
    await cloudinary.api
      .delete_resources_by_prefix(folderName)
      .then(() => {
        cloudinary.api.delete_folder(folderName);
      })
      .catch((err) => console.log(err));

    console.log(`Deleted ${folderName}`);
  } catch (error) {
    console.error("Error deleting folder:", error);
  }
};

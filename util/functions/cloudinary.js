import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
})

export const uploadToCloudinary = async (file, options = {}) => {
    const b64 = Buffer.from(file.buffer).toString('base64');
    const dataURI = `data:${file.mimetype};base64,${b64}`;

    const response = await cloudinary.uploader.upload(dataURI, {
        overwrite: true,
        ...options
    });

    return response.secure_url
}

export const deleteFolder = async (folderName = '') => {
    if (!folderName) {
        return console.log('No folder provided')
    }

    try {
        const { resources } = await cloudinary.search
            .expression(`folder:${folderName}`)
            .execute();

        // Delete each asset
        const deletePromises = resources.map(resource =>
            cloudinary.uploader.destroy(resource.public_id)
        );

        await Promise.all(deletePromises);

        // Delete the folder placeholder
        await cloudinary.api.delete_folder(folderName);
    } catch (error) {
        console.error('Error deleting folder:', error);
    }
}
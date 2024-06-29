import multer from "multer";
import s3Storage from "multer-sharp-s3";
import AWS from "aws-sdk";
import dotenv from "dotenv";
dotenv.config();

// Resized upload with convertion to webp format

const fileFilter = (req, file, cb) => {
  if (
    file.mimetype === "image/jpeg" ||
    file.mimetype === "image/jpg" ||
    file.mimetype === "image/webp" ||
    file.mimetype === "image/png"
  ) {
    cb(null, true);
  } else {
    cb(null, false);
  }
};

const multerS3ConfigResize = (bucketName, maxHeight = 800, maxWidth = 800) =>
  s3Storage({
    s3: new AWS.S3({
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
      Bucket: bucketName,
    }),
    Bucket: bucketName,
    ACL: "public-read",
    Key: function (req, file, cb) {
      cb(null, file.originalname + ".webp");
    },
    resize: {
      height: maxHeight,
      width: maxWidth,
      options: {
        fit: "inside",
      },
    },
    withMetadata: true,
    withoutEnlargement: true,
    toFormat: "webp",
  });

const fileResizedUpload = (bucketName) =>
  multer({
    storage: multerS3ConfigResize(bucketName),
    fileFilter: fileFilter,
    limits: {
      fileSize: 1024 * 1024 * 5, // we are allowing only 5 MB files
    },
  });

// accessed by req.file.Location with capital L

export default fileResizedUpload
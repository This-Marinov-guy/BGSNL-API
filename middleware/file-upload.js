import multer from "multer";
import multerS3 from "multer-s3";
import AWS from "aws-sdk";
import dotenv from "dotenv";
dotenv.config();

//Normal upload

const fileFilter = (req, file, cb) => {
  if (
    file.mimetype === "image/jpeg" ||
    file.mimetype === "image/jpg" ||
    file.mimetype === "image/webp" ||
    file.mimetype === "image/png" ||
    file.mimetype === "application/pdf" ||
    file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    file.mimetype === "application/msword"
  ) {
    cb(null, true);
  } else {
    cb(null, false);
  }
};

const multerS3Config = (bucketName) =>
  multerS3({
    s3: new AWS.S3({
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
      Bucket: bucketName,
    }),
    bucket: bucketName,
    contentType: function (req, file, cb) {
      // Preserve original content type for documents, convert images to webp
      if (
        file.mimetype === "application/pdf" ||
        file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        file.mimetype === "application/msword"
      ) {
        cb(null, file.mimetype);
      } else {
        cb(null, "image/webp");
      }
    },
    metadata: function (req, file, cb) {
      cb(null, { fieldName: file.fieldname });
    },
    key: function (req, file, cb) {
      // Preserve original filename for documents, append .webp for images
      if (
        file.mimetype === "application/pdf" ||
        file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        file.mimetype === "application/msword"
      ) {
        cb(null, file.originalname);
      } else {
        cb(null, file.originalname + ".webp");
      }
    },
  });

const fileUpload = (bucketName) =>
  multer({
    storage: multerS3Config(bucketName),
    fileFilter: fileFilter,
    limits: {
      fileSize: 1024 * 1024 * 5, // we are allowing only 5 MB files
    },
  });
// accessed by req.file.location with small l

export default fileUpload;

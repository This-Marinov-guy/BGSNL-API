export const unsupportedUploadError = (file, acceptedTypes) => {
  const field = file?.fieldname || "_form";
  const message = `${field} must be ${acceptedTypes}`;
  const error = new Error(message);

  error.statusCode = 422;
  error.validationErrors = { [field]: message };

  return error;
};

export const formatUploadValidationError = (error) => {
  if (!error?.validationErrors && error?.name !== "MulterError") {
    return null;
  }

  const field = error.field || "_form";
  return {
    message: "Please correct the invalid fields",
    errors: error.validationErrors || {
      [field]:
        error.code === "LIMIT_FILE_SIZE"
          ? "File must not exceed 5 MB"
          : "The uploaded file is invalid",
    },
  };
};

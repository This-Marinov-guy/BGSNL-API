import { validationResult } from "express-validator";

const formatValidationErrors = (errors) => {
  const fields = {};

  for (const error of errors.array({ onlyFirstError: true })) {
    const field = error.path ?? error.param ?? "_form";

    if (!fields[field]) {
      fields[field] = error.msg;
    }
  }

  return fields;
};

export const validateRequest = (req, res, next) => {
  const result = validationResult(req);

  if (result.isEmpty()) {
    return next();
  }

  return res.status(422).json({
    message: "Please correct the invalid fields",
    errors: formatValidationErrors(result),
  });
};

export { formatValidationErrors };

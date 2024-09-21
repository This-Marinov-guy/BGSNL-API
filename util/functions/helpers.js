import dotenv from "dotenv";
dotenv.config();
import jwt from "jsonwebtoken";
import CryptoJS from 'crypto-js';
import moment from 'moment-timezone';
import { DEV_JWT_TIMEOUT, PROD_JWT_TIMEOUT } from "../config/defines.js";

const JWT_TIMEOUT = process.env.APP_ENV === 'prod' ? PROD_JWT_TIMEOUT : DEV_JWT_TIMEOUT;

// Function to update the original array with the modified subset | needs to have ids
export const updateOriginalArray = (originalArray, modifiedSubset) => {
  const updatedArray = originalArray.map(originalObject => {
    const modifiedObject = modifiedSubset.find(subsetObject => subsetObject.id === originalObject.id);
    return modifiedObject ? { ...originalObject, ...modifiedObject } : originalObject;
  });
  return updatedArray;
};

export const isEventTimerFinished = (timer) => {
  return timer.valueOf() < (new Date()).valueOf()
};

export const removeModelProperties = (obj, properties) => {
  const result = obj.toObject(); // Convert Mongoose document to plain JavaScript object
  properties.forEach(prop => delete result[prop]);

  if (result.hasOwnProperty('_id')) {
    result['id'] = result['_id'];

    delete result['_id'];
  }

  return result;
}

export const jwtSign = (user) => {
  return jwt.sign(
    { userId: user.id, roles: user.roles, email: user.email, region: user.region },
    process.env.JWT_STRING,
    { expiresIn: JWT_TIMEOUT }
  );
}

export const jwtRefresh = (token) => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });

    const newToken = jwt.sign(
      {
        userId: decoded.userId,
        roles: decoded.roles,
        email: decoded.email,
        region: decoded.region,
      },
      process.env.JWT_STRING,
      { expiresIn: JWT_TIMEOUT }
    );

    return newToken;
  } catch (error) {
    console.error("Error refreshing token:", error);
    return null;
  }
}

export const encodeForURL = (string) => {
  let encodedString = string.toLowerCase().replace(/ /g, '_');

  return encodeURIComponent(encodedString);
}

export const decodeFromURL = (url) => {
  const decodedString = url.replace(/_/g, ' ').replace(/\b\w/g, function (char) {
    return char.toUpperCase();
  });

  return decodeURIComponent(decodedString);
}

export const isBirthdayToday = (birthdayStr) => {
  const birthdayDate = new Date(birthdayStr);
  if (isNaN(birthdayDate.getTime())) {
    throw new Error('Invalid date format');
  }

  const today = new Date();

  // Check if today's month and day match the birthday's month and day
  return (
    birthdayDate.getDate() === today.getDate() &&
    birthdayDate.getMonth() === today.getMonth()
  );
}

export const decryptData = (string) => {
  if (!string) {
    return {};
  }

  const decryptedBytes = CryptoJS.AES.decrypt(decodeURIComponent(string), process.env.CRYPTO_ENCRYPTION_KEY);
  const decryptedData = JSON.parse(decryptedBytes.toString(CryptoJS.enc.Utf8));

  return decryptedData;
}

export const processExtraInputsForm = (extraInputsForm) => {
  return extraInputsForm.filter(obj => {
    if (!obj.hasOwnProperty('placeholder')) {
      return false;
    }

    if (obj.type === 'select' && (!obj.options || obj.options.length === 0)) {
      return false;
    }

    return true;
  });
};

export const compareIntStrings = (str1, str2) => {
  return str1.replace(/\D+/g, '').toLowerCase() === str2.replace(/\D+/g, '').toLowerCase();
}

export const hasOverlap = (array1, array2) => {
  const set = new Set(array2);
  for (let item of array1) {
    if (set.has(item)) return true;
  }
  return false;
}

export const replaceSpecialSymbolsWithSpaces = (inputString) => {
  // Use a regular expression to match any non-alphanumeric character
  return inputString.replace(/[^a-zA-Z0-9\s]/g, ' ');
}

export const capitalizeFirstLetter = (string) => {
  return string.charAt(0).toUpperCase() + string.slice(1);
}
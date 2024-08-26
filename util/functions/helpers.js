import dotenv from "dotenv";
dotenv.config();
import jwt from "jsonwebtoken";
import CryptoJS from 'crypto-js';
import moment from 'moment-timezone';

// Function to update the original array with the modified subset | needs to have ids
export const updateOriginalArray = (originalArray, modifiedSubset) => {
  const updatedArray = originalArray.map(originalObject => {
    const modifiedObject = modifiedSubset.find(subsetObject => subsetObject.id === originalObject.id);
    return modifiedObject ? { ...originalObject, ...modifiedObject } : originalObject;
  });
  return updatedArray;
};

export const isEventTimerFinished = (timer) => {
  const expireTime = moment(timer).subtract(2, 'hours');
  const currentNLTime = moment().tz('Europe/Amsterdam');

  return expireTime <= currentNLTime;
};

export const removeModelProperties = (obj, properties) => {
  const result = obj.toObject(); // Convert Mongoose document to plain JavaScript object
  properties.forEach(prop => delete result[prop]);
  return result;
}

export const jwtSign = (user) => {
  return jwt.sign(
    { userId: user.id, roles: user.roles, email: user.email, region: user.region },
    process.env.JWT_STRING,
    { expiresIn: "1h" }
  );
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

export const compareStringInputs = (str1, str2) => {
  return str1.replace(/\s+/g, '').toLowerCase() === str2.replace(/\s+/g, '').toLowerCase();
}
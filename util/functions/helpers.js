import dotenv from "dotenv";
dotenv.config();
import jwt from "jsonwebtoken";
import dns from "dns";
import CryptoJS from "crypto-js";
import moment from "moment-timezone";
import { DEV_JWT_TIMEOUT, PROD_JWT_TIMEOUT } from "../config/defines.js";
import { allowedCrawlers } from "../config/access.js";

const JWT_TIMEOUT =
  process.env.APP_ENV === "prod" ? PROD_JWT_TIMEOUT : DEV_JWT_TIMEOUT;

// Function to update the original array with the modified subset | needs to have ids
export const updateOriginalArray = (originalArray, modifiedSubset) => {
  const updatedArray = originalArray.map((originalObject) => {
    const modifiedObject = modifiedSubset.find(
      (subsetObject) => subsetObject.id === originalObject.id
    );
    return modifiedObject
      ? { ...originalObject, ...modifiedObject }
      : originalObject;
  });
  return updatedArray;
};

export const isEventTimerFinished = (timer) => {
  return timer.valueOf() < new Date().valueOf();
};

export const removeModelProperties = (obj, properties) => {
  const result = obj.toObject(); // Convert Mongoose document to plain JavaScript object
  properties.forEach((prop) => delete result[prop]);

  if (result.hasOwnProperty("_id")) {
    result["id"] = result["_id"];

    delete result["_id"];
  }

  return result;
};

export const jwtSign = (user) => {
  return jwt.sign(
    {
      userId: user.id,
      status: user.status,
      roles: user.roles,
      email: user.email,
      region: user.region,
    },
    process.env.JWT_STRING,
    { expiresIn: JWT_TIMEOUT }
  );
};

export const jwtRefresh = (token) => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_STRING, {
      ignoreExpiration: true,
    });

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
};

export const encodeForURL = (string) => {
  let encodedString = string.toLowerCase().replace(/ /g, "_");

  return encodeURIComponent(encodedString);
};

export const decodeFromURL = (url) => {
  const decodedString = url
    .replace(/_/g, " ")
    .replace(/\b\w/g, function (char) {
      return char.toUpperCase();
    });

  return decodeURIComponent(decodedString);
};

export const isBirthdayToday = (birthdayStr) => {
  const birthdayDate = new Date(birthdayStr);
  if (isNaN(birthdayDate.getTime())) {
    throw new Error("Invalid date format");
  }

  const today = new Date();

  // Check if today's month and day match the birthday's month and day
  return (
    birthdayDate.getDate() === today.getDate() &&
    birthdayDate.getMonth() === today.getMonth()
  );
};

export const decryptData = (string) => {
  if (!string) {
    return {};
  }

  const decryptedBytes = CryptoJS.AES.decrypt(
    decodeURIComponent(string),
    process.env.CRYPTO_ENCRYPTION_KEY
  );
  const decryptedData = JSON.parse(decryptedBytes.toString(CryptoJS.enc.Utf8));

  return decryptedData;
};

export const processExtraInputsForm = (extraInputsForm) => {
  console.log(extraInputsForm);
  
  if (!extraInputsForm) {
    return extraInputsForm;
  }

  return extraInputsForm.filter((obj) => {
    if (!obj.hasOwnProperty("placeholder")) {
      return false;
    }

    if (obj.type === "select" && (!obj.options || obj.options.length === 0)) {
      return false;
    }

    return true;
  });
};

export const compareIntStrings = (str1, str2) => {
  return (
    str1.replace(/\D+/g, "").toLowerCase() ===
    str2.replace(/\D+/g, "").toLowerCase()
  );
};

export const hasOverlap = (array1, array2) => {
  const set = new Set(array2);
  for (let item of array1) {
    if (set.has(item)) return true;
  }
  return false;
};

export const replaceSpecialSymbolsWithSpaces = (inputString) => {
  // Use a regular expression to match any non-alphanumeric character
  return inputString.replace(/[^a-zA-Z0-9\s]/g, " ");
};

export const capitalizeFirstLetter = (string) => {
  return string.charAt(0).toUpperCase() + string.slice(1);
};

export const refactorToKeyValuePairs = (obj) => {
  obj = JSON.parse(obj);
  let result = "";

  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      result += `${key}: ${obj[key]}\n`;
    }
  }

  return result.trim();
};

export const parseStingData = (arr, fromJson = true) => {
  try {
    if (!arr || arr?.length === 0) {
      return null;
    }

    if (fromJson) {
      arr = JSON.parse(arr);
    }

    return arr.map((obj) => {
      let newObj = { ...obj }; // Copy the object to avoid mutating the original

      Object.keys(newObj).forEach((key) => {
        if (newObj[key] === "true") {
          newObj[key] = true; // Convert string "true" to boolean true
        } else if (newObj[key] === "false") {
          newObj[key] = false; // Convert string "false" to boolean false
        }
      });      

      return newObj;
    });
  } catch (err) {
    return arr;
  }
};

export const isAllowedCrawlerBot = async (ip, userAgent) => {
 for (const crawler of allowedCrawlers) {
   if (userAgent.includes(crawler.userAgent)) {
     try {
       const hostnames = await new Promise((resolve, reject) =>
         dns.reverse(ip, (err, domains) =>
           err ? reject(err) : resolve(domains)
         )
       );
       if (hostnames.some((domain) => domain.endsWith(crawler.domain))) {
         console.log(`${crawler.name} allowed: IP ${ip}`);
         return true;
       }
     } catch (error) {
       console.error(`DNS lookup failed for ${crawler.name}, IP: ${ip}`);
       console.log(error);
       
     }
   }
 }
 return false;
};

import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

const credentials = JSON.parse(
  process.env.GOOGLE_APPLICATION_ADMIN_CREDENTIALS
);

export const calendar = new google.auth.GoogleAuth({
  credentials: credentials,
  scopes: "https://www.googleapis.com/auth/calendar",
});

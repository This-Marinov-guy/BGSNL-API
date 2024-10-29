import { google } from 'googleapis';
import dotenv from "dotenv";
dotenv.config();

// JWT initialization for Google Calendar API
export function initializeServiceAccountClient() {
  const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_ADMIN_CREDENTIALS);

  const jwtClient = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ['https://www.googleapis.com/auth/calendar'],
    null
  );

  return jwtClient;
}

export const calendar = google.calendar({ version: 'v3', auth: initializeServiceAccountClient() });

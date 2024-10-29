import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from "dotenv";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVICE_ACCOUNT_KEY_FILE = path.join(__dirname, 'service-account-key.json');

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

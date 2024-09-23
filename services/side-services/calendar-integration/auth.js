import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the service account key JSON file
const SERVICE_ACCOUNT_KEY_FILE = path.join(__dirname, 'service-account-key.json');

// Initialize JWT client for Google Calendar API using service account
export function initializeServiceAccountClient() {
  const credentials = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_KEY_FILE));

  const jwtClient = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ['https://www.googleapis.com/auth/calendar'],
    null
  );

  return jwtClient;
}

// Export the initialized Google Calendar client
export const calendar = google.calendar({ version: 'v3', auth: initializeServiceAccountClient() });

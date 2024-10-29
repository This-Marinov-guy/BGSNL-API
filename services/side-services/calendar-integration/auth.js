import { google } from "googleapis";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// JWT initialization for Google Calendar API
export function initializeServiceAccountClient() {
  try {
    // Verify credentials exist
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      throw new Error(
        "Missing GOOGLE_APPLICATION_CREDENTIALS in environment variables"
      );
    }

    // Parse credentials with error handling
    const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);

    // Verify required credential fields
    if (!credentials.client_email || !credentials.private_key) {
      throw new Error(
        "Invalid credentials format: missing client_email or private_key"
      );
    }

    // Create JWT client
    const jwtClient = new google.auth.JWT(
      credentials.client_email,
      null,
      credentials.private_key,
      ["https://www.googleapis.com/auth/calendar"],
      credentials.project_id // Added project_id
    );

    return jwtClient;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Failed to parse Google credentials JSON: ${error.message}`
      );
    }
    throw error;
  }
}

export const calendar = google.calendar({
  version: "v3",
  auth: initializeServiceAccountClient(),
});

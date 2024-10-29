import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

export function initializeServiceAccountClient() {
  try {
    if (!process.env.GOOGLE_APPLICATION_ADMIN_CREDENTIALS) {
      throw new Error(
        "Missing GOOGLE_APPLICATION_ADMIN_CREDENTIALS in environment variables"
      );
    }

    const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_ADMIN_CREDENTIALS);

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
      credentials.project_id 
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

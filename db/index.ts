import { drizzle } from "drizzle-orm/netlify-db";
import * as schema from "./schema.js";

if (process.env.NETLIFY_DB_URL) {
  try {
    const url = new URL(process.env.NETLIFY_DB_URL);
    
    // Check if running against a local database
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      process.env.NETLIFY_DB_DRIVER = "server";
      if (!url.username) {
        url.username = "postgres";
      }
      process.env.NETLIFY_DB_URL = url.toString();
    } else {
      url.searchParams.delete("channel_binding");
      url.searchParams.delete("sslmode");
      process.env.NETLIFY_DB_URL = url.toString();
    }
  } catch (e) {
    console.error("Failed to parse NETLIFY_DB_URL:", e);
  }
}

export const db = drizzle({ schema });
export * as schema from "./schema.js";

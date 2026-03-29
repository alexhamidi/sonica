import { neon } from "@neondatabase/serverless";

const url = process.env.POSTGRES_URL;
if (!url) {
  throw new Error("POSTGRES_URL is required for API routes");
}

export const sql = neon(url);

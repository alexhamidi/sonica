import { createNeonAuth } from "@neondatabase/auth/next/server";

function neonAuthConfig(): { baseUrl: string; secret: string } {
  const baseUrl = process.env.NEON_AUTH_BASE_URL?.trim();
  const secretRaw = process.env.NEON_AUTH_COOKIE_SECRET?.trim();
  if (!baseUrl) {
    throw new Error(
      "Set NEON_AUTH_BASE_URL in .env.local or Vercel env (see web/.env.example).",
    );
  }
  if (!secretRaw || secretRaw.length < 32) {
    throw new Error(
      "Set NEON_AUTH_COOKIE_SECRET (≥32 characters, e.g. openssl rand -base64 32) in .env.local or Vercel env.",
    );
  }
  return { baseUrl, secret: secretRaw };
}

const { baseUrl, secret } = neonAuthConfig();

export const auth = createNeonAuth({
  baseUrl,
  cookies: { secret },
});

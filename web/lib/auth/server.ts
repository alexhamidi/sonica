import { createNeonAuth } from "@neondatabase/auth/next/server";

/**
 * @neondatabase/auth requires ≥32 chars. Used only while `next build` evaluates
 * server chunks (e.g. /api/auth) when Vercel/CI has not injected NEON_* yet.
 */
const BUILD_PLACEHOLDER_COOKIE_SECRET = "00000000000000000000000000000000";

const isProductionBuild = process.env.NEXT_PHASE === "phase-production-build";

function neonAuthConfig(): { baseUrl: string; secret: string } {
  const baseUrl = process.env.NEON_AUTH_BASE_URL?.trim();
  const secretRaw = process.env.NEON_AUTH_COOKIE_SECRET?.trim();
  const secret =
    secretRaw && secretRaw.length >= 32 ? secretRaw : undefined;

  if (baseUrl && secret) {
    return { baseUrl, secret };
  }
  if (isProductionBuild) {
    return {
      baseUrl: baseUrl ?? "https://neon-auth.build-placeholder.invalid",
      secret: secret ?? BUILD_PLACEHOLDER_COOKIE_SECRET,
    };
  }
  if (!baseUrl) {
    throw new Error(
      "Set NEON_AUTH_BASE_URL in .env.local or Vercel env (see web/.env.example).",
    );
  }
  throw new Error(
    "Set NEON_AUTH_COOKIE_SECRET (≥32 characters, e.g. openssl rand -base64 32) in .env.local or Vercel env.",
  );
}

const { baseUrl, secret } = neonAuthConfig();

export const auth = createNeonAuth({
  baseUrl,
  cookies: { secret },
});

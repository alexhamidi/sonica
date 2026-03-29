import { createNeonAuth } from "@neondatabase/auth/next/server";

/** 32 chars — @neondatabase/auth rejects shorter secrets; used only during `next build`. */
const BUILD_PLACEHOLDER_COOKIE_SECRET = "00000000000000000000000000000000";

const isProductionBuild = process.env.NEXT_PHASE === "phase-production-build";

function neonAuthConfig() {
  const baseUrl = process.env.NEON_AUTH_BASE_URL?.trim() || undefined;
  const secretRaw = process.env.NEON_AUTH_COOKIE_SECRET?.trim() || undefined;
  const secret =
    secretRaw && secretRaw.length >= 32 ? secretRaw : undefined;

  if (baseUrl && secret) {
    return { baseUrl, secret };
  }
  if (isProductionBuild) {
    return {
      baseUrl: baseUrl ?? "https://neon-auth.placeholder.invalid",
      secret: secret ?? BUILD_PLACEHOLDER_COOKIE_SECRET,
    };
  }
  throw new Error(
    "Set NEON_AUTH_BASE_URL and NEON_AUTH_COOKIE_SECRET (≥32 characters, e.g. openssl rand -base64 32) in .env.local or Vercel env.",
  );
}

const { baseUrl, secret } = neonAuthConfig();

export const auth = createNeonAuth({
  baseUrl,
  cookies: { secret },
});

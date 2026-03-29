/**
 * Base URL for the Python mus API when Next.js **server** routes call FastAPI
 * (e.g. reproject-user). Uses the same `NEXT_PUBLIC_API_URL` you already use from
 * the client (e.g. http://localhost:8002) unless `MUS_API_URL` is set to override
 * server-side only (handy if the browser and Node ever need different hosts).
 */
export function musApiBaseUrl(): string {
  const override = process.env.MUS_API_URL?.trim();
  if (override) return override;
  return process.env.NEXT_PUBLIC_API_URL?.trim() || "http://127.0.0.1:8002";
}

/** Browser-visible catalog/search API (FastAPI). */
export function publicMusApiUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL?.trim() || "http://127.0.0.1:8002";
}

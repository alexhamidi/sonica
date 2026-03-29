import { musApiBaseUrl } from "@/lib/musApi";

/** Notify the Python layout service to recompute projections for this user. */
export async function triggerMusReprojectUser(
  userId: string,
): Promise<Response> {
  return fetch(`${musApiBaseUrl()}/api/reproject-user`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
}

const KEY = "mus:pendingAddBulk";

type Payload = { v: 1; grandparentIds: string[] };

function parse(raw: string): string[] | null {
  try {
    const o = JSON.parse(raw) as Partial<Payload>;
    if (o.v !== 1 || !Array.isArray(o.grandparentIds)) return null;
    const ids = o.grandparentIds.filter(
      (x): x is string => typeof x === "string" && x.length > 0,
    );
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}

/** Save selections so add-bulk can run after sign-in on /canvas. */
export function setPendingAddBulk(grandparentIds: string[]): void {
  if (typeof window === "undefined" || grandparentIds.length === 0) return;
  const payload: Payload = { v: 1, grandparentIds };
  sessionStorage.setItem(KEY, JSON.stringify(payload));
}

export function peekPendingAddBulk(): string[] | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return null;
  return parse(raw);
}

export function clearPendingAddBulk(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(KEY);
}

export function restorePendingAddBulk(grandparentIds: string[]): void {
  setPendingAddBulk(grandparentIds);
}

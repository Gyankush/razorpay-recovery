"use client";

/**
 * Client-side operator-key helper. The key lives in sessionStorage (never in
 * code or URLs) and is attached as `x-admin-secret` on mutating requests.
 * In local dev with no ADMIN_SECRET configured the header is simply absent.
 */
export function getAdminKey(): string {
  try {
    return sessionStorage.getItem("payrescue_admin_key") || "";
  } catch {
    return "";
  }
}

export function setAdminKey(key: string): void {
  try {
    if (key) sessionStorage.setItem("payrescue_admin_key", key);
    else sessionStorage.removeItem("payrescue_admin_key");
  } catch {
    // storage unavailable — key just won't persist
  }
}

export function adminHeaders(): Record<string, string> {
  const key = getAdminKey();
  return key ? { "x-admin-secret": key } : {};
}

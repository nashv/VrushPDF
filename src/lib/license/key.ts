/**
 * The key's shape and who it names, for the dialog's as-you-paste hint only.
 * The signature is checked in Rust (`src-tauri/src/license_key.rs`, which
 * explains the format); this cannot tell a forged key from a real one.
 */

/** Ed25519 signatures are 64 bytes: 86 base64url symbols. */
const SHAPE = /^VRSH\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]{86}$/;

/** The key without whitespace, and the email in it, or null if it is not a whole key. */
export function readKey(input: string): { key: string; email: string } | null {
  const key = input.replace(/\s/g, "");
  const body = SHAPE.exec(key)?.[1];
  if (!body) return null;
  try {
    const json = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
    return payload?.v === 1 && typeof payload.email === "string" ? { key, email: payload.email } : null;
  } catch {
    return null;
  }
}

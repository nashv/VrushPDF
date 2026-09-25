/**
 * Bridge to the license commands. The logic, and the only check that actually
 * stops a write, live in `src-tauri/src/license.rs`.
 */
import { invoke } from "@tauri-apps/api/core";

export type LicenseState = "licensed" | "trial" | "expired" | "revoked";

export interface LicenseStatus {
  state: LicenseState;
  /** Whole days left, rounded up; only while on trial. */
  daysLeft: number | null;
  email: string | null;
  /** The key's short id, e.g. `80232a87`. */
  keyId: string | null;
  buyUrl: string;
}

export const licenseStatus = () => invoke<LicenseStatus>("license_status");
/** Rejects with a message meant for the user. */
export const licenseActivate = (key: string) => invoke<LicenseStatus>("license_activate", { key });
export const licenseRemove = () => invoke<LicenseStatus>("license_remove");

import { cpSync, existsSync, mkdirSync, renameSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

/** AppImage mounts and system packages are read-only. Editors need a private copy. */
export function writableReferenceData(shipped: string, profile: string, version: string): string {
  const parent = join(profile, "reference-data");
  const target = join(parent, version);
  if (existsSync(join(target, ".ready"))) return target;
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, ".prepare-"));
  cpSync(shipped, staging, { recursive: true });
  // A completed copy becomes visible at once, so a crash cannot leave half a season.
  mkdirSync(join(staging, ".ready"));
  try { renameSync(staging, target); }
  catch (error) {
    if (!existsSync(join(target, ".ready"))) throw error;
  }
  return target;
}

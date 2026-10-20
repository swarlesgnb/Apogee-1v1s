import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";

function portableFile(name: string): boolean {
  return ["settings.json", "quests.json", "ghost.json", "social.json", "admin-overrides.json"].includes(name) ||
    /^expedition-first-light-v\d+\.json$/.test(name);
}

/** Only portable player state: Steam tokens and Chromium caches stay on this PC. */
export function createProgressBackup(source: string, destination: string): { folder: string; files: string[] } {
  const files = readdirSync(source, { withFileTypes: true })
    .filter(entry => entry.isFile() && portableFile(entry.name))
    .map(entry => entry.name).sort();
  if (!files.length) throw new Error("There is no saved progress or settings to back up yet.");
  mkdirSync(destination, { recursive: true });
  const folder = mkdtempSync(join(destination, `Apogee-backup-${new Date().toISOString().slice(0, 10)}-`));
  for (const file of files) copyFileSync(join(source, file), join(folder, file));
  writeFileSync(join(folder, "RESTORE.txt"), [
    "Apogee local progress backup",
    `Created: ${new Date().toISOString()}`,
    "",
    "Keep this entire folder somewhere safe before reinstalling your operating system.",
    "To restore: use Apogee > Restore local progress and select this backup folder.",
    "For manual restoration: open Help > Open app data folder, then quit Apogee.",
    "Copy the JSON files in this backup into that app data folder, replacing matching files.",
    "Open Apogee again. If KovaaK's moved, use Apogee > Choose stats folder.",
    "Sign in with Steam again to access your online account.",
    "",
    "Includes local quests, expedition progress, ghosts, appearance overrides and settings when present.",
    "Does not include KovaaK's CSV history, Steam sign-in, online rankings, or editor drafts.",
    "Back up the KovaaK's stats folder separately to preserve your training history.",
    "",
    "Files:", ...files,
  ].join("\r\n"), "utf8");
  return { folder, files };
}

/** Validate the entire backup before touching any current save; roll back failed writes. */
export function restoreProgressBackup(source: string, profile: string): { files: string[]; previous: string | null } {
  const files = readdirSync(source, { withFileTypes: true })
    .filter(entry => entry.isFile() && portableFile(entry.name)).map(entry => entry.name).sort();
  if (!files.length) throw new Error("This folder contains no Apogee progress backup.");
  const contents = new Map<string, string>();
  for (const file of files) {
    const path = join(source, file), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024) throw new Error(`Invalid backup file: ${file}`);
    const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid save: ${file}`);
    // Folder locations and monitor positions belong to this machine.
    if (file === "settings.json") { parsed.statsDir = null; parsed.window = null; }
    contents.set(file, JSON.stringify(parsed, null, 2) + "\n");
  }
  mkdirSync(profile, { recursive: true });
  const old = new Map(files.map(file => [file, existsSync(join(profile, file)) ? readFileSync(join(profile, file)) : null]));
  const hasSaves = readdirSync(profile).some(portableFile);
  const previous = hasSaves ? createProgressBackup(profile, join(profile, "backups-before-restore")).folder : null;
  const changed: string[] = [];
  try {
    for (const [file, body] of contents) {
      const path = join(profile, file), temporary = path + ".restore-tmp";
      writeFileSync(temporary, body, { mode: 0o600 });
      renameSync(temporary, path);
      changed.push(file);
    }
  } catch (error) {
    for (const file of changed) {
      const previousBody = old.get(file), path = join(profile, file);
      if (previousBody) writeFileSync(path, previousBody);
      else unlinkSync(path);
    }
    throw error;
  }
  return { files, previous };
}

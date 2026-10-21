import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverStatsFolders } from "../src/app/steamPaths.ts";
import { writableReferenceData } from "../src/app/referenceData.ts";
import { setDataDir, sourceDataDir } from "../src/core/dataDir.ts";

const linux = (readText: (path: string) => string = () => { throw Error("missing"); }) =>
  discoverStatsFolders({ platform: "linux", home: "/home/player", env: {}, readText });
const suffix = "/steamapps/common/FPSAimTrainer/FPSAimTrainer/stats";
const native = linux();
assert(native.includes("/home/player/.local/share/Steam" + suffix));
assert(native.includes("/home/player/.steam/steam" + suffix));
assert(native.includes("/home/player/.var/app/com.valvesoftware.Steam/.local/share/Steam" + suffix));
assert(!native.some(path => path.includes("C:")));
console.log("PASS Linux native and Flatpak Steam candidates use Linux paths");
const custom = linux(path => path.endsWith("steamapps/libraryfolders.vdf")
  ? '"libraryfolders" { "1" { "path" "/mnt/Games/Steam Library" } "2" { "path" "/mnt/games/steam library" } }' : "");
assert(custom.includes("/mnt/Games/Steam Library" + suffix));
assert(custom.includes("/mnt/games/steam library" + suffix));
assert.equal(custom.filter(path => path === "/mnt/Games/Steam Library" + suffix).length, 1);
console.log("PASS custom Linux mounts, spaces, case sensitivity and deduplication");
const windows = discoverStatsFolders({ platform: "win32", home: "C:\\Users\\Player", env: {},
  registryRoot: "D:\\Steam", readText: () => '"1" "D:\\\\steam" "2" { "path" "G:\\\\My Games" }' });
assert(windows.includes("G:\\My Games\\steamapps\\common\\FPSAimTrainer\\FPSAimTrainer\\stats"));
assert.equal(windows.filter(path => path.toLowerCase().startsWith("d:\\steam\\")).length, 1);
console.log("PASS Windows registry roots and old/new Steam library formats remain supported");
const root = mkdtempSync(join(tmpdir(), "apogee-desktop-"));
const shipped = join(root, "readonly-package"), profile = join(root, "profile");
mkdirSync(shipped);
writeFileSync(join(shipped, "season.json"), '{"revision":1}');
const first = writableReferenceData(shipped, profile, "1.0.0");
assert.equal(readFileSync(join(first, "season.json"), "utf8"), '{"revision":1}');
writeFileSync(join(first, "season.json"), '{"edited":true}');
assert.equal(writableReferenceData(shipped, profile, "1.0.0"), first);
assert.equal(readFileSync(join(first, "season.json"), "utf8"), '{"edited":true}');
assert.equal(readFileSync(join(shipped, "season.json"), "utf8"), '{"revision":1}');
const next = writableReferenceData(shipped, profile, "1.1.0");
assert.notEqual(next, first);
assert.equal(readFileSync(join(next, "season.json"), "utf8"), '{"revision":1}');
console.log("PASS packaged data is writable per profile, edits survive relaunch, upgrades preserve old data");
setDataDir(first, false);
assert.equal(sourceDataDir(), null);
console.log("PASS packaged editors cannot write into a source checkout from their working directory");

/**
 * Check that every name an Edge Function uses is declared or imported.
 *
 *   npx tsx tools/validateFunctionNames.ts
 *
 * WHY THIS EXISTS
 *
 * send-duel used INITIAL_TTL_MS without importing it, and every duel failed with
 * "INITIAL_TTL_MS is not defined" from the day duels shipped. validateFunctionImports
 * could not see it: it checks that what a function imports exists, not that what a
 * function uses was imported. Deno only reports the missing name when the line runs.
 *
 * The functions cannot be typechecked here (jsr: and https: specifiers, Deno globals),
 * but TypeScript still resolves every identifier while it parses them. Of everything it
 * reports, "cannot find name" is the one class that is not noise from the Deno
 * environment, so that is the only class kept, with `Deno` itself excepted.
 *
 * It fails open two ways if nothing guards it, and both are guarded: a program that
 * silently picked up no functions would report no errors, so the count of files checked
 * must equal the count of functions on disk; and a filter that silently stopped matching
 * would report no errors either, so a planted undeclared name must be caught first.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const FUNCTIONS = join(root, "supabase", "functions");

/** Cannot find name 'x'. / Cannot find name 'x'. Did you mean 'y'? */
const UNDECLARED = new Set([2304, 2552]);

const OPTIONS: ts.CompilerOptions = {
  noEmit: true,
  allowImportingTsExtensions: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
};

function undeclared(files: string[]): { file: string; line: number; text: string }[] {
  const program = ts.createProgram(files, OPTIONS);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => UNDECLARED.has(d.code))
    .map((d) => {
      const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      const line = d.file && d.start != null ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
      return { file: d.file?.fileName ?? "?", line, text };
    })
    .filter((d) => !/'Deno'/.test(d.text));
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}

// The instrument first: it has to be able to see the thing it is looking for.
const plantedDir = mkdtempSync(join(tmpdir(), "apogee-names-"));
const planted = join(plantedDir, "index.ts");
writeFileSync(planted, "export const expiresAt = Date.now() + PLANTED_UNDECLARED;\n");
try {
  check(
    "a planted undeclared name is reported",
    undeclared([planted]).some((d) => d.text.includes("PLANTED_UNDECLARED")),
  );
} finally {
  rmSync(plantedDir, { recursive: true, force: true });
}

const functions = readdirSync(FUNCTIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
  .map((d) => join(FUNCTIONS, d.name, "index.ts"))
  .filter((f) => existsSync(f));

const program = ts.createProgram(functions, OPTIONS);
const checked = program.getRootFileNames().filter((f) => program.getSourceFile(f)).length;
check(`every function was read (${checked} of ${functions.length})`, functions.length > 0 && checked === functions.length);

const found = undeclared(functions);
check("no function uses a name it never declared or imported", found.length === 0);
for (const d of found) console.log(`       ${relative(root, d.file).replace(/\\/g, "/")}:${d.line}  ${d.text}`);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nOK: every name used in an Edge Function is declared or imported");

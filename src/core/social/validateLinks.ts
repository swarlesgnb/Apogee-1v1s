/**
 * Validate challenge links: the grammar, every refusal, argv handling and where link text
 * is allowed to go.
 *
 *   npm run validate:links
 *
 * A link is attacker-controlled text that the operating system hands to the app. These
 * checks hold the parser (src/core/social/deepLinks.ts) to:
 *
 *   - accepting exactly the documented forms, in either case, with one trailing slash, and
 *     writing each back canonically so a round trip is stable;
 *   - refusing every malformed, oversized, unknown-verb, encoded, whitespace, control,
 *     non-ASCII, path-traversal, query, fragment and shell-shaped case listed below, each
 *     for a stated reason;
 *   - finding a link in argv the way a first launch and `second-instance` deliver it, among
 *     Chromium's own switches, and trusting none when there is more than one;
 *   - the https landing form and a pasted link, under the same rules;
 *   - the open-challenge view carrying no score, key for key, and refusing in the right order;
 *   - and, read from the source, that link handling in the main process never reaches a
 *     shell, shell.openExternal, a file read or eval, and that the renderer's confirmation
 *     names a proposal by id and carries no code of its own.
 */

import { readFileSync } from "node:fs";

import {
  deepLinkUrl,
  landingUrl,
  linkFromArgv,
  LANDING_BASE,
  MAX_LINK_LENGTH,
  parseDeepLink,
  parseLandingQuery,
  parsePastedLink,
  REFUSAL_TEXT,
  type DeepLink,
  type LinkRefusal,
} from "./deepLinks.ts";
import {
  canAnswerOpenDuel,
  CODE_ALPHABET,
  isOpenDuelCode,
  isOpenDuelView,
  mintCode,
  openDuelView,
  OPEN_DUEL_MAX_ANSWERS,
  OPEN_DUEL_VIEW_KEYS,
  type OpenDuelFacts,
} from "./openDuel.ts";

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
  } else if (process.env.VERBOSE) console.log(`  ok   ${name}${detail ? `: ${detail}` : ""}`);
}
const section = (t: string) => console.log(`\n${t}`);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
section("valid links");
// ---------------------------------------------------------------------------
const VALID: [string, DeepLink][] = [
  ["apogee://duel/ABCD2345", { kind: "duel", code: "ABCD2345" }],
  ["apogee://duel/abcd2345", { kind: "duel", code: "ABCD2345" }],
  ["APOGEE://DUEL/ABCD2345/", { kind: "duel", code: "ABCD2345" }],
  ["apogee://ghost/Z9Y8X7W6", { kind: "ghost", code: "Z9Y8X7W6" }],
  ["apogee://daily", { kind: "daily", number: null, band: null }],
  ["apogee://daily/", { kind: "daily", number: null, band: null }],
  ["apogee://daily/14", { kind: "daily", number: 14, band: null }],
  ["apogee://daily/14/advanced", { kind: "daily", number: 14, band: "advanced" }],
  ["apogee://Daily/99999/EXPERT/", { kind: "daily", number: 99999, band: "expert" }],
  ["apogee://daily/1/novice", { kind: "daily", number: 1, band: "novice" }],
];
for (const [text, want] of VALID) {
  const r = parseDeepLink(text);
  check(`accepts ${text}`, r.ok && same(r.link, want), JSON.stringify(r));
  if (r.ok) {
    const again = parseDeepLink(deepLinkUrl(r.link));
    check(`round-trips ${text} as ${deepLinkUrl(r.link)}`, again.ok && same(again.link, r.link));
    const landing = landingUrl(r.link);
    const back = parsePastedLink(landing);
    check(`and through its https landing ${landing.slice(LANDING_BASE.length)}`, back.ok && same(back.link, r.link));
  }
}
check("the longest valid link is far inside the cap", deepLinkUrl({ kind: "daily", number: 99999, band: "intermediate" }).length < MAX_LINK_LENGTH / 2);

// ---------------------------------------------------------------------------
section("refused links");
// ---------------------------------------------------------------------------
const REFUSED: [unknown, LinkRefusal | "any", string][] = [
  [null, "not-a-string", "null"],
  [undefined, "not-a-string", "undefined"],
  [42, "not-a-string", "a number"],
  [{ toString: () => "apogee://daily" }, "not-a-string", "an object that stringifies to a link"],
  [["apogee://daily"], "not-a-string", "an array"],
  ["apogee://daily/" + "1".repeat(200), "too-long", "201 characters"],
  ["apogee://duel/" + "A".repeat(MAX_LINK_LENGTH), "too-long", "over the cap"],
  ["", "bad-characters", "empty"],
  ["apogee://duel/ABCD 2345", "bad-characters", "a space"],
  ["apogee://daily\n--inspect=9229", "bad-characters", "a newline and a switch"],
  ["apogee://daily\t", "bad-characters", "a tab"],
  ["apogee://daily\u0000", "bad-characters", "a NUL"],
  ["apogee://du\u0435l/ABCD2345", "bad-characters", "a Cyrillic homoglyph"],
  ["apogee://daily/14/novice\u200b", "bad-characters", "a zero-width space"],
  ["apogee://duel/%41BCD2345", "bad-characters", "percent-encoding"],
  ["apogee://daily%2F..%2F..", "bad-characters", "encoded traversal"],
  ["apogee://duel\\ABCD2345", "bad-characters", "a backslash"],
  [" apogee://daily", "bad-characters", "leading whitespace on a clicked link"],
  ["apogee://duel/ABCD2345\" --gpu-launcher=calc.exe \"", "bad-characters", "a quoted switch injection"],
  ["https://evil.example/apogee://daily", "not-apogee", "another scheme"],
  ["javascript:alert(1)", "not-apogee", "javascript:"],
  ["file:///C:/Windows/System32/calc.exe", "not-apogee", "file:"],
  ["apogee:duel/ABCD2345", "not-apogee", "no slashes"],
  ["apogee:/daily", "not-apogee", "one slash"],
  ["apogeex://daily", "not-apogee", "a longer scheme"],
  ["xapogee://daily", "not-apogee", "a prefixed scheme"],
  ["apogee://", "unknown-verb", "no verb"],
  ["apogee://settings/discord/on", "unknown-verb", "a settings verb"],
  ["apogee://open/C:/Windows/calc.exe", "unknown-verb", "an open-file verb"],
  ["apogee://eval/alert(1)", "unknown-verb", "an eval verb"],
  ["apogee://launch/calc", "unknown-verb", "a launch verb"],
  ["apogee://signout", "unknown-verb", "a sign-out verb"],
  ["apogee://shell?cmd=calc", "unknown-verb", "a shell verb with a query"],
  ["apogee://daily\"--inspect", "any", "a quote after the verb"],
  ["apogee://duel/ABCD234", "malformed", "seven characters"],
  ["apogee://duel/ABCD23456", "malformed", "nine characters"],
  ["apogee://duel/ABCD1234", "malformed", "a 1, outside the alphabet"],
  ["apogee://duel/ABCDO234", "malformed", "an O"],
  ["apogee://duel/ABCDI234", "malformed", "an I"],
  ["apogee://duel/ABCDL234", "malformed", "an L"],
  ["apogee://duel/ABCD-2345", "malformed", "a dash"],
  ["apogee://duel/ABCD2345?x=1", "malformed", "a query"],
  ["apogee://duel/ABCD2345#frag", "malformed", "a fragment"],
  ["apogee://duel/ABCD2345//", "malformed", "two trailing slashes"],
  ["apogee://duel/ABCD2345/extra", "malformed", "an extra segment"],
  ["apogee://duel/../../etc/passwd", "malformed", "path traversal"],
  ["apogee://duel/ABCD2345&calc", "malformed", "a shell ampersand"],
  ["apogee://duel/ABCD2345;rm", "malformed", "a semicolon"],
  ["apogee://duel/ABCD2345|calc", "malformed", "a pipe"],
  ["apogee://duel/$(calc)", "malformed", "a command substitution"],
  ["apogee://duel/`calc`", "malformed", "backticks"],
  ["apogee://ghost/", "malformed", "a ghost with no code"],
  ["apogee://duel", "malformed", "a duel with no code"],
  ["apogee://daily/0", "malformed", "Daily #0"],
  ["apogee://daily/007", "malformed", "a leading zero"],
  ["apogee://daily/100000", "malformed", "six digits"],
  ["apogee://daily/-1", "malformed", "a negative day"],
  ["apogee://daily/1e3", "malformed", "an exponent"],
  ["apogee://daily/14/elite", "malformed", "an unknown band"],
  ["apogee://daily/14/novice/extra", "malformed", "an extra segment after the band"],
  ["apogee://daily/novice", "malformed", "a band with no number"],
  ["apogee://daily/14?band=novice", "malformed", "a band as a query"],
  ["apogee://daily/14/<script>", "malformed", "markup"],
];
for (const [input, reason, label] of REFUSED) {
  const r = parseDeepLink(input);
  check(`refuses ${label}${reason === "any" ? "" : ` (${reason})`}`, !r.ok && (reason === "any" || r.reason === reason), JSON.stringify(r));
}
check("every refusal has a sentence, and none repeats the link", REFUSED.every(([input]) => {
  const r = parseDeepLink(input);
  return !r.ok && typeof REFUSAL_TEXT[r.reason] === "string" && (typeof input !== "string" || input.length < 4 || !REFUSAL_TEXT[r.reason].includes(input));
}));

// ---------------------------------------------------------------------------
section("argv: first launch and second-instance");
// ---------------------------------------------------------------------------
const argvCases: [string, unknown, DeepLink | null | "refused"][] = [
  ["Windows first launch", ["C:\\Program Files\\Apogee\\Apogee.exe", "apogee://duel/ABCD2345"], { kind: "duel", code: "ABCD2345" }],
  ["second-instance with Chromium switches around it", ["C:\\Apogee\\Apogee.exe", "--allow-file-access-from-files", "--original-process-start-time=13360000000000000", "apogee://daily/14/advanced/", "--enable-features=X"], { kind: "daily", number: 14, band: "advanced" }],
  ["a development launch (electron .)", ["/usr/lib/electron/electron", ".", "apogee://ghost/ABCD2345"], { kind: "ghost", code: "ABCD2345" }],
  ["a scheme in capitals", ["Apogee.exe", "APOGEE://DAILY"], { kind: "daily", number: null, band: null }],
  ["no link", ["Apogee.exe", "--smoke"], null],
  ["an empty argv", [], null],
  ["not an array", "apogee://daily", null],
  ["two links", ["Apogee.exe", "apogee://daily", "apogee://duel/ABCD2345"], "refused"],
  ["a link with a switch inside the same argument", ["Apogee.exe", "apogee://daily --inspect=9229"], "refused"],
  ["a malformed link", ["Apogee.exe", "apogee://duel/ABCD1234"], "refused"],
  ["an unknown verb", ["Apogee.exe", "apogee://settings/discord/on"], "refused"],
  ["a switch whose value is a link", ["Apogee.exe", "--open=apogee://duel/ABCD2345"], null],
  ["non-strings among the arguments", ["Apogee.exe", 7, null, { x: 1 }, "apogee://daily/3"], { kind: "daily", number: 3, band: null }],
  ["a link past the 64th argument", [...Array.from({ length: 70 }, (_, i) => `--switch-${i}`), "apogee://daily"], null],
];
for (const [label, argv, want] of argvCases) {
  const r = linkFromArgv(argv);
  const ok = want === null ? r === null : want === "refused" ? r !== null && !r.ok : !!r && r.ok && same(r.link, want);
  check(`argv: ${label}`, ok, JSON.stringify(r));
}

// ---------------------------------------------------------------------------
section("https landing and pasted links");
// ---------------------------------------------------------------------------
const pasteCases: [string, DeepLink | null][] = [
  [`${LANDING_BASE}?duel=ABCD2345`, { kind: "duel", code: "ABCD2345" }],
  [`  ${LANDING_BASE}?daily=14&band=novice \n`, { kind: "daily", number: 14, band: "novice" }],
  [`${LANDING_BASE}?daily`, { kind: "daily", number: null, band: null }],
  [`${LANDING_BASE}?ghost=abcd2345`, { kind: "ghost", code: "ABCD2345" }],
  ["apogee://duel/ABCD2345", { kind: "duel", code: "ABCD2345" }],
  [`${LANDING_BASE}?duel=ABCD2345&x=1`, null],
  [`${LANDING_BASE}?band=novice&daily=14`, null],
  [`${LANDING_BASE}?duel=ABCD1234`, null],
  [`${LANDING_BASE}?duel=%41BCD2345`, null],
  [`${LANDING_BASE}`, null],
  [`${LANDING_BASE}evil?duel=ABCD2345`, null],
  ["https://swarlesgnb.github.io.evil.example/Apogee-1v1s/c/?duel=ABCD2345", null],
  ["https://example.com/c/?duel=ABCD2345", null],
  ["javascript:alert(1)", null],
  ["ABCD2345", null],
  ["x".repeat(500), null],
];
for (const [text, want] of pasteCases) {
  const r = parsePastedLink(text);
  check(`paste: ${JSON.stringify(text.length > 70 ? text.slice(0, 40) + "…" : text)}`, want === null ? !r.ok : r.ok && same(r.link, want), JSON.stringify(r));
}
check("a landing query is read under the same rules", parseLandingQuery("daily=14&band=expert").ok && !parseLandingQuery("daily=14&band=expert&evil=1").ok && !parseLandingQuery(42).ok);

// ---------------------------------------------------------------------------
section("open challenges: codes, the view, refusals");
// ---------------------------------------------------------------------------
let allMap = true;
for (let b = 0; b < 256; b++) if (!CODE_ALPHABET.includes(mintCode(new Uint8Array(8).fill(b))[0])) allMap = false;
check("every byte value mints a letter of the alphabet", allMap);
let shapeOk = true;
for (let i = 0; i < 500; i++) {
  const bytes = new Uint8Array(8).map(() => Math.floor(Math.random() * 256));
  if (!isOpenDuelCode(mintCode(bytes))) shapeOk = false;
}
check("500 minted codes all have the code shape", shapeOk);
check("a lowercase or short code is not a code", !isOpenDuelCode("abcd2345") && !isOpenDuelCode("ABCD234") && !isOpenDuelCode(null));

const facts = (over: Partial<OpenDuelFacts> = {}): OpenDuelFacts => ({
  challengerId: "challenger", status: "open", expiresAt: new Date("2026-10-10T00:00:00Z"), ready: true,
  challengerMatchVoid: false, answers: 0, alreadyAnswered: false, ...over,
});
const now = new Date("2026-10-05T00:00:00Z");
const refusal = (f: OpenDuelFacts, who = "answerer") => {
  const r = canAnswerOpenDuel(f, who, now);
  return r.ok ? "ok" : r.refusal;
};
check("an answerable challenge can be answered", refusal(facts()) === "ok");
check("your own is refused first, whatever its state", refusal(facts({ status: "cancelled", ready: false }), "challenger") === "own");
check("a taken-back challenge is closed", refusal(facts({ status: "cancelled" })) === "closed");
check("past its deadline it is expired, whatever the stored status says", refusal(facts({ expiresAt: new Date("2026-10-01T00:00:00Z") })) === "expired");
check("a challenger who left their own match leaves nothing to answer", refusal(facts({ challengerMatchVoid: true, ready: false })) === "void");
check("before the challenger has played, it waits", refusal(facts({ ready: false })) === "waiting");
check("a second answer by the same player is refused", refusal(facts({ alreadyAnswered: true })) === "answered");
check(`the ${OPEN_DUEL_MAX_ANSWERS + 1}st answer is refused`, refusal(facts({ answers: OPEN_DUEL_MAX_ANSWERS })) === "full" && refusal(facts({ answers: OPEN_DUEL_MAX_ANSWERS - 1 })) === "ok");

const view = openDuelView({ code: "ABCD2345", senderName: "  A very long Steam display name that goes on and on  ", category: "Precise Tracking", band: "Intermediate", facts: facts(), callerId: "answerer", now });
check("the view has exactly the documented keys", same(Object.keys(view).sort(), [...OPEN_DUEL_VIEW_KEYS]));
check("and no score, delta, id or run anywhere in it", !/score|delta|player_?id|run_?id|match_?id|challenger/i.test(JSON.stringify(Object.keys(view))));
check("the sender's name is trimmed to 32", view.from.length === 32 && !view.from.startsWith(" "));
check("it is always unrated", view.unrated === true && isOpenDuelView(view));
check("a view with an extra field is refused by the client", !isOpenDuelView({ ...view, challengerScore: 0.04 }));
check("a view missing a field is refused by the client", !isOpenDuelView({ ...view, unrated: undefined }));
check("your own view says so and why you cannot answer", (() => {
  const own = openDuelView({ code: "ABCD2345", senderName: "me", category: "x", band: "y", facts: facts(), callerId: "challenger", now });
  return own.yours && typeof own.refusal === "string" && /own/.test(own.refusal);
})());

// ---------------------------------------------------------------------------
section("where link text may go (read from the source)");
// ---------------------------------------------------------------------------
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
/** Code only: comments may name the sinks they promise never to reach. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const social = code(read("../../app/social.ts"));
const main = read("../../app/main.ts");
const renderer = read("../../app/renderer/social.js");
const preload = read("../../app/preload.cjs");
check("social.ts imports no shell, child_process or fs", !/from "electron";/.test(social) || !/\bshell\b/.test(social.match(/import \{[^}]*\} from "electron"/)?.[0] ?? ""));
check("social.ts never calls openExternal, exec, spawn, eval, Function, loadURL or readFile", !/openExternal|child_process|\bexec\(|\bspawn\(|\beval\(|new Function|loadURL|readFile|writeFile/.test(social));
check("every link is parsed before anything else sees it", /linkFromArgv\(argv\)/.test(social) && /parseDeepLink\(raw\)/.test(social) && /parsePastedLink\(/.test(social));
check("a refused link is reported by rule, never echoed", /deps\.notify\(REFUSAL_TEXT\[parsed\.reason\]\)/.test(social));
check("confirming acts on main's own proposal, by id", /if \(!pending \|\| pending\.id !== id\)/.test(social) && /const p = pending;/.test(social));
check("the renderer's confirmation carries an id and nothing else", /linkAction\(\{ type: 'confirm', id \}\)/.test(renderer) && !/type: 'confirm', id,? (code|link)/.test(renderer));
check("second-instance hands its argv to the link parser and nowhere else", /app\.on\("second-instance", \(_event, argv\) => \{[\s\S]*?social\.receiveArgv\(argv\);\s*\}\);/.test(main));
check("macOS open-url goes through the same parser", /app\.on\("open-url", \(event, url\) => \{\s*event\.preventDefault\(\);\s*social\.receive\(url, "open-url"\);/.test(main));
check("the first launch's argv goes through it too", /social\.receiveArgv\(process\.argv\)/.test(main));
check("the preload exposes link actions, not a generic channel", /linkAction: \(action\) => ipcRenderer\.invoke\("apogee:linkAction", action\)/.test(preload));
check("the protocol is registered only by a packaged build", /if \(!app\.isPackaged\) return;/.test(social));
check("the renderer escapes everything it draws", /const e = \(v\) => String\(v \?\? ''\)\.replace\(\/\[&<>"'\]\/g/.test(renderer));

console.log(`\n${failures === 0 ? "OK" : "FAILED"}: ${checks - failures} of ${checks} link checks passed`);
if (failures > 0) process.exit(1);

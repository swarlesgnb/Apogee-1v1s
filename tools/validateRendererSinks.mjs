/**
 * No player-controlled name reaches an HTML sink unescaped (audit SEC-09).
 *
 *   node tools/validateRendererSinks.mjs
 *
 * Display names, tournament entrants and opponents are written by other players. Every
 * renderer path that shows one today escapes it (`esc` in renderer.js, `e` in ghost.js and
 * share.js) or assigns it with `textContent`, so nothing fires. This keeps it that way: it
 * reads every statement that writes HTML (`innerHTML =`, `innerHTML +=`, `outerHTML =`,
 * `insertAdjacentHTML(`, `document.write(`) in the renderer, removes string literals and
 * whatever passes through an escape helper, and fails on a player-controlled field left
 * over.
 *
 * Deliberately narrow, so it has no false positives to wave through: it knows the fields
 * that carry another player's words by name, and follows no variables. A name copied into
 * a local first and then interpolated is not seen. That is the line between a guard that
 * runs in CI and a triage list somebody reads by hand (the audit's poc/sinks.mjs, which
 * flags twenty-five sites on this code and every one is safe).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Fields whose value another player chose. */
const PLAYER_FIELDS = /\b(displayName|display_name|opponentName|playerName|hostName|entrantName|challengerName|kovaaksUsername)\b/;
/** Calls whose result is safe to put in HTML. */
const ESCAPES = ["esc", "e", "escapeHtml", "escHtml", "escapeAttr"];
const SINK = /(\.innerHTML\s*\+?=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\()/g;

/**
 * The expression a sink writes: from the sink to the end of its statement. Tracks
 * brackets, strings, template interpolations and comments, so a quote inside `${...}`
 * or an apostrophe in a comment cannot carry the scan past the statement.
 */
function statementAt(src, from) {
  const stack = [];
  let quote = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (quote === "`" && c === "$" && src[i + 1] === "{") { stack.push("${"); quote = null; i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { const nl = src.indexOf("\n", i); i = nl < 0 ? src.length : nl; continue; }
    if (c === "/" && src[i + 1] === "*") { const close = src.indexOf("*/", i + 2); i = close < 0 ? src.length : close + 1; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "(" || c === "[" || c === "{") stack.push(c);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.length === 0) return src.slice(from, i);
      if (stack.pop() === "${") quote = "`";
    } else if (c === ";" && stack.length === 0) return src.slice(from, i);
  }
  return src.slice(from);
}

/** Remove escaped calls (balanced), then every string literal's text but not its interpolations. */
function unescapedRemainder(stmt) {
  let out = stmt;
  for (let pass = 0; pass < 10; pass++) {
    const before = out;
    for (const fn of ESCAPES) {
      const re = new RegExp(`(^|[^\\w$.])${fn}\\(`, "g");
      let m;
      while ((m = re.exec(out))) {
        const open = m.index + m[0].length - 1;
        let depth = 0;
        let end = open;
        for (; end < out.length; end++) {
          if (out[end] === "(") depth++;
          else if (out[end] === ")" && --depth === 0) break;
        }
        out = out.slice(0, m.index + m[1].length) + '""' + out.slice(end + 1);
        re.lastIndex = m.index + m[1].length + 2;
      }
    }
    if (out === before) break;
  }
  // Plain string literals carry no code.
  out = out.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""');
  // Template literals keep only what is interpolated.
  out = out.replace(/`(?:[^`\\]|\\.)*`/g, (t) => (t.match(/\$\{[^}]*\}/g) ?? []).join(" + "));
  return out;
}

export function findUnescapedSinks(src, file = "<inline>") {
  const hits = [];
  for (const m of src.matchAll(SINK)) {
    const stmt = statementAt(src, m.index + m[0].length);
    const rest = unescapedRemainder(stmt);
    const field = PLAYER_FIELDS.exec(rest);
    if (field) hits.push(`${file}:${src.slice(0, m.index).split("\n").length}: ${field[1]} written into HTML unescaped`);
  }
  return hits;
}

// ---- the guard's own controls: it must catch these, and must pass these -------------
const caught = [
  `el.innerHTML = "<b>" + opponent.displayName + "</b>";`,
  "el.innerHTML = `<b>${duel.from.displayName}</b>`;",
  `row.insertAdjacentHTML("beforeend", "<td>" + entrant.display_name + "</td>");`,
  "list.innerHTML += `<li>${p.playerName} ${esc(p.rating)}</li>`;",
  "card.outerHTML = '<div>' + leg.opponentName + '</div>';",
];
for (const snippet of caught) assert.equal(findUnescapedSinks(snippet).length, 1, `the guard catches: ${snippet}`);
const allowed = [
  `el.innerHTML = "<b>" + esc(opponent.displayName) + "</b>";`,
  "el.innerHTML = `<b>${esc(duel.from.displayName)}</b>`;",
  `row.insertAdjacentHTML("beforeend", "<td>" + e(entrant.display_name) + "</td>");`,
  `name.textContent = person.displayName;`,
  `el.innerHTML = '<span class="opponent-monogram">' + esc(tnInitials(match.opponent.displayName)) + "</span>";`,
  `el.innerHTML = "<p>displayName is shown elsewhere</p>";`,
];
for (const snippet of allowed) assert.deepEqual(findUnescapedSinks(snippet), [], `the guard allows: ${snippet}`);

// ---- the renderer --------------------------------------------------------------------
const dir = "src/app/renderer";
const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
let sinks = 0;
const hits = [];
for (const f of files) {
  const src = readFileSync(join(dir, f), "utf8");
  sinks += [...src.matchAll(SINK)].length;
  hits.push(...findUnescapedSinks(src, join(dir, f)));
}
assert.ok(sinks > 50, `the scan found the renderer's HTML sinks (${sinks})`);

// And on the real code: drop the escape from one name the renderer really writes as HTML
// (the duel roster row), and the guard must see it.
const renderer = readFileSync(join(dir, "renderer.js"), "utf8");
assert.ok(renderer.includes("esc(e.displayName)"), "the roster row still escapes its name");
assert.equal(findUnescapedSinks(renderer.replace("esc(e.displayName)", "e.displayName")).length, 1,
  "removing one real escape is caught");
if (hits.length) {
  console.error(hits.join("\n"));
  console.error("\nEscape the value with the file's helper (esc / e) or assign it with textContent.");
  process.exit(1);
}
console.log(`OK: ${sinks} HTML sinks in ${files.length} renderer files; no player-controlled name is written unescaped (guard controls: ${caught.length} caught, ${allowed.length} allowed)`);

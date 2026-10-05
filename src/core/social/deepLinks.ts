/**
 * Challenge links: what an `apogee://` link may say, and nothing else.
 *
 * Deep-link text is attacker-controlled. Anybody can post a link, and the operating system
 * hands whatever follows `apogee:` to the app on the command line. So a link is parsed
 * against an allow-list grammar, whole-string, before any part of it is used:
 *
 *   apogee://duel/<code>                      an open challenge, by its code
 *   apogee://ghost/<code>                     a ghost card's code, to race
 *   apogee://daily                            today's Apogee Daily
 *   apogee://daily/<n>                        Apogee Daily #n
 *   apogee://daily/<n>/<band>                 ... in one band
 *
 * A code is eight letters from the ghost-code alphabet (no 0, O, 1, I or L); a daily
 * number is 1 to 99999 with no leading zero; a band is one of four fixed words. One
 * trailing slash is forgiven, because Windows and some browsers add one. Everything else
 * is refused: any other verb, any query or fragment, any percent-encoding, whitespace or
 * character outside printable ASCII, anything over MAX_LINK_LENGTH.
 *
 * What a parsed link may then do is propose. The app shows what it found and the player
 * confirms it in the UI; a link never starts a match, accepts anything or changes a
 * setting on its own. And link text never reaches a shell, `shell.openExternal`, a file
 * path or `eval`: only the parsed values do, and only into the confirmation and the
 * server lookups that need them.
 *
 * Pure, with no Electron import, so validate:links drives every case and the https
 * landing page bundles the same parser it shows to visitors.
 */

import { BAND_SLUGS, isDailyNumber, type BandSlug } from "./daily.ts";

export const PROTOCOL = "apogee";

/** Longer than any link this grammar can produce (apogee://daily/99999/intermediate is 34). */
export const MAX_LINK_LENGTH = 128;

/** The ghost-code alphabet (links.ts LINK_CODE_SHAPE), the one a duel code uses too. */
const CODE = "[2-9A-HJKMNP-Z]{8}";
export const CODE_SHAPE = new RegExp(`^${CODE}$`);

/**
 * Where an https link lands: a static page on the project site (`npm run build:site`
 * writes it to site/c/index.html) that says what the link is and offers "Open in Apogee"
 * and the download. Social sites do not make an `apogee://` link clickable, so a post
 * carries this instead.
 */
export const LANDING_BASE = "https://swarlesgnb.github.io/Apogee-1v1s/c/";

export type DeepLink =
  | { kind: "duel"; code: string }
  | { kind: "ghost"; code: string }
  | { kind: "daily"; number: number | null; band: BandSlug | null };

export type LinkRefusal = "not-a-string" | "too-long" | "bad-characters" | "not-apogee" | "unknown-verb" | "malformed";

export type LinkParse = { ok: true; link: DeepLink } | { ok: false; reason: LinkRefusal };

const CODE_LINK = new RegExp(`^apogee://(duel|ghost)/(${CODE})/?$`, "i");
const DAILY_LINK = new RegExp(`^apogee://daily(?:/([1-9][0-9]{0,4})(?:/(${BAND_SLUGS.join("|")}))?)?/?$`, "i");
const VERB = /^apogee:\/\/([a-z]+)(?:[/?#]|$)/i;
/** Printable ASCII with no space. A link with anything else in it is not one this app wrote. */
const PRINTABLE = /^[\x21-\x7e]+$/;

const refuse = (reason: LinkRefusal): LinkParse => ({ ok: false, reason });

/** Parse an `apogee://` link, or say which rule it broke. */
export function parseDeepLink(raw: unknown): LinkParse {
  if (typeof raw !== "string") return refuse("not-a-string");
  if (raw.length > MAX_LINK_LENGTH) return refuse("too-long");
  if (!PRINTABLE.test(raw) || raw.includes("%") || raw.includes("\\")) return refuse("bad-characters");
  if (!/^apogee:\/\//i.test(raw)) return refuse("not-apogee");

  const code = CODE_LINK.exec(raw);
  if (code) {
    const kind = code[1].toLowerCase() as "duel" | "ghost";
    return { ok: true, link: { kind, code: code[2].toUpperCase() } };
  }
  const daily = DAILY_LINK.exec(raw);
  if (daily) {
    const number = daily[1] ? Number(daily[1]) : null;
    if (number !== null && !isDailyNumber(number)) return refuse("malformed");
    const band = daily[2] ? (daily[2].toLowerCase() as BandSlug) : null;
    return { ok: true, link: { kind: "daily", number, band } };
  }
  const verb = VERB.exec(raw)?.[1]?.toLowerCase();
  return refuse(verb === "duel" || verb === "ghost" || verb === "daily" ? "malformed" : "unknown-verb");
}

/** The canonical `apogee://` spelling of a parsed link: what "Open in Apogee" points at. */
export function deepLinkUrl(link: DeepLink): string {
  if (link.kind === "daily") {
    if (link.number === null) return `${PROTOCOL}://daily`;
    return `${PROTOCOL}://daily/${link.number}${link.band ? `/${link.band}` : ""}`;
  }
  return `${PROTOCOL}://${link.kind}/${link.code}`;
}

/** The https spelling: what a post carries, landing on the project site. */
export function landingUrl(link: DeepLink): string {
  if (link.kind === "daily") {
    if (link.number === null) return `${LANDING_BASE}?daily`;
    return `${LANDING_BASE}?daily=${link.number}${link.band ? `&band=${link.band}` : ""}`;
  }
  return `${LANDING_BASE}?${link.kind}=${link.code}`;
}

const LANDING_QUERY_CODE = new RegExp(`^(duel|ghost)=(${CODE})$`, "i");
const LANDING_QUERY_DAILY = new RegExp(`^daily(?:=([1-9][0-9]{0,4})(?:&band=(${BAND_SLUGS.join("|")}))?)?$`, "i");

/**
 * A landing page's query string (without the `?`) as a link, under the same rules: what
 * the page reads from `location.search`, and what the app accepts when an https link is
 * pasted into it rather than clicked.
 */
export function parseLandingQuery(query: unknown): LinkParse {
  if (typeof query !== "string") return refuse("not-a-string");
  if (query.length > MAX_LINK_LENGTH) return refuse("too-long");
  if (!PRINTABLE.test(query) || query.includes("%")) return refuse("bad-characters");
  const code = LANDING_QUERY_CODE.exec(query);
  if (code) return { ok: true, link: { kind: code[1].toLowerCase() as "duel" | "ghost", code: code[2].toUpperCase() } };
  const daily = LANDING_QUERY_DAILY.exec(query);
  if (daily) {
    const number = daily[1] ? Number(daily[1]) : null;
    if (number !== null && !isDailyNumber(number)) return refuse("malformed");
    return { ok: true, link: { kind: "daily", number, band: daily[2] ? (daily[2].toLowerCase() as BandSlug) : null } };
  }
  return refuse("malformed");
}

/**
 * Anything a player pastes into the app's "Open a link" field: an `apogee://` link, or the
 * https landing link a post carries. Leading and trailing whitespace is forgiven (it
 * comes along with a copy); nothing inside is.
 */
export function parsePastedLink(raw: unknown): LinkParse {
  if (typeof raw !== "string") return refuse("not-a-string");
  const text = raw.trim();
  if (text.length > MAX_LINK_LENGTH) return refuse("too-long");
  if (/^apogee:/i.test(text)) return parseDeepLink(text);
  if (text.startsWith(LANDING_BASE)) {
    const rest = text.slice(LANDING_BASE.length);
    if (!rest.startsWith("?")) return refuse("malformed");
    return parseLandingQuery(rest.slice(1));
  }
  return refuse("not-apogee");
}

/**
 * The link a process was launched with, from its argv.
 *
 * On Windows and Linux the operating system starts the app (or a second instance, which
 * hands its argv to the first through `second-instance`) with the link as one argument.
 * Electron and Chromium add switches of their own, and the development launch adds the
 * app path, so only arguments that start with the scheme are considered. Exactly one is
 * honoured; none means no link, and two or more means something built this command line
 * by hand, so none of them is trusted.
 */
export function linkFromArgv(argv: unknown): LinkParse | null {
  if (!Array.isArray(argv)) return null;
  const candidates = argv.slice(0, 64).filter((a): a is string => typeof a === "string" && /^apogee:/i.test(a));
  if (candidates.length === 0) return null;
  if (candidates.length > 1) return refuse("malformed");
  return parseDeepLink(candidates[0]);
}

/** One sentence per refusal, for the notice a refused link leaves behind. */
export const REFUSAL_TEXT: Record<LinkRefusal, string> = {
  "not-a-string": "That link could not be read.",
  "too-long": "That link is too long to be an Apogee link.",
  "bad-characters": "That link has characters an Apogee link never has.",
  "not-apogee": "That is not an Apogee link.",
  "unknown-verb": "That Apogee link asks for something this version does not do.",
  malformed: "That Apogee link is not complete or not in a shape this version knows.",
};

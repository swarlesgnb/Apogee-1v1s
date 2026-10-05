/**
 * Open challenges: a duel addressed to whoever has the code.
 *
 * A named duel (duels.ts) is a match aimed at one player, and it is rated, because both
 * people agreed to it by name. An open challenge is the same seeding match with a code
 * instead of a name, posted where anybody can read it. That is exactly the invitation an
 * alt account wants: answer your own link from a second Steam account, lose on purpose,
 * gift the win. So every answer to an open challenge is an UNRATED match
 * (`matches.rated = false`, the path tournament fixtures already take), and the
 * challenger's original run set stays an ordinary seeding match. Nothing a link does
 * moves anybody's rating.
 *
 * Shape, kept close to the named duel so settlement, verification and the match clock
 * are untouched:
 *
 *   create   the challenger plays first: the seeding match send-duel makes, plus a
 *            `duels` row with a code and no named opponent.
 *   view     anyone signed in may read what the code is for: who sent it, the category
 *            and band, whether it can be answered yet. Never the challenger's score, for
 *            the reason a named duel hides it (PLAN.md §6): answering is decided blind.
 *   accept   builds an unrated two-sided match from the challenger's frozen side, once
 *            per answering player; many players may answer one code.
 *
 * The decisions are here, pure, so validate:social-functions can drive them through the
 * Edge Function and the table of refusals below stays readable.
 */

import { CODE_SHAPE } from "./deepLinks.ts";

/** How long an open challenge takes answers. A named duel's seven days, for the same reason. */
export { DUEL_TTL_MS as OPEN_DUEL_TTL_MS } from "../match/duels.ts";

/**
 * Most answers one code takes. A link that escapes into a large channel should not mint
 * thousands of matches against one run set; two hundred is more than any honest post
 * draws at Apogee's size and bounds what one does.
 */
export const OPEN_DUEL_MAX_ANSWERS = 200;

/** The ghost-code alphabet: no 0/O or 1/I/L, because a code is read off a screenshot. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LENGTH = 8;

/** A fresh code from random bytes (crypto.getRandomValues on either runtime). */
export function mintCode(bytes: Uint8Array): string {
  if (bytes.length < CODE_LENGTH) throw new Error("mintCode needs eight random bytes");
  // 256 is not a multiple of 31, so this leans very slightly toward the first letters, as
  // post-ghost's does. A code has to be hard to guess, not uniform; 31^8 is 8.5e11.
  return [...bytes.slice(0, CODE_LENGTH)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export function isOpenDuelCode(code: unknown): code is string {
  return typeof code === "string" && CODE_SHAPE.test(code);
}

export type OpenDuelStatus = "open" | "accepted" | "declined" | "cancelled" | "expired";

/** What the server knows about an open challenge when somebody asks about it. */
export interface OpenDuelFacts {
  challengerId: string;
  status: OpenDuelStatus;
  expiresAt: Date;
  /** The challenger has played their three (their side carries a match score). */
  ready: boolean;
  /** The challenger's own match ended without a result (left early, voided). */
  challengerMatchVoid: boolean;
  answers: number;
  /** The caller has already answered this code once. */
  alreadyAnswered: boolean;
}

export type OpenDuelRefusal =
  | "own"
  | "closed"
  | "expired"
  | "void"
  | "waiting"
  | "answered"
  | "full";

export const OPEN_DUEL_REFUSAL: Record<OpenDuelRefusal, { status: number; message: string }> = {
  own: { status: 409, message: "That is your own open challenge. Post the link for somebody else to answer." },
  closed: { status: 410, message: "That challenge was taken back by the player who sent it." },
  expired: { status: 410, message: "That challenge has expired." },
  void: { status: 410, message: "That challenge has no result to answer: the player who sent it did not finish their three." },
  waiting: { status: 409, message: "The player who sent it has not finished their three yet. Try again later." },
  answered: { status: 409, message: "You have already answered this challenge." },
  full: { status: 409, message: "That challenge has taken all the answers it can." },
};

/** The status a stored open challenge should be read as, applying expiry without writing it. */
export function effectiveOpenStatus(f: Pick<OpenDuelFacts, "status" | "expiresAt">, now: Date): OpenDuelStatus {
  return f.status === "open" && f.expiresAt.getTime() <= now.getTime() ? "expired" : f.status;
}

/**
 * May this caller answer this open challenge now?
 *
 * Order matters, as in duels.ts: identity first (your own code is refused before anything
 * about its state is said), then whether the challenge still exists in any useful sense,
 * then whether it can be answered yet, then whether this caller already has.
 */
export function canAnswerOpenDuel(f: OpenDuelFacts, callerId: string, now: Date): { ok: true } | { ok: false; refusal: OpenDuelRefusal } {
  if (callerId === f.challengerId) return { ok: false, refusal: "own" };
  const status = effectiveOpenStatus(f, now);
  if (status === "cancelled" || status === "declined") return { ok: false, refusal: "closed" };
  if (status === "expired" || status === "accepted") return { ok: false, refusal: "expired" };
  if (f.challengerMatchVoid) return { ok: false, refusal: "void" };
  if (!f.ready) return { ok: false, refusal: "waiting" };
  if (f.alreadyAnswered) return { ok: false, refusal: "answered" };
  if (f.answers >= OPEN_DUEL_MAX_ANSWERS) return { ok: false, refusal: "full" };
  return { ok: true };
}

/** What `view` sends: enough to decide, and no score. The keys are held by validate:links. */
export interface OpenDuelView {
  code: string;
  from: string;
  category: string;
  band: string;
  status: OpenDuelStatus;
  ready: boolean;
  expiresAt: string;
  answers: number;
  /** The caller sent it. */
  yours: boolean;
  answered: boolean;
  /** Always true: an answer to an open challenge never moves a rating. */
  unrated: true;
  /** Why the caller cannot answer it now, or null when they can. */
  refusal: string | null;
}

export const OPEN_DUEL_VIEW_KEYS = [
  "answered", "answers", "band", "category", "code", "expiresAt", "from", "ready", "refusal", "status", "unrated", "yours",
] as const;

/** Longest sender name sent, as links.ts: display names come from Steam and can be anything. */
const SENDER_MAX = 32;

export function openDuelView(input: {
  code: string;
  senderName: string | null;
  category: string;
  band: string;
  facts: OpenDuelFacts;
  callerId: string;
  now: Date;
}): OpenDuelView {
  const { facts, callerId, now } = input;
  const verdict = canAnswerOpenDuel(facts, callerId, now);
  return {
    code: input.code,
    from: (input.senderName ?? "").trim().slice(0, SENDER_MAX) || "A player",
    category: input.category,
    band: input.band,
    status: effectiveOpenStatus(facts, now),
    ready: facts.ready,
    expiresAt: facts.expiresAt.toISOString(),
    answers: facts.answers,
    yours: callerId === facts.challengerId,
    answered: facts.alreadyAnswered,
    unrated: true,
    refusal: verdict.ok ? null : OPEN_DUEL_REFUSAL[verdict.refusal].message,
  };
}

/** Whether a server answer is a view this client can draw, key for key. */
export function isOpenDuelView(value: unknown): value is OpenDuelView {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== [...OPEN_DUEL_VIEW_KEYS].join()) return false;
  return (
    isOpenDuelCode(v.code) &&
    typeof v.from === "string" && v.from.length > 0 && v.from.length <= SENDER_MAX &&
    typeof v.category === "string" && v.category.length <= 40 &&
    typeof v.band === "string" && v.band.length <= 40 &&
    typeof v.ready === "boolean" && typeof v.yours === "boolean" && typeof v.answered === "boolean" &&
    v.unrated === true &&
    typeof v.answers === "number" && Number.isInteger(v.answers) && v.answers >= 0 &&
    typeof v.expiresAt === "string" &&
    (v.refusal === null || typeof v.refusal === "string") &&
    ["open", "accepted", "declined", "cancelled", "expired"].includes(v.status as string)
  );
}

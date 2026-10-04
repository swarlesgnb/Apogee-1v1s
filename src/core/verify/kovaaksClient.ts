/**
 * Read-only client for KovaaK's public backend.
 *
 * Two endpoints carry the whole verification model:
 *
 *   user/search
 *     username -> { steamId, ... }. Used once, at link time, to prove that the
 *     KovaaK's account a player claims really belongs to the SteamID they signed in
 *     with. Without that proof a player could name someone else's account and inherit
 *     their scores.
 *
 *   user/scenario/last-scores/by-name
 *     The player's ~10 most recent runs on a scenario, each with `hash`, `epoch`,
 *     `challengeStart` and `modelOverrides`. This is better than it sounds: an earlier
 *     draft of the plan assumed only personal bests were retrievable, which would have
 *     left every sub-PB match run unverifiable. Recent runs being available means a
 *     match run can be matched against a server record whether or not it was a PB.
 *
 * The caveat, which is real: both are keyed on a KovaaK's **webapp** username, and that
 * account is a separate registration from Steam. Players who have never registered on
 * kovaaks.com return empty, and for them only local checks and the benchmark-progress
 * endpoint are available. Verification degrades to the Consistent tier rather than
 * failing.
 */

import { matchesServerEvidence, sameRunAs, type RunEvidence } from "./serverEvidence.ts";

const BASE = "https://kovaaks.com/webapp-backend";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36";

export interface KovaaksUser {
  steamId: string;
  username: string;
  steamAccountName: string;
  steamAccountAvatar: string | null;
  country: string | null;
}

export interface KovaaksScore {
  score: number;
  hash: string | null;
  challengeStart: string | null;
  /** Milliseconds since epoch. The API returns this as a string in some responses. */
  epoch: number | null;
  kills: number | null;
  avgFps: number | null;
  cm360: number | null;
  resolution: string | null;
  /** True when non-default target models or skins were in use for the run. */
  hasModelOverrides: boolean;
}

export interface FetchOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;

async function getJson(
  url: string,
  options: FetchOptions = {},
): Promise<unknown | null> {
  const impl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await impl(url, {
      headers: { "User-Agent": UA, accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // KovaaK's being unreachable must degrade verification, never break submission.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Look up a KovaaK's webapp account by username. */
export async function findUser(
  username: string,
  options?: FetchOptions,
): Promise<KovaaksUser | null> {
  const url = `${BASE}/user/search?username=${encodeURIComponent(username)}`;
  const data = await getJson(url, options);
  if (!Array.isArray(data) || data.length === 0) return null;

  // The search is fuzzy; only an exact, case-insensitive match is the account claimed.
  const exact = data.find(
    (u) => typeof u?.username === "string" && u.username.toLowerCase() === username.toLowerCase(),
  );
  const row = exact ?? null;
  if (!row) return null;

  return {
    steamId: String(row.steamId),
    username: String(row.username),
    steamAccountName: String(row.steamAccountName ?? ""),
    steamAccountAvatar: row.steamAccountAvatar ?? null,
    country: row.country ?? null,
  };
}

/**
 * Confirm that a claimed KovaaK's username really belongs to a SteamID.
 *
 * This is the binding the whole anti-cheat model rests on, so it is checked against
 * KovaaK's rather than trusted from the client.
 */
export async function verifyAccountLink(
  username: string,
  steamId: string,
  options?: FetchOptions,
): Promise<{ linked: boolean; user: KovaaksUser | null; reason?: string }> {
  const user = await findUser(username, options);
  if (!user) return { linked: false, user: null, reason: "no such KovaaK's account" };
  if (user.steamId !== steamId) {
    return { linked: false, user, reason: "that KovaaK's account belongs to a different Steam account" };
  }
  return { linked: true, user };
}

function normaliseScore(row: Record<string, unknown>): KovaaksScore | null {
  const attributes = (row.attributes ?? {}) as Record<string, unknown>;
  const score = toNumber(row.score ?? attributes.score);
  if (score == null) return null;

  const overrides = attributes.modelOverrides as
    | Record<string, { model?: string; skin?: string }>
    | undefined;

  const hasModelOverrides = overrides
    ? Object.values(overrides).some(
        (o) => (o?.model && o.model !== "None") || (o?.skin && o.skin !== "None"),
      )
    : false;

  return {
    score,
    hash: (attributes.hash as string) ?? null,
    challengeStart: (attributes.challengeStart as string) ?? null,
    epoch: toNumber(attributes.epoch),
    kills: toNumber(attributes.kills),
    avgFps: toNumber(attributes.avgFps),
    cm360: toNumber(attributes.cm360),
    resolution: (attributes.resolution as string) ?? null,
    hasModelOverrides,
  };
}

/** The player's most recent server-side runs for one scenario, newest first. */
export async function recentScores(
  username: string,
  scenarioName: string,
  options?: FetchOptions,
): Promise<KovaaksScore[]> {
  const url =
    `${BASE}/user/scenario/last-scores/by-name` +
    `?username=${encodeURIComponent(username)}` +
    `&scenarioName=${encodeURIComponent(scenarioName)}`;

  const data = await getJson(url, options);
  if (!Array.isArray(data)) return [];

  return data
    .map((row) => normaliseScore(row as Record<string, unknown>))
    .filter((s): s is KovaaksScore => s !== null);
}

/**
 * Find the server record corresponding to a specific local run.
 *
 * `challengeStart` plus `hash` identifies a run far more precisely than score alone:
 * two runs can share a score, but not a start time to the millisecond.
 */
export function matchServerRecord(
  candidates: KovaaksScore[],
  local: RunEvidence,
): KovaaksScore | null {
  return candidates.find((candidate) => matchesServerEvidence(local, candidate)) ?? null;
}

/**
 * The server record of this run, found without trusting its corrected end time.
 *
 * `matchServerRecord` also demands that KovaaK's timestamp agree with the corrected time,
 * which is what Verified means. This asks the earlier question, whether KovaaK's has the
 * run at all, so that a record agreeing on everything except *when* can be read as the
 * contradiction it is (verifyRun) instead of as a missing record.
 */
export function sameRunRecord(
  candidates: KovaaksScore[],
  local: Omit<RunEvidence, "playedAt">,
): KovaaksScore | null {
  return candidates.find((candidate) => sameRunAs(local, candidate)) ?? null;
}

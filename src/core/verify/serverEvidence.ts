/** Missing provenance must never establish that a server saw this particular run. */
export interface RunEvidence {
  score: number;
  hash: string | null;
  challengeStart: string | null;
  playedAt: Date | null;
}

export interface RemoteEvidence {
  score: number;
  hash: string | null;
  challengeStart: string | null;
  epoch: number | null;
}

// Allow clock skew and upload latency without accepting another day's identical run.
export const SERVER_TIME_SLOP_MS = 3 * 60_000;

/**
 * The same run as a server record, judged only on what no clock or offset can move: the
 * scenario hash, the challenge start to the millisecond, and the score.
 *
 * Two runs can share a score, and a hash is shared by every run on a scenario, but not a
 * start time to the millisecond as well. That is what makes a match here positive
 * evidence about the run, and why a record that matches on these and disagrees about
 * *when* is a contradiction rather than an absence (see verifyRun).
 */
export function sameRunAs(local: Omit<RunEvidence, "playedAt">, remote: RemoteEvidence): boolean {
  return typeof local.hash === 'string' && local.hash.trim().length > 0 &&
    local.hash === remote.hash &&
    typeof local.challengeStart === 'string' && local.challengeStart.trim().length > 0 &&
    local.challengeStart === remote.challengeStart &&
    Number.isFinite(local.score) && Number.isFinite(remote.score) &&
    Math.abs(local.score - remote.score) <= Math.max(Math.abs(local.score), Math.abs(remote.score), 1) * 0.001;
}

export function matchesServerEvidence(local: RunEvidence, remote: RemoteEvidence): boolean {
  const ended = local.playedAt?.getTime();
  return sameRunAs(local, remote) &&
    typeof ended === 'number' && Number.isFinite(ended) &&
    typeof remote.epoch === 'number' && Number.isFinite(remote.epoch) &&
    Math.abs(ended - remote.epoch) <= SERVER_TIME_SLOP_MS;
}

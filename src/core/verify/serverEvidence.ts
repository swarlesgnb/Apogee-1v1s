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

export function matchesServerEvidence(local: RunEvidence, remote: RemoteEvidence): boolean {
  const ended = local.playedAt?.getTime();
  return typeof local.hash === 'string' && local.hash.trim().length > 0 &&
    local.hash === remote.hash &&
    typeof local.challengeStart === 'string' && local.challengeStart.trim().length > 0 &&
    local.challengeStart === remote.challengeStart &&
    Number.isFinite(local.score) && Number.isFinite(remote.score) &&
    Math.abs(local.score - remote.score) <= Math.max(Math.abs(local.score), Math.abs(remote.score), 1) * 0.001 &&
    typeof ended === 'number' && Number.isFinite(ended) &&
    typeof remote.epoch === 'number' && Number.isFinite(remote.epoch) &&
    Math.abs(ended - remote.epoch) <= SERVER_TIME_SLOP_MS;
}

export interface ExpeditionScenario {
  name: string;
  family: string;
  focus: string;
  target: number;
  finalTarget: number;
  precision: number;
  routeTarget?: number;
}
export interface Destination {
  id: string;
  name: string;
  category: string;
  color: string;
  description: string;
  bands: ExpeditionScenario[][];
  discovery?: ExpeditionScenario[][];
  circuits?: ExpeditionScenario[][];
  pool?: ExpeditionScenario[][];
}
export interface ExpeditionDefinition {
  version: 1 | 2 | 3 | 4;
  id: string;
  name: string;
  sourceSeason: string;
  bands: string[];
  destinations: Destination[];
}
export interface ExpeditionRun { id: string; scenario: string; score: number; at: number }
export type ChallengeKind = "discovery" | "steady" | "score_attack" | "circuit";
export type LegacyChallengeKind = "explore" | "consistency" | "breakthrough";
export interface ChallengeStep {
  scenario: string;
  focus: string;
  required: number;
  target: number | null;
  source: "discovery" | "personal" | "published" | "preserved";
}
export interface ChallengeOffer {
  kind: ChallengeKind;
  name: string;
  purpose: string;
  reward: string;
  steps: ChallengeStep[];
}
export interface Challenge {
  kind: ChallengeKind | LegacyChallengeKind;
  acceptedAt: number;
  targets: Record<string, number>;
  calibration: Record<string, number>;
  progress: Record<string, number>;
  evidence: string[];
  completedAt: number | null;
  steps?: ChallengeStep[];
}
export interface Route { challenges: Challenge[]; selectedKind?: ChallengeKind }
export interface Trial {
  id: string;
  destination: string;
  band: number;
  startedAt: number;
  endedAt: number | null;
  status: "active" | "failed" | "cleared" | "abandoned";
  steps: { scenario: string; target: number }[];
  results: ExpeditionRun[];
  /** Absent on preserved v1/v2 attempts, whose original rules still apply. */
  mode?: "checkpoint" | "prepared" | "strict";
  misses?: ExpeditionRun[];
  carried?: ExpeditionRun[];
}
export type RewardKind = "ship" | "relic" | "frame" | "banner" | "title" | "insignia" | "trophy";
export interface Reward {
  id: string;
  name: string;
  kind: RewardKind;
  color: string;
  design: number;
  requirement: string;
}
export interface ExpeditionState {
  version: 1 | 2 | 3 | 4;
  definitionId: string;
  enrolledAt: number;
  band: number;
  selected: string;
  routes: Record<string, Route>;
  runs: ExpeditionRun[];
  trials: Trial[];
  rewards: Record<string, number>;
  equipped: Partial<Record<RewardKind, string>>;
  migratedAt?: number;
}
export interface ExpeditionView {
  definition: ExpeditionDefinition;
  state: ExpeditionState | null;
  rewards: Reward[];
  error: string | null;
  warning?: string | null;
  canPlay: boolean;
  sessionStartedAt: number;
  offers?: ChallengeOffer[];
  journey?: JourneyView;
  journeys?: Pick<JourneyView, "title" | "description" | "rules">[];
}
export interface JourneyView {
  title: string;
  description: string;
  rules: string;
  ready: boolean;
  preparationReady: boolean;
  checkpoints: number;
  cleared: number;
  next: string;
  destinations: Record<string, { ready: boolean; checkpoints: number; preparationReady: boolean }>;
}

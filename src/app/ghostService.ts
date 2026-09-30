/**
 * Ghost Mode in the main process: the one place a ghost match is decided.
 *
 * The rules live in core/ghost/ghost.ts and are pure; this holds the match between
 * launches, feeds it the runs the watcher sees, runs its clock, and hands the renderer a
 * finished view. The renderer draws that view and sends actions. It computes no verdict,
 * no margin and no deadline (docs/overnight/mechanics.md, "main decides").
 *
 * Kept out of main.ts on purpose: main.ts is where every other screen is wired, and the
 * less of this lives there, the less a change to first-run flow and a change here can
 * collide.
 */

import { readFileSync } from "node:fs";

import { dataFile } from "../core/dataDir.ts";
import {
  abandonMatch,
  applyRun,
  availableKinds,
  defaultKind,
  drawGhostMatch,
  expireIfLate,
  GHOST_KINDS,
  GHOST_START_SLACK_MS,
  ghostStreak,
  inTen,
  isGhostKind,
  KIND_NAME,
  MEASURED_WIN_RATE,
  rematchOf,
  startMatch,
  viewOf,
  type GhostKind,
  type GhostMatch,
  type GhostMatchView,
  type IncomingRun,
  type KindAvailability,
  type RunRefusal,
} from "../core/ghost/ghost.ts";
import { scanStatsFolder } from "../core/history/history.ts";
import { dayKey } from "../core/quests/progression.ts";
import { isAbandonedRun, runDurationSeconds } from "../core/stats/duration.ts";
import { readStatsFolder } from "../core/stats/folderCache.ts";
import type { ParsedRun } from "../core/stats/parseStatsFile.ts";
import { friendlyError, isNotDeployed, postGhost, type GhostCard } from "./api.ts";
import {
  emptyGhostState,
  loadGhostState,
  saveGhostState,
  type GhostStoreState,
  type StoredGhostResult,
} from "./ghostStore.ts";

/** How often the clock is checked while a match runs. Only decides how late "time ran out" appears. */
const CLOCK_TICK_MS = 5_000;

/** What each ghost asks, for the chooser. */
const QUESTION: Record<GhostKind, string> = {
  month_ago: "Have I improved?",
  last_week: "Am I still improving?",
  last_week_best: "Can I beat my good day?",
};

const REFUSAL: Record<RunRefusal, (scenario: string) => string | null> = {
  "not-started": () => null,
  finished: () => null,
  unrelated: () => null,
  "before-start": (s) => `${s} began before Start, so it does not count. Play it again.`,
  "already-counted": (s) => `${s} already counted. First run per scenario only; this one was practice.`,
  late: (s) => `${s} landed after the clock ran out.`,
};

export interface GhostKindView extends KindAvailability {
  name: string;
  question: string;
  /** "About N in 10 won this in testing." */
  inTen: number;
}

export interface GhostScreen {
  signedIn: boolean;
  hasFolder: boolean;
  kinds: GhostKindView[];
  defaultKind: GhostKind | null;
  active: GhostMatchView | null;
  /** The newest finished result, for the result screen and the chooser's footer. */
  last: StoredGhostResult | null;
  streak: number;
  record: { wins: number; losses: number; played: number };
  notice: string | null;
  share: { enabled: boolean; reason: string | null; card: GhostCard | null; busy: boolean };
  /** Main's clock when this was built, so a countdown can be drawn without deciding anything. */
  now: number;
}

export interface GhostDeps {
  statsDir: () => string | null;
  signedIn: () => boolean;
  broadcast: (screen: GhostScreen) => void;
  /** A match finished: record it for the quest board. */
  onFinished: (result: StoredGhostResult) => void;
  launch: (scenario: string) => Promise<{ ok: boolean; error?: string }>;
}

export type GhostAction =
  | { type: "draw"; kind: GhostKind }
  | { type: "start" }
  | { type: "launch" }
  | { type: "rematch" }
  | { type: "abandon" }
  | { type: "dismiss" }
  | { type: "share" };

export function parseGhostAction(raw: unknown): GhostAction | string {
  if (!raw || typeof raw !== "object") return "no action given";
  const a = raw as { type?: unknown; kind?: unknown };
  switch (a.type) {
    case "draw":
      return isGhostKind(a.kind) ? { type: "draw", kind: a.kind } : "unknown ghost";
    case "start":
    case "launch":
    case "rematch":
    case "abandon":
    case "dismiss":
    case "share":
      return { type: a.type };
    default:
      return "unknown action";
  }
}

export class GhostService {
  private state: GhostStoreState | null = null;
  private notice: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private durations: Map<string, number | null> | null = null;
  private availability: { key: string; value: Record<GhostKind, KindAvailability> } | null = null;
  private shareBlocked: string | null = null;
  private shareBusy = false;
  private card: { resultId: string; card: GhostCard } | null = null;

  constructor(private readonly deps: GhostDeps) {}

  private store(): GhostStoreState {
    if (!this.state) {
      try {
        this.state = loadGhostState();
      } catch {
        this.state = emptyGhostState();
      }
      this.armClock();
    }
    return this.state;
  }

  private save(): void {
    try {
      saveGhostState(this.store());
    } catch (err) {
      console.error("ghost save failed:", err);
    }
  }

  /** Scenario names the active match may launch. Read by apogee:launchScenario, never from the renderer. */
  scenarios(): Set<string> {
    const active = this.store().active;
    return new Set(active && !active.result ? active.rounds.map((r) => r.scenario) : []);
  }

  private history() {
    const dir = this.deps.statsDir();
    return dir ? scanStatsFolder(dir) : new Map();
  }

  private kinds(now: Date): Record<GhostKind, KindAvailability> {
    const history = this.history();
    let runs = 0;
    for (const h of history.values()) runs += h.runs.length;
    // Availability only changes with the day or with a new run, and it walks the whole
    // library three times, so it is not recomputed for every countdown redraw.
    const key = `${this.deps.statsDir()}|${dayKey(now)}|${runs}`;
    if (this.availability?.key !== key) this.availability = { key, value: availableKinds(history, now) };
    return this.availability.value;
  }

  private durationOf(scenario: string): number | null {
    if (!this.durations) {
      try {
        const raw = JSON.parse(readFileSync(dataFile("scenario_durations.json"), "utf8")) as {
          durations: { scenario: string; seconds: number | null }[];
        };
        this.durations = new Map(raw.durations.map((d) => [d.scenario, d.seconds]));
      } catch {
        this.durations = new Map();
      }
    }
    return this.durations.get(scenario) ?? null;
  }

  /**
   * A watcher run as the core wants it. Duration comes from one parse: `Challenge Start:`
   * and the filename's clock are both local wall-clock readings of the same file, so
   * their difference is right whatever the timezone (CLAUDE.md). `at` is that filename
   * clock read on this machine, the same frame `Date.now()` is in.
   */
  private incoming(run: Pick<ParsedRun, "scenario" | "score" | "playedAt" | "challengeStart">): IncomingRun | null {
    if (!run.playedAt || Number.isNaN(run.playedAt.getTime())) return null;
    const durationSeconds = runDurationSeconds(run.challengeStart, run.playedAt);
    return {
      scenario: run.scenario,
      score: run.score,
      at: run.playedAt.getTime(),
      durationSeconds,
      abandoned: isAbandonedRun(durationSeconds, this.durationOf(run.scenario)),
    };
  }

  private offer(run: IncomingRun, file: string): { refused: RunRefusal | null } {
    const s = this.store();
    if (!s.active) return { refused: "not-started" };
    const outcome = applyRun(s.active, run);
    if (!outcome.accepted) return { refused: outcome.reason };
    s.active = outcome.match;
    s.files = { ...s.files, [run.scenario]: file };
    if (s.active.result) this.finish();
    return { refused: null };
  }

  /** A run the watcher saw. Called for every run; most are none of this match's business. */
  onRun(run: ParsedRun, file: string): void {
    const s = this.store();
    if (!s.active || s.active.result || s.active.startedAt === null) return;
    this.tick(false);
    if (!s.active || s.active.result) return this.publish();

    const incoming = this.incoming(run);
    if (!incoming) return;
    const { refused } = this.offer(incoming, file);
    this.notice = refused ? REFUSAL[refused](run.scenario) : null;
    this.save();
    this.publish();
  }

  /**
   * Runs that landed while the app was shut, taken in play order.
   *
   * The watcher only reports files written while it runs, so a match started, the app
   * closed and the scenarios played would otherwise sit waiting for runs that are already
   * on disk. Each file goes through the same `applyRun` a live one does.
   */
  catchUp(): void {
    const s = this.store();
    const dir = this.deps.statsDir();
    const active = s.active;
    if (!dir || !active || active.result || active.startedAt === null) return;
    const names = new Set(active.rounds.map((r) => r.scenario));
    const counted = new Set(Object.values(s.files));
    const pending = readStatsFolder(dir)
      .filter(({ file, run }) => names.has(run.scenario) && !counted.has(file) && run.playedAt &&
        run.playedAt.getTime() >= active.startedAt! - GHOST_START_SLACK_MS)
      .map(({ file, run }) => ({ file, run: this.incoming(run) }))
      .filter((x): x is { file: string; run: IncomingRun } => x.run !== null)
      .sort((a, b) => a.run.at - b.run.at);
    let changed = false;
    for (const { file, run } of pending) {
      if (!s.active || s.active.result) break;
      if (this.offer(run, file).refused === null) changed = true;
    }
    this.tick(false);
    if (changed) {
      this.save();
      this.publish();
    }
  }

  /** The clock. Decided here, on a timer and on every run; never by the renderer. */
  private tick(publish = true): void {
    const s = this.store();
    if (!s.active || s.active.result) return;
    const next = expireIfLate(s.active, Date.now());
    if (next === s.active) return;
    s.active = next;
    this.finish();
    this.save();
    if (publish) this.publish();
  }

  private armClock(): void {
    const running = !!this.state?.active && !this.state.active.result && this.state.active.startedAt !== null;
    if (running && !this.timer) this.timer = setInterval(() => this.tick(), CLOCK_TICK_MS);
    if (!running && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Book a result that has just been set on the active match. */
  private finish(): void {
    const s = this.store();
    const match = s.active;
    if (!match?.result) return;
    if (s.results.some((r) => r.id === match.id)) return;

    const day = dayKey(new Date(match.result.at));
    if (match.result.verdict === "win") s.winDays = [...new Set([...s.winDays, day])].sort();
    s.finished += 1;
    const streak = this.streak(new Date(match.result.at));
    const stored: StoredGhostResult = { ...match.result, id: match.id, kind: match.kind, streak };
    s.results = [...s.results, stored];
    this.notice = null;
    this.armClock();
    this.deps.onFinished(stored);
  }

  private streak(now: Date): number {
    // Local noon, so the day survives the round trip through an ISO string anywhere.
    const records = this.store().winDays.map((d) => {
      const [y, m, day] = d.split("-").map(Number);
      return { at: new Date(y, m - 1, day, 12).toISOString(), verdict: "win" as const };
    });
    return ghostStreak(records, now);
  }

  view(): GhostScreen {
    const s = this.store();
    const now = new Date();
    const hasFolder = !!this.deps.statsDir();
    const kinds = hasFolder ? this.kinds(now) : null;
    const last = s.results.at(-1) ?? null;
    const lastCard = this.card && last && this.card.resultId === last.id ? this.card.card : null;

    let shareReason: string | null = null;
    if (!last || !s.active?.result || s.active.id !== last.id) shareReason = "Finish a match to share it.";
    else if (last.verdict === "void") shareReason = "A match with no result has nothing to share.";
    else if (!this.deps.signedIn()) shareReason = "Sign in with Steam to share: a card is rebuilt by the server from your verified runs.";
    else if (this.shareBlocked) shareReason = this.shareBlocked;
    else if (Object.keys(s.files).length < 3) shareReason = "The stats files behind this match are not all known, so it cannot be verified.";

    return {
      signedIn: this.deps.signedIn(),
      hasFolder,
      kinds: GHOST_KINDS.map((k) => ({
        ...(kinds?.[k] ?? { kind: k, available: false, scenarios: 0, sessionDay: null, reason: "No stats folder yet." }),
        name: KIND_NAME[k],
        question: QUESTION[k],
        inTen: inTen(MEASURED_WIN_RATE[k]),
      })),
      defaultKind: kinds ? defaultKind(kinds, s.finished > 0) : null,
      active: s.active ? viewOf(s.active) : null,
      last,
      streak: this.streak(now),
      record: {
        wins: s.results.filter((r) => r.verdict === "win").length,
        losses: s.results.filter((r) => r.verdict === "loss").length,
        played: s.finished,
      },
      notice: this.notice,
      share: { enabled: shareReason === null && !lastCard, reason: shareReason, card: lastCard, busy: this.shareBusy },
      now: now.getTime(),
    };
  }

  publish(): void {
    this.deps.broadcast(this.view());
  }

  async action(raw: unknown): Promise<{ view: GhostScreen; error?: string; note?: string }> {
    const action = parseGhostAction(raw);
    if (typeof action === "string") return { view: this.view(), error: action };
    const s = this.store();
    const now = new Date();
    this.tick(false);

    const fail = (error: string) => ({ view: this.view(), error });
    const inProgress = s.active && !s.active.result && s.active.startedAt !== null;

    switch (action.type) {
      case "draw": {
        if (inProgress) return fail("Finish or abandon the match in progress first.");
        const history = this.history();
        if (history.size === 0) return fail("No runs found yet. Choose your stats folder first.");
        const today = dayKey(now);
        const ordinal = s.started.day === today ? s.started.count : 0;
        const match = drawGhostMatch(history, now, action.kind, ordinal);
        if (!match) return fail(this.kinds(now)[action.kind].reason ?? "No ghost to race today.");
        s.active = match;
        s.files = {};
        this.notice = null;
        break;
      }
      case "rematch": {
        if (inProgress) return fail("Finish or abandon the match in progress first.");
        if (!s.active) return fail("There is no match to rematch.");
        const today = dayKey(now);
        const ordinal = s.started.day === today ? s.started.count : 0;
        s.active = rematchOf(s.active, now, ordinal);
        s.files = {};
        this.notice = null;
        break;
      }
      case "start": {
        if (!s.active || s.active.result || s.active.startedAt !== null) return fail("Draw a match first.");
        s.active = startMatch(s.active, now.getTime());
        const today = dayKey(now);
        s.started = { day: today, count: (s.started.day === today ? s.started.count : 0) + 1 };
        this.armClock();
        this.save();
        this.publish();
        // Start and the first scenario are one press, the way Expedition's launch is: the
        // clock is the ranked one, and making the player go and find the scenario would
        // spend it on navigation.
        return this.launchNext();
      }
      case "launch":
        return this.launchNext();
      case "abandon": {
        if (!s.active) return fail("There is no match to abandon.");
        const next = abandonMatch(s.active, now.getTime());
        s.active = next;
        if (next?.result) this.finish();
        else s.files = {};
        this.notice = null;
        this.armClock();
        break;
      }
      case "dismiss":
        if (inProgress) return fail("Abandon the match to leave it; a match left partway is a loss.");
        s.active = null;
        s.files = {};
        this.notice = null;
        break;
      case "share":
        return this.share();
    }

    this.save();
    this.publish();
    return { view: this.view() };
  }

  private async launchNext(): Promise<{ view: GhostScreen; error?: string; note?: string }> {
    const active = this.store().active;
    const next = active && !active.result ? viewOf(active).next : null;
    if (!next) return { view: this.view(), error: "Nothing left to launch." };
    const launched = await this.deps.launch(next);
    return launched.ok
      ? { view: this.view(), note: `Opening ${next} in KovaaK's.` }
      : { view: this.view(), error: launched.error ?? "KovaaK's could not be opened. The clock is running; open the scenario yourself." };
  }

  /**
   * Send the finished match up for a card. Degrades to a sentence, never an error screen,
   * while post-ghost is not deployed: the local result is complete without it.
   */
  private async share(): Promise<{ view: GhostScreen; error?: string }> {
    const s = this.store();
    const view = this.view();
    const dir = this.deps.statsDir();
    if (!view.share.enabled || !s.active?.result || !dir) return { view, error: view.share.reason ?? "Nothing to share." };

    const files = s.active.rounds.map((r) => s.files[r.scenario]).filter((f): f is string => !!f);
    this.shareBusy = true;
    this.publish();
    try {
      const card = await postGhost(dir, files, s.active.kind, s.active.ordinal);
      this.card = { resultId: s.active.id, card };
      return { view: this.view() };
    } catch (err) {
      if (isNotDeployed(err)) {
        this.shareBlocked = "Sharing is not live on the server yet. Your result is saved here.";
        return { view: this.view() };
      }
      return { view: this.view(), error: friendlyError(err) };
    } finally {
      this.shareBusy = false;
      this.publish();
    }
  }
}

/**
 * Apogee Daily in the main process: today's draw, the result read from the stats folder,
 * the streak, the share text, and the board once signed in.
 *
 * The rules are src/core/social/daily.ts and are pure. This reads the folder and the
 * season, works out the screen, posts a finished day to the board when the player is
 * signed in, and hands the renderer a finished view. The renderer computes nothing: no
 * draw, no delta, no glyph, no countdown deadline (it is told how long is left).
 *
 * Works signed out and offline: the draw, the result, the streak and the share text are
 * all local. The board is the only part that needs the server, and its absence is said
 * plainly rather than shown as an error.
 */

import { ApiError, friendlyError, isNotDeployed } from "./api.ts";
import { fetchDailyBoard, submitDaily } from "./socialApi.ts";
import { loadSocialState, saveSocialState } from "./socialStore.ts";
import { scanStatsFolder } from "../core/history/history.ts";
import { readStatsFolder } from "../core/stats/folderCache.ts";
import { loadSeason } from "../core/season/season.ts";
import { localDay } from "../core/brand/shareInput.ts";
import type { DailyRecord } from "../core/brand/shareInput.ts";
import {
  BAND_SLUGS,
  dailyFor,
  dailyNumberAt,
  dailyStreak,
  dailyWindow,
  evaluateDaily,
  GLYPH_CHAR,
  GLYPH_WORD,
  playedDailies,
  shareText,
  type DailyBoard,
  type DailyPoolEntry,
  type DailyResult,
  type Glyph,
} from "../core/social/daily.ts";
import { landingUrl } from "../core/social/deepLinks.ts";

/** After this long with no Daily run since a launch from the Daily screen, presence lets go. */
const PLAYING_IDLE_MS = 30 * 60_000;
/** A board read is reused for this long before asking again. */
const BOARD_TTL_MS = 60_000;

export interface DailyBand {
  index: number;
  name: string;
  slug: string;
}

export interface DailyRoundView {
  skill: string;
  scenario: string;
  glyph: Glyph;
  char: string;
  word: string;
  score: number | null;
  baseline: number | null;
  delta: number | null;
  priorRuns: number;
  provisional: boolean;
}

export type BoardState = "signed-out" | "waiting" | "posting" | "posted" | "unavailable" | "error";

export interface DailyScreen {
  hasFolder: boolean;
  signedIn: boolean;
  /** 0 before Daily #1 begins. */
  number: number;
  band: DailyBand;
  bands: DailyBand[];
  /** Until the next draw, from main's clock. */
  nextInMs: number;
  rounds: DailyRoundView[];
  complete: boolean;
  meanDelta: number | null;
  provisional: boolean;
  streak: number;
  shareText: string | null;
  link: string;
  board: { state: BoardState; message: string | null; board: DailyBoard | null };
  /** A daily link asked for another band; the screen offers the switch, never makes it. */
  proposedBand: DailyBand | null;
  error: string | null;
  now: number;
}

export interface DailyDeps {
  statsDir: () => string | null;
  signedIn: () => boolean;
  /** The queue's band, the default until the player picks one here. */
  queueBand: () => number | null;
  broadcast: (screen: DailyScreen) => void;
  launch: (scenario: string) => Promise<{ ok: boolean; error?: string }>;
  copyText: (text: string) => void;
  now?: () => number;
}

export type DailyAction =
  | { type: "band"; index: number }
  | { type: "launch"; round: number }
  | { type: "copy" }
  | { type: "post" }
  | { type: "refresh" }
  | { type: "dismissBand" };

export function parseDailyAction(raw: unknown): DailyAction | string {
  if (!raw || typeof raw !== "object") return "no action given";
  const a = raw as { type?: unknown; index?: unknown; round?: unknown };
  switch (a.type) {
    case "band":
      return typeof a.index === "number" && Number.isInteger(a.index) && a.index >= 0 && a.index < 16 ? { type: "band", index: a.index } : "unknown band";
    case "launch":
      return typeof a.round === "number" && Number.isInteger(a.round) && a.round >= 0 && a.round < 3 ? { type: "launch", round: a.round } : "unknown round";
    case "copy":
    case "post":
    case "refresh":
    case "dismissBand":
      return { type: a.type };
    default:
      return "unknown action";
  }
}

export class DailyService {
  private board: { key: string; board: DailyBoard; at: number } | null = null;
  private boardState: { key: string; state: BoardState; message: string | null } | null = null;
  private posting = false;
  private syncing = false;
  private proposed: number | null = null;
  private playingSince: number | null = null;
  private lastDailyRun = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: DailyDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private season() {
    const season = loadSeason();
    const pool: DailyPoolEntry[] = season.scenarios.map((s) => ({ name: s.scenario, category: s.category, window: s.window ?? 0 }));
    const names = season.windows ?? ["Novice", "Intermediate", "Advanced", "Expert"];
    const bands: DailyBand[] = names.map((name, index) => ({ index, name, slug: BAND_SLUGS[index] ?? `band-${index}` }));
    return { season, pool, bands };
  }

  private bandIndex(bands: DailyBand[]): number {
    const stored = loadSocialState().dailyBand;
    const queue = this.deps.queueBand();
    const pick = stored ?? queue ?? 1;
    return Math.min(Math.max(0, pick), bands.length - 1);
  }

  /** Re-broadcast when the draw changes over, so an open screen flips on its own. */
  arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const n = dailyNumberAt(this.now());
    const next = n >= 1 ? dailyWindow(n + 1).start : dailyWindow(1).start;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.push();
      this.arm();
    }, Math.max(1_000, next - this.now() + 500));
    this.timer.unref?.();
  }

  private compute() {
    const { season, pool, bands } = this.season();
    const now = this.now();
    const n = dailyNumberAt(now);
    const band = bands[this.bandIndex(bands)];
    const dir = this.deps.statsDir();
    const history = dir ? scanStatsFolder(dir) : new Map();
    const draw = dailyFor(pool, season.name, now, band.index);
    const result: DailyResult | null = draw ? evaluateDaily(history, draw) : null;
    const streak = n >= 1 ? dailyStreak(playedDailies(history, pool, season.name, n, bands.length), n) : 0;
    return { season, pool, bands, band, now, n, dir, draw, result, streak };
  }

  view(): DailyScreen {
    let c: ReturnType<DailyService["compute"]>;
    try {
      c = this.compute();
    } catch (err) {
      const bands = BAND_SLUGS.map((slug, index) => ({ index, name: slug, slug }));
      return this.empty(bands[1], bands, `The Daily could not be drawn: ${friendlyError(err)}`);
    }
    const { band, bands, n, now, result, streak } = c;
    const key = `${n}:${band.index}`;
    const link = landingUrl({ kind: "daily", number: n >= 1 ? n : null, band: band.slug as (typeof BAND_SLUGS)[number] });
    const text = result && result.complete ? shareText({ result, bandName: band.name, streak, link }) : null;
    this.sync(!!result?.complete, key);

    return {
      hasFolder: !!c.dir,
      signedIn: this.deps.signedIn(),
      number: n,
      band,
      bands,
      nextInMs: Math.max(0, (n >= 1 ? dailyWindow(n + 1).start : dailyWindow(1).start) - now),
      rounds: (result?.rounds ?? []).map((r) => ({
        skill: r.skill ?? "",
        scenario: r.scenario,
        glyph: r.glyph,
        char: GLYPH_CHAR[r.glyph],
        word: GLYPH_WORD[r.glyph],
        score: r.score,
        baseline: r.baseline,
        delta: r.delta,
        priorRuns: r.priorRuns,
        provisional: r.provisional,
      })),
      complete: !!result?.complete,
      meanDelta: result?.meanDelta ?? null,
      provisional: !!result?.provisional,
      streak,
      shareText: text,
      link,
      board: this.boardView(key, !!result?.complete),
      proposedBand: this.proposed !== null && this.proposed !== band.index ? bands[this.proposed] ?? null : null,
      error: n < 1 ? "Apogee Daily #1 has not started yet." : result ? null : "This band has too few scenarios for a daily.",
      now,
    };
  }

  private empty(band: DailyBand, bands: DailyBand[], error: string): DailyScreen {
    return {
      hasFolder: !!this.deps.statsDir(), signedIn: this.deps.signedIn(), number: 0, band, bands, nextInMs: 0, rounds: [],
      complete: false, meanDelta: null, provisional: false, streak: 0, shareText: null, link: "",
      board: { state: "waiting", message: null, board: null }, proposedBand: null, error, now: this.now(),
    };
  }

  private boardView(key: string, complete: boolean): DailyScreen["board"] {
    if (!this.deps.signedIn()) {
      return { state: "signed-out", message: "Sign in with Steam to see where today's result places you in your band.", board: null };
    }
    const board = this.board?.key === key ? this.board.board : null;
    const state = this.boardState?.key === key ? this.boardState : null;
    if (state) return { state: state.state, message: state.message, board };
    if (board) return { state: complete ? "posted" : "waiting", message: null, board };
    return {
      state: "waiting",
      message: complete ? null : "Finish all three to put today on the board.",
      board: null,
    };
  }

  push(): void {
    this.deps.broadcast(this.view());
  }

  /** A run landed. Re-read the day, and post it once it is complete. */
  onRun(run: { scenario: string; playedAt: Date | null }): void {
    let c: ReturnType<DailyService["compute"]>;
    try {
      c = this.compute();
    } catch {
      return;
    }
    if (!c.draw || !c.draw.scenarios.includes(run.scenario)) return;
    this.lastDailyRun = this.now();
    this.push();
    if (c.result?.complete) void this.post(false);
  }

  /** What Discord is told, when the player is playing today's draw. */
  presence(): { number: number; band: string; since: number } | null {
    if (this.playingSince === null) return null;
    const last = Math.max(this.playingSince, this.lastDailyRun);
    if (this.now() - last > PLAYING_IDLE_MS) {
      this.playingSince = null;
      return null;
    }
    try {
      const { n, band, result } = this.compute();
      // A finished day is not being played any more.
      if (result?.complete) {
        this.playingSince = null;
        return null;
      }
      return n >= 1 ? { number: n, band: band.name, since: this.playingSince } : null;
    } catch {
      return null;
    }
  }

  /** A daily link asked for a band: offered on the screen, switched only by the player. */
  propose(band: number | null): void {
    this.proposed = band;
    this.push();
  }

  /** Post a complete day to the board, once. `force` retries after a failure. */
  async post(force: boolean): Promise<void> {
    if (this.posting || !this.deps.signedIn()) return;
    const c = this.compute();
    if (!c.draw || !c.result?.complete || !c.dir) return;
    const key = `${c.n}:${c.band.index}`;
    // A failure is retried by the player (Try again), never by a loop of pushes.
    if (!force && this.failed(key)) return;
    const social = loadSocialState();
    if (social.posted.includes(key) && !force) {
      await this.refreshBoard(c.n, c.band.index, false);
      return;
    }

    // The first run inside the day on each of the three, by file, as evaluateDaily chose.
    const { start, end } = dailyWindow(c.n);
    const files = c.draw.scenarios.map((scenario) => {
      const runs = readStatsFolder(c.dir as string)
        .filter((f) => f.run.scenario === scenario && f.run.playedAt)
        .filter((f) => {
          const t = (f.run.playedAt as Date).getTime();
          return t >= start && t < end;
        })
        .sort((a, b) => (a.run.playedAt as Date).getTime() - (b.run.playedAt as Date).getTime());
      return runs[0]?.file ?? null;
    });
    if (files.some((f) => !f)) return;

    this.posting = true;
    this.boardState = { key, state: "posting", message: "Posting today's result to the board…" };
    this.push();
    try {
      const answer = await submitDaily(c.dir, files as string[], c.n, c.band.index);
      saveSocialState({ posted: [...social.posted.filter((k) => k !== key), key] });
      this.board = { key, board: answer.board, at: this.now() };
      this.boardState = null;
    } catch (err) {
      const unavailable = isNotDeployed(err) || (err instanceof ApiError && err.status === 0);
      this.boardState = {
        key,
        state: unavailable ? "unavailable" : "error",
        message: isNotDeployed(err)
          ? "The Daily board is not live yet. Your result is kept on this PC."
          : friendlyError(err),
      };
    } finally {
      this.posting = false;
      this.push();
    }
  }

  private failed(key: string): boolean {
    return this.boardState?.key === key && (this.boardState.state === "unavailable" || this.boardState.state === "error");
  }

  /**
   * Put a finished day on the board, or read the board for it, without being asked: a day
   * finished signed out, or before this launch, is posted once the player is signed in.
   * Scheduled rather than run inside view(), and at most one at a time.
   */
  private sync(complete: boolean, key: string): void {
    if (this.syncing || this.posting || !complete || !this.deps.signedIn() || this.failed(key)) return;
    if (this.board?.key === key && this.now() - this.board.at < BOARD_TTL_MS) return;
    this.syncing = true;
    setTimeout(() => {
      void this.post(false).finally(() => {
        this.syncing = false;
      });
    }, 0);
  }

  async refreshBoard(n: number, band: number, force: boolean): Promise<void> {
    const key = `${n}:${band}`;
    if (!this.deps.signedIn()) return;
    if (!force && this.failed(key)) return;
    if (!force && this.board?.key === key && this.now() - this.board.at < BOARD_TTL_MS) return;
    try {
      const { board } = await fetchDailyBoard(n, band);
      this.board = { key, board, at: this.now() };
      if (this.boardState?.key === key && this.boardState.state !== "posting") this.boardState = null;
    } catch (err) {
      this.boardState = { key, state: isNotDeployed(err) ? "unavailable" : "error", message: isNotDeployed(err) ? "The Daily board is not live yet." : friendlyError(err) };
    }
    this.push();
  }

  async action(raw: unknown): Promise<{ view: DailyScreen; error?: string; note?: string }> {
    const action = parseDailyAction(raw);
    if (typeof action === "string") return { view: this.view(), error: action };
    switch (action.type) {
      case "band": {
        const { bands } = this.season();
        if (action.index >= bands.length) return { view: this.view(), error: "unknown band" };
        saveSocialState({ dailyBand: action.index });
        if (this.proposed === action.index) this.proposed = null;
        const view = this.view();
        this.deps.broadcast(view);
        if (view.complete) void this.post(false);
        else if (this.deps.signedIn() && view.number >= 1) void this.refreshBoard(view.number, view.band.index, false);
        return { view };
      }
      case "dismissBand":
        this.proposed = null;
        return { view: this.view() };
      case "launch": {
        const c = this.compute();
        const scenario = c.draw?.scenarios[action.round];
        if (!scenario) return { view: this.view(), error: "There is no daily to play right now." };
        const launched = await this.deps.launch(scenario);
        if (!launched.ok) return { view: this.view(), error: launched.error ?? "KovaaK's could not be opened." };
        this.playingSince ??= this.now();
        return { view: this.view(), note: `Opening ${scenario} in KovaaK's. Your first run on it today counts.` };
      }
      case "copy": {
        const view = this.view();
        if (!view.shareText) return { view, error: "Finish all three to share today." };
        this.deps.copyText(view.shareText);
        return { view, note: "Copied. Paste it anywhere: it names no scenario." };
      }
      case "post":
        await this.post(true);
        return { view: this.view() };
      case "refresh": {
        const view = this.view();
        if (view.number >= 1) await this.refreshBoard(view.number, view.band.index, true);
        return { view: this.view() };
      }
    }
  }

  /**
   * The share image: the existing card renderer, plain. Rounds are labelled by skill, never
   * by scenario, and carry the delta without raw scores, so the picture spoils the draw no
   * more than the text does. The brand kit's own daily card replaces this drawing at
   * integration; the data it is drawn from stays this.
   */
  /**
   * Today's finished Daily as the brand kit's Daily card takes it (DailyRecord in
   * core/brand/shareInput.ts), or null until all three are played. It carries no scenario
   * name, so the card cannot spoil the draw.
   */
  shareRecord(): DailyRecord | null {
    const view = this.view();
    if (!view.complete) return null;
    return {
      number: view.number,
      band: view.band.name,
      marks: view.rounds.map((r) => r.glyph),
      meanDelta: view.meanDelta,
      streak: view.streak,
      provisional: view.provisional,
      date: localDay(this.now()),
    };
  }
}

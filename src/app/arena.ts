/**
 * Crowns and live races in the main process.
 *
 * Main holds the session token, so every call is made here; the renderer asks over IPC and
 * draws what it is sent (renderer/crowns.js, renderer/race.js). Nothing here decides a
 * result. The server decides every Crown and race in SQL; this fetches, adopts the matches
 * the server hands out through main's own `adoptMatch`, and keeps three things fresh:
 *
 *   the board      on the way in, after any Crown action or settlement, and every few
 *                  minutes while the window is in front: that is how a dethroned holder
 *                  sees "You lost the Precise Tracking Crown to X" the next time they open
 *                  the client
 *   invitations    every 30 seconds while focused (two minutes behind the game), because a
 *                  race invitation waits three minutes; an inviter whose race has started
 *                  adopts their match from here
 *   the live view  every 4 seconds while a race leg or a Crown challenge is being played,
 *                  focused or not: the player is in KovaaK's, and the bar is for when they
 *                  look over
 *
 * Kept out of main.ts for the reason ghostService.ts is: the less of this lives there, the
 * less a change to first-run flow and a change here can collide.
 */

import type { IpcMain } from "electron";

import { fetchActiveMatch, friendlyError, type FoundMatch } from "./api.ts";
import {
  answerRace,
  challengeCrown,
  fetchCrowns,
  fetchLive,
  fetchRaces,
  inviteRace,
  type ArenaMatch,
  type CrownBoard,
  type LiveView,
  type RaceBoard,
} from "./arenaApi.ts";

const RACE_POLL_FOCUSED_MS = 30_000;
const RACE_POLL_BACKGROUND_MS = 120_000;
const CROWN_POLL_MS = 5 * 60_000;
const LIVE_POLL_MS = 4_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ArenaHooks {
  session: () => { playerId: string } | null;
  match: () => FoundMatch | null;
  adoptMatch: (match: FoundMatch) => void;
  broadcast: (channel: string, payload: unknown) => void;
  focused: () => boolean;
  /** Flash the taskbar when something arrives behind the game. */
  nudge: () => void;
}

const SIGNED_OUT = "Sign in with Steam to play for Crowns and race.";

export class ArenaService {
  private board: CrownBoard | null = null;
  private races: RaceBoard | null = null;
  private live: LiveView | null = null;
  private lastCrowns = 0;
  private lastRaces = 0;
  private boardFor: string | null = null;
  private incomingKey = "";
  /** Matches already asked about: true for a race leg or Crown challenge, false otherwise. */
  private arenaMatch = new Map<string, boolean>();
  private timer: NodeJS.Timeout | null = null;
  private liveTimer: NodeJS.Timeout | null = null;

  constructor(private hooks: ArenaHooks) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.timer.unref?.();
    this.liveTimer = setInterval(() => void this.pollLive(), LIVE_POLL_MS);
    this.liveTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.liveTimer) clearInterval(this.liveTimer);
    this.timer = this.liveTimer = null;
  }

  private async tick(): Promise<void> {
    const session = this.hooks.session();
    if (!session) {
      if (this.boardFor) {
        this.board = this.races = this.live = null;
        this.boardFor = null;
        this.hooks.broadcast("apogee:crowns", null);
        this.hooks.broadcast("apogee:races", null);
      }
      return;
    }
    const now = Date.now();
    // A new session reads the board at once: that is when a dethroned notice is shown.
    if (this.boardFor !== session.playerId || (this.hooks.focused() && now - this.lastCrowns > CROWN_POLL_MS)) {
      this.boardFor = session.playerId;
      await this.refreshCrowns().catch(() => undefined);
    }
    const every = this.hooks.focused() ? RACE_POLL_FOCUSED_MS : RACE_POLL_BACKGROUND_MS;
    if (now - this.lastRaces > every) await this.refreshRaces().catch(() => undefined);
  }

  /* ------------------------------------------------------------------ crowns ---- */

  async refreshCrowns(seen?: string[]): Promise<CrownBoard> {
    this.lastCrowns = Date.now();
    const board = await fetchCrowns(seen);
    this.board = board;
    this.hooks.broadcast("apogee:crowns", board);
    return board;
  }

  async challenge(category: string, window: number): Promise<ArenaMatch> {
    const match = await challengeCrown(category, window);
    const current = this.hooks.match();
    if (current?.matchId === match.matchId) {
      // Handed back: keep what main already knows about runs submitted against it.
      Object.assign(current, { crown: match.crown });
      this.hooks.broadcast("apogee:match", current);
    } else {
      this.hooks.adoptMatch(match);
    }
    this.arenaMatch.set(match.matchId, true);
    void this.refreshCrowns().catch(() => undefined);
    void this.pollLive();
    return match;
  }

  /* ------------------------------------------------------------------- races ---- */

  async refreshRaces(): Promise<RaceBoard> {
    this.lastRaces = Date.now();
    const board = await fetchRaces();
    this.races = board;
    const key = board.incoming.map((r) => r.id).join(",");
    if (key && key !== this.incomingKey) this.hooks.nudge();
    this.incomingKey = key;
    this.hooks.broadcast("apogee:races", board);

    // The inviter learns here that their race started, and takes up the match the server
    // created for them, unless they are already in it or in something else.
    const live = board.live;
    const current = this.hooks.match();
    if (live?.yourMatchId && live.role === "inviter" && !current) {
      const active = await fetchActiveMatch().catch(() => null);
      if (active && active.matchId === live.yourMatchId) {
        const match: ArenaMatch = {
          ...active,
          resumed: false,
          race: { id: live.id, opponentName: live.opponent.name, role: "inviter", band: live.band },
        };
        this.arenaMatch.set(match.matchId, true);
        this.hooks.adoptMatch(match);
        void this.pollLive();
      }
    }
    return board;
  }

  async raceAction(raw: Record<string, unknown>): Promise<{ race?: unknown; match?: ArenaMatch }> {
    const action = raw.action;
    if (action === "invite") {
      const { to, category, window } = raw;
      if (typeof to !== "string" || !UUID.test(to)) throw new Error("Pick somebody to race.");
      if (typeof category !== "string" || !category || category.length > 40) throw new Error("Pick a category.");
      if (typeof window !== "number" || !Number.isInteger(window) || window < 0) throw new Error("Pick a band.");
      const result = await inviteRace(to, category, window);
      void this.refreshRaces().catch(() => undefined);
      return { race: result.race };
    }
    const raceId = raw.raceId;
    if (typeof raceId !== "string" || !UUID.test(raceId)) throw new Error("No such race.");
    if (action === "accept") {
      const match = await answerRace(raceId, "accept");
      this.arenaMatch.set(match.matchId, true);
      const current = this.hooks.match();
      if (current?.matchId === match.matchId) this.hooks.broadcast("apogee:match", Object.assign(current, { race: match.race }));
      else this.hooks.adoptMatch(match);
      void this.refreshRaces().catch(() => undefined);
      void this.pollLive();
      return { match };
    }
    if (action === "decline" || action === "cancel") {
      const result = await answerRace(raceId, action);
      void this.refreshRaces().catch(() => undefined);
      return { race: result.race };
    }
    throw new Error("Unknown race action.");
  }

  /* -------------------------------------------------------------------- live ---- */

  /** Ask the server for the live view of the match being played, if it is ours to ask about. */
  async pollLive(): Promise<LiveView | null> {
    const match = this.hooks.match() as ArenaMatch | null;
    if (!match || !this.hooks.session()) return null;
    const known = this.arenaMatch.get(match.matchId);
    if (known === false) return null;
    // A match the queue or a duel just handed out says so by carrying neither field, and is
    // never asked about. One recovered after a restart carries nothing either way, so it is
    // asked once, and a refusal files it as not ours.
    if (known === undefined && !match.crown && !match.race && !match.resumed) {
      this.arenaMatch.set(match.matchId, false);
      return null;
    }
    try {
      const view = await fetchLive(match.matchId);
      this.arenaMatch.set(match.matchId, true);
      this.live = view;
      this.hooks.broadcast("apogee:live", view);
      return view;
    } catch (err) {
      // 404: not a race or a challenge. Anything else is worth another try next tick.
      if (/not a race or a challenge|does not exist/.test(friendlyError(err))) this.arenaMatch.set(match.matchId, false);
      return null;
    }
  }

  /** After main settles a match: the board and the races list may both have moved. */
  afterSettled(settled: { matchId?: string; arena?: unknown } | null): void {
    if (!this.hooks.session()) return;
    if (settled?.arena) {
      void this.refreshCrowns().catch(() => undefined);
      void this.refreshRaces().catch(() => undefined);
      if (settled.matchId) {
        void fetchLive(settled.matchId)
          .then((view) => this.hooks.broadcast("apogee:live", view))
          .catch(() => undefined);
      }
    } else if (this.board) {
      // An ordinary match may have opened a Crown to this player (a vacant one they
      // could claim). Cheap, and the board is what the result screen offers next.
      void this.refreshCrowns().catch(() => undefined);
    }
  }

  /* --------------------------------------------------------------------- ipc ---- */

  registerIpc(ipc: IpcMain): void {
    const guarded = <T>(fn: () => Promise<T>) => async () => {
      if (!this.hooks.session()) return { error: SIGNED_OUT };
      try {
        return await fn();
      } catch (err) {
        return { error: friendlyError(err) };
      }
    };

    ipc.handle("apogee:crowns", (_e, args) => guarded(async () => {
      const seen = Array.isArray(args?.seen) ? args.seen.filter((id: unknown) => typeof id === "string" && UUID.test(id)).slice(0, 50) : undefined;
      return { board: await this.refreshCrowns(seen) };
    })());

    ipc.handle("apogee:challengeCrown", (_e, args) => guarded(async () => {
      const { category, window } = args ?? {};
      if (typeof category !== "string" || !category || category.length > 40) return { error: "That is not a Crown." };
      if (typeof window !== "number" || !Number.isInteger(window) || window < 0) return { error: "That is not a Crown." };
      return { match: await this.challenge(category, window) };
    })());

    ipc.handle("apogee:races", () => guarded(async () => ({ board: await this.refreshRaces() }))());

    ipc.handle("apogee:raceAction", (_e, args) => guarded(async () => this.raceAction(args ?? {}))());

    ipc.handle("apogee:raceLive", () => guarded(async () => ({ view: (await this.pollLive()) ?? this.live }))());
  }
}

/**
 * The social features in the main process: Apogee Daily, challenge links, open challenges
 * and Discord Rich Presence, wired with one call from main.ts.
 *
 * Kept out of main.ts on purpose, as ghostService.ts is: main.ts is where every screen is
 * wired, and the less of this lives there the less a change here and a change to first-run
 * flow can collide. main.ts makes the calls it has to (the run hook, the single-instance
 * argv, macOS's open-url) and this does the rest.
 *
 * CHALLENGE LINKS
 *
 * A link reaches the app three ways: the command line of a first launch (Windows, Linux),
 * the argv a second launch hands the first through `second-instance`, and macOS's
 * `open-url`. All three go through `receive`, which parses with the allow-list grammar in
 * core/social/deepLinks.ts and then only PROPOSES: the renderer shows what the link is and
 * the player confirms it. The confirmation names the proposal by id and carries nothing
 * else, so the renderer cannot swap in a code of its own. Link text never reaches a shell,
 * `shell.openExternal`, a file path or `eval`; a refused link is reported by which rule it
 * broke, never echoed.
 */

import { app, clipboard, ipcMain } from "electron";

import { friendlyError, isNotDeployed, type FoundMatch } from "./api.ts";
import { acceptOpenDuel, cancelOpenDuel, createOpenDuel, fetchOpenDuels, viewOpenDuel } from "./socialApi.ts";
import { DailyService, type DailyScreen } from "./dailyService.ts";
import { DiscordPresence } from "./discordPresence.ts";
import { loadSocialState, saveSocialState } from "./socialStore.ts";
import { bandIndex } from "../core/social/daily.ts";
import {
  landingUrl,
  linkFromArgv,
  parseDeepLink,
  parsePastedLink,
  PROTOCOL,
  REFUSAL_TEXT,
  type DeepLink,
  type LinkParse,
} from "../core/social/deepLinks.ts";
import { isOpenDuelCode, isOpenDuelView, type OpenDuelView } from "../core/social/openDuel.ts";
import { activityFor, type PresenceState } from "../core/social/presence.ts";

/** Replaced at build time by esbuild's `define` from APOGEE_DISCORD_CLIENT_ID (buildApp.mjs). */
declare const __APOGEE_DISCORD_CLIENT_ID__: string;
const DISCORD_CLIENT_ID = typeof __APOGEE_DISCORD_CLIENT_ID__ === "string" ? __APOGEE_DISCORD_CLIENT_ID__ : "";

/** How often presence is recomputed while it is on. Discord allows five updates in 20 s. */
const PRESENCE_TICK_MS = 15_000;

export interface LinkProposal {
  id: number;
  kind: DeepLink["kind"];
  code: string | null;
  state: "checking" | "ready" | "signed-out" | "refused" | "working" | "done" | "error";
  title: string;
  lines: string[];
  /** The confirm button's words, or null when there is nothing to confirm. */
  confirm: string | null;
  error: string | null;
  duel: OpenDuelView | null;
  /** The screen to show once it is done. */
  navigate: "daily" | "ghost" | "queue" | null;
}

export interface SocialDeps {
  statsDir: () => string | null;
  signedIn: () => boolean;
  queueBand: () => number | null;
  broadcast: (channel: string, payload: unknown) => void;
  notify: (message: string) => void;
  /** Bring the window forward for a link that arrived while it was behind something. */
  focus: () => void;
  adoptMatch: (match: FoundMatch) => void;
  /** An open challenge taken back before it was played voided its match. */
  matchVoided: (matchId: string) => void;
  /** Race a ghost code: Ghost Mode's own "link" action. */
  ghostLink: (code: string) => Promise<{ error?: string }>;
  launch: (scenario: string) => Promise<{ ok: boolean; error?: string }>;
  /** What the player is in, for presence: the active match and ghost race, as main holds them. */
  activity: () => {
    match: { id: string; category: string; mode: "ranked" | "duel" | "open" | "tournament" | "seeding" } | null;
    ghost: { startedAt: number; friend: boolean } | null;
  };
  log: (line: string) => void;
}

export interface Social {
  daily: DailyService;
  onRun: (run: { scenario: string; playedAt: Date | null }) => void;
  receiveArgv: (argv: unknown) => void;
  receive: (raw: unknown, source: "argv" | "open-url" | "paste") => void;
  registerProtocol: () => void;
  dispose: () => void;
}

export function installSocial(deps: SocialDeps): Social {
  const daily = new DailyService({
    statsDir: deps.statsDir,
    signedIn: deps.signedIn,
    queueBand: deps.queueBand,
    broadcast: (screen: DailyScreen) => deps.broadcast("apogee:daily", screen),
    launch: deps.launch,
    copyText: (text) => clipboard.writeText(text),
  });
  daily.arm();

  // ---- challenge links -------------------------------------------------------------

  let pending: LinkProposal | null = null;
  let nextId = 1;
  const publish = () => deps.broadcast("apogee:link", pending);

  const propose = (p: Omit<LinkProposal, "id">): LinkProposal => {
    pending = { ...p, id: nextId++ };
    publish();
    return pending;
  };
  const update = (id: number, patch: Partial<LinkProposal>) => {
    if (!pending || pending.id !== id) return;
    pending = { ...pending, ...patch };
    publish();
  };

  async function lookUpDuel(id: number, code: string): Promise<void> {
    try {
      const raw = await viewOpenDuel(code);
      if (!isOpenDuelView(raw)) {
        update(id, { state: "error", error: "The server answered in a shape this version does not know. Update Apogee and try again." });
        return;
      }
      const lines = [
        `${raw.category} · ${raw.band}`,
        "Unrated: an open challenge never moves anybody's rating.",
        "You play the same three scenarios. Their score stays hidden until yours is in.",
      ];
      if (raw.answers > 0) lines.push(`${raw.answers} ${raw.answers === 1 ? "player has" : "players have"} answered it.`);
      update(id, {
        state: raw.refusal ? "refused" : "ready",
        title: raw.yours ? "Your open challenge" : `Open challenge from ${raw.from}`,
        lines,
        duel: raw,
        error: raw.refusal,
        confirm: raw.refusal ? null : "Accept and play",
      });
    } catch (err) {
      update(id, {
        state: "error",
        error: isNotDeployed(err) ? "Open challenges are not live on the server yet." : friendlyError(err),
      });
    }
  }

  /** The link behind the pending proposal, to look it up again once the player signs in. */
  let pendingLink: DeepLink | null = null;

  function receiveParsed(parsed: LinkParse, source: "argv" | "open-url" | "paste"): void {
    if (!parsed.ok) {
      // Said by rule, never by echoing the text: a link's text is the attacker's.
      deps.notify(REFUSAL_TEXT[parsed.reason]);
      deps.log(`refused a ${source} link: ${parsed.reason}`);
      return;
    }
    const link = parsed.link;
    pendingLink = link;
    if (source !== "paste") deps.focus();

    if (link.kind === "daily") {
      daily.propose(link.band ? bandIndex(link.band) : null);
      const today = daily.view().number;
      if (link.number !== null && link.number !== today) {
        deps.notify(link.number > today
          ? `That link is for Apogee Daily #${link.number}, which has not started. Here is today's.`
          : `That link was for Apogee Daily #${link.number}. Here is today's, #${today}.`);
      }
      propose({ kind: "daily", code: null, state: "done", title: "Apogee Daily", lines: [], confirm: null, error: null, duel: null, navigate: "daily" });
      return;
    }

    if (link.kind === "ghost") {
      propose({
        kind: "ghost",
        code: link.code,
        state: deps.signedIn() ? "ready" : "signed-out",
        title: "Race a ghost",
        lines: [
          `Ghost code ${link.code}`,
          "Somebody's three runs, raced against your own baselines. Unrated, and nothing is sent until you start.",
        ],
        confirm: deps.signedIn() ? "Set up the race" : null,
        error: deps.signedIn() ? null : "Sign in with Steam to race a ghost: the code is looked up on the server.",
        duel: null,
        navigate: "ghost",
      });
      return;
    }

    const p = propose({
      kind: "duel",
      code: link.code,
      state: deps.signedIn() ? "checking" : "signed-out",
      title: "Open challenge",
      lines: [`Challenge code ${link.code}`],
      confirm: null,
      error: deps.signedIn() ? null : "Sign in with Steam to answer a challenge.",
      duel: null,
      navigate: "queue",
    });
    if (deps.signedIn()) void lookUpDuel(p.id, link.code);
  }

  const receive = (raw: unknown, source: "argv" | "open-url" | "paste") =>
    receiveParsed(source === "paste" ? parsePastedLink(raw) : parseDeepLink(raw), source);

  const receiveArgv = (argv: unknown) => {
    const parsed = linkFromArgv(argv);
    if (parsed) receiveParsed(parsed, "argv");
  };

  async function confirm(id: unknown): Promise<{ ok: boolean; error?: string; navigate?: string | null }> {
    if (!pending || pending.id !== id) return { ok: false, error: "That link was replaced by a newer one." };
    const p = pending;
    if (p.state !== "ready" || !p.code) return { ok: false, error: p.error ?? "There is nothing to confirm." };
    update(p.id, { state: "working", error: null });
    if (p.kind === "ghost") {
      const r = await deps.ghostLink(p.code);
      if (r.error) {
        update(p.id, { state: "error", error: r.error });
        return { ok: false, error: r.error };
      }
      pending = null;
      publish();
      return { ok: true, navigate: "ghost" };
    }
    try {
      const match = await acceptOpenDuel(p.code);
      deps.adoptMatch(match);
      pending = null;
      publish();
      return { ok: true, navigate: "queue" };
    } catch (err) {
      const error = friendlyError(err);
      update(p.id, { state: "error", error });
      return { ok: false, error };
    }
  }

  ipcMain.handle("apogee:link", () => pending);
  ipcMain.handle("apogee:linkAction", async (_e, raw: unknown) => {
    const a = (raw && typeof raw === "object" ? raw : {}) as { type?: unknown; id?: unknown; text?: unknown };
    try {
      if (a.type === "confirm") return await confirm(a.id);
      if (a.type === "dismiss") {
        if (pending && pending.id === a.id) {
          pending = null;
          publish();
        }
        return { ok: true };
      }
      // A link that arrived before the saved session was restored (a first launch from a
      // link) said "sign in"; once signed in, the renderer asks for it to be looked at again.
      if (a.type === "recheck") {
        if (pending && pending.id === a.id && pending.state === "signed-out" && deps.signedIn() && pendingLink) {
          receiveParsed({ ok: true, link: pendingLink }, "paste");
        }
        return { ok: true };
      }
      if (a.type === "paste") {
        if (typeof a.text !== "string" || a.text.length > 512) return { ok: false, error: REFUSAL_TEXT["too-long"] };
        const parsed = parsePastedLink(a.text);
        if (!parsed.ok) return { ok: false, error: REFUSAL_TEXT[parsed.reason] };
        receiveParsed(parsed, "paste");
        return { ok: true };
      }
      return { ok: false, error: "unknown action" };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  });

  // ---- open challenges ----------------------------------------------------------------

  ipcMain.handle("apogee:openChallenge", async (_e, raw: unknown) => {
    const a = (raw && typeof raw === "object" ? raw : {}) as { action?: unknown; category?: unknown; code?: unknown };
    if (!deps.signedIn()) return { error: "Sign in with Steam to post or answer a challenge." };
    try {
      switch (a.action) {
        case "create": {
          if (typeof a.category !== "string" || !a.category || a.category.length > 40) return { error: "Pick a category." };
          const band = deps.queueBand();
          if (band === null) return { error: "Your history is still loading. Try again in a moment." };
          const match = await createOpenDuel(a.category, band);
          deps.adoptMatch(match);
          return { match, link: match.duel?.code ? landingUrl({ kind: "duel", code: match.duel.code }) : null };
        }
        case "mine":
          return await fetchOpenDuels();
        case "copy": {
          if (!isOpenDuelCode(a.code)) return { error: "That is not a challenge code." };
          const link = landingUrl({ kind: "duel", code: a.code });
          clipboard.writeText(link);
          return { ok: true, link };
        }
        case "cancel": {
          if (!isOpenDuelCode(a.code)) return { error: "That is not a challenge code." };
          const r = await cancelOpenDuel(a.code);
          if (r.matchVoided) deps.matchVoided(r.matchVoided);
          return r;
        }
        default:
          return { error: "unknown action" };
      }
    } catch (err) {
      return { error: isNotDeployed(err) ? "Open challenges are not live on the server yet." : friendlyError(err) };
    }
  });

  // ---- the Daily ----------------------------------------------------------------------

  ipcMain.handle("apogee:daily", () => {
    try {
      return daily.view();
    } catch (err) {
      return { error: friendlyError(err) };
    }
  });
  ipcMain.handle("apogee:dailyAction", async (_e, action: unknown) => {
    try {
      return await daily.action(action);
    } catch (err) {
      return { error: friendlyError(err) };
    }
  });

  // ---- Discord Rich Presence ----------------------------------------------------------

  const presence = new DiscordPresence({ clientId: DISCORD_CLIENT_ID, log: deps.log });
  let presenceTimer: NodeJS.Timeout | null = null;
  let matchSeen: { id: string; at: number } | null = null;

  const presenceState = (): PresenceState => {
    const now = Date.now();
    const { match, ghost } = deps.activity();
    if (match) {
      if (matchSeen?.id !== match.id) matchSeen = { id: match.id, at: now };
      return { kind: "match", category: match.category, since: matchSeen.at, mode: match.mode };
    }
    matchSeen = null;
    if (ghost) return { kind: "ghost", since: ghost.startedAt, friend: ghost.friend };
    const d = daily.presence();
    if (d) return { kind: "daily", number: d.number, band: d.band, since: d.since };
    return { kind: "idle" };
  };
  const tick = () => {
    try {
      presence.update(activityFor(presenceState()));
    } catch (err) {
      deps.log(`presence tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const applyPresence = (on: boolean) => {
    presence.setEnabled(on);
    if (on && presence.available) {
      tick();
      if (!presenceTimer) {
        presenceTimer = setInterval(tick, PRESENCE_TICK_MS);
        presenceTimer.unref?.();
      }
    } else if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
  };
  applyPresence(loadSocialState().discord);

  const settingsView = () => ({
    discord: loadSocialState().discord,
    discordAvailable: presence.available,
    discordConnected: presence.connected,
  });
  ipcMain.handle("apogee:socialSettings", () => settingsView());
  ipcMain.handle("apogee:setSocialSettings", (_e, raw: unknown) => {
    const patch = (raw && typeof raw === "object" ? raw : {}) as { discord?: unknown };
    if (typeof patch.discord === "boolean") {
      saveSocialState({ discord: patch.discord });
      applyPresence(patch.discord);
    }
    return settingsView();
  });

  return {
    daily,
    onRun: (run) => {
      daily.onRun(run);
      if (presenceTimer) tick();
    },
    receiveArgv,
    receive,
    registerProtocol: () => {
      // Packaged builds only. `electron .` registering itself would take the scheme from an
      // installed copy on the same machine; in development, paste a link into the app.
      if (!app.isPackaged) return;
      try {
        if (!app.isDefaultProtocolClient(PROTOCOL)) app.setAsDefaultProtocolClient(PROTOCOL);
      } catch (err) {
        deps.log(`could not register ${PROTOCOL}:// links: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    dispose: () => {
      if (presenceTimer) clearInterval(presenceTimer);
      presence.dispose();
    },
  };
}

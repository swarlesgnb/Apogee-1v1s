/**
 * Discord Rich Presence, the pure half: what Apogee tells Discord, and how a message is
 * framed on Discord's local socket.
 *
 * Opt-in and off by default (src/app/discordPresence.ts holds the socket and the setting).
 * What a player's Discord friends see is decided here and nowhere else, and it is
 * deliberately little: what kind of thing the player is doing, the category or daily it
 * is in, and how long they have been at it. Never a score, a rating, a rank, an opponent's
 * name or a code: those are either somebody else's or the kind of thing a player chooses
 * to post, and presence is not a post. PRIVACY.md lists the same three things.
 *
 * Discord's local RPC protocol, as its own clients and the published discord-rpc library
 * speak it: connect to `discord-ipc-0` .. `discord-ipc-9` (a named pipe on Windows, a unix
 * socket elsewhere); every message is an 8-byte header, opcode then length as little-endian
 * uint32, followed by that many bytes of JSON. Opcode 0 is the handshake ({ v: 1,
 * client_id }), 1 a command frame, 2 close, 3 ping, 4 pong.
 */

export type PresenceState =
  | { kind: "match"; category: string; since: number; mode: "ranked" | "duel" | "open" | "tournament" | "seeding" }
  | { kind: "ghost"; since: number; friend: boolean }
  | { kind: "daily"; number: number; band: string; since: number }
  | { kind: "idle" };

export interface DiscordActivity {
  details: string;
  state?: string;
  timestamps: { start: number };
  assets?: { large_image: string; large_text: string };
  instance: false;
}

/** Discord truncates past 128 characters; anything that long here is a bug, not a name. */
const FIELD_MAX = 128;
const clip = (s: string) => s.slice(0, FIELD_MAX);

/** Category names come from the season; nothing else from the outside world reaches Discord. */
const SAFE_TEXT = /^[\p{L}\p{N} '&()+,./:#-]{1,64}$/u;
const safe = (s: string | null | undefined): string | null => (s && SAFE_TEXT.test(s) ? s : null);

const MATCH_DETAILS: Record<Extract<PresenceState, { kind: "match" }>["mode"], string> = {
  ranked: "In a ranked match",
  duel: "In a duel",
  open: "In an open challenge",
  tournament: "In a tournament match",
  seeding: "Setting a run for the pool",
};

/** The activity for a state, or null to clear it. */
export function activityFor(s: PresenceState): DiscordActivity | null {
  const assets = { large_image: "apogee", large_text: "Apogee: ranked 1v1 for KovaaK's" };
  switch (s.kind) {
    case "match": {
      const category = safe(s.category);
      return {
        details: clip(MATCH_DETAILS[s.mode]),
        ...(category ? { state: clip(category) } : {}),
        timestamps: { start: s.since },
        assets,
        instance: false,
      };
    }
    case "ghost":
      return { details: s.friend ? "Racing a friend's ghost" : "Racing a ghost", timestamps: { start: s.since }, assets, instance: false };
    case "daily": {
      const band = safe(s.band);
      return {
        details: clip(`Playing Apogee Daily #${Math.trunc(s.number)}`),
        ...(band ? { state: clip(band) } : {}),
        timestamps: { start: s.since },
        assets,
        instance: false,
      };
    }
    default:
      return null;
  }
}

/** A stable string for an activity, so an unchanged one is not sent again. */
export function activityKey(a: DiscordActivity | null): string {
  return a ? JSON.stringify([a.details, a.state ?? "", a.timestamps.start]) : "";
}

// ---------------------------------------------------------------------------
// the wire
// ---------------------------------------------------------------------------

export const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 } as const;

/** Largest message read from Discord. Real ones are a few kilobytes. */
export const MAX_FRAME = 64 * 1024;

export function encodeFrame(op: number, payload: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const out = new Uint8Array(8 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, op, true);
  view.setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

/**
 * Take whole frames off the front of a buffer. Returns the frames and what is left over.
 * A frame that claims to be larger than MAX_FRAME, or is not JSON, throws: the socket is
 * then closed rather than read on.
 */
export function decodeFrames(buffer: Uint8Array): { frames: { op: number; data: unknown }[]; rest: Uint8Array } {
  const frames: { op: number; data: unknown }[] = [];
  let offset = 0;
  while (buffer.length - offset >= 8) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 8);
    const op = view.getUint32(0, true);
    const len = view.getUint32(4, true);
    if (len > MAX_FRAME) throw new Error(`a Discord frame of ${len} bytes is larger than any real one`);
    if (buffer.length - offset - 8 < len) break;
    const text = new TextDecoder().decode(buffer.subarray(offset + 8, offset + 8 + len));
    frames.push({ op, data: JSON.parse(text) });
    offset += 8 + len;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export function handshake(clientId: string) {
  return { v: 1, client_id: clientId };
}

export function setActivity(pid: number, activity: DiscordActivity | null, nonce: string) {
  return { cmd: "SET_ACTIVITY", args: { pid, activity }, nonce };
}

/** A Discord application id: a snowflake, 17 to 20 digits. Anything else leaves presence off. */
export function isClientId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9]{17,20}$/.test(id);
}

/**
 * Where Discord listens, in the order its clients try. Windows uses a named pipe; macOS and
 * Linux a socket in the runtime or temp directory, including the Flatpak and Snap builds'
 * own subdirectories.
 */
export function socketCandidates(platform: string, env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (let i = 0; i < 10; i++) {
    if (platform === "win32") {
      out.push(`\\\\?\\pipe\\discord-ipc-${i}`);
      continue;
    }
    const base = (env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || "/tmp").replace(/\/+$/, "");
    out.push(`${base}/discord-ipc-${i}`);
    out.push(`${base}/app/com.discordapp.Discord/discord-ipc-${i}`);
    out.push(`${base}/snap.discord/discord-ipc-${i}`);
  }
  return out;
}

/**
 * Discord Rich Presence over Discord's local socket, with Node's `net` and nothing else.
 *
 * Entirely inert unless both are true: the build carries a Discord application id
 * (APOGEE_DISCORD_CLIENT_ID in .env, baked in by build:app, see SETUP.md), and the player
 * turned "Show what I'm playing on Discord" on. Off by default. With either missing no
 * socket is opened, nothing is polled and nothing is sent.
 *
 * What is sent is `activityFor` in src/core/social/presence.ts: the kind of thing being
 * played, its category or daily number, and an elapsed timer. Nothing else.
 *
 * Discord not running is the normal case, not an error: the connection is retried every
 * RETRY_MS while presence is on, quietly, and a socket that errors is dropped and retried
 * the same way. Nothing here can throw into the main process.
 */

import { connect, type Socket } from "node:net";

import {
  activityKey,
  decodeFrames,
  encodeFrame,
  handshake,
  isClientId,
  OP,
  setActivity,
  socketCandidates,
  type DiscordActivity,
} from "../core/social/presence.ts";

/** How often a missing Discord is looked for again while presence is on. */
const RETRY_MS = 30_000;
/** How long one socket path gets to answer before the next is tried. */
const CONNECT_TIMEOUT_MS = 1_500;

export interface PresenceOptions {
  clientId: string;
  /** For validate:presence, which serves a fake Discord on a temporary socket. */
  candidates?: string[];
  pid?: number;
  log?: (line: string) => void;
}

export class DiscordPresence {
  private enabled = false;
  private socket: Socket | null = null;
  private ready = false;
  private buffer: Uint8Array = new Uint8Array(0);
  private retry: NodeJS.Timeout | null = null;
  private connecting = false;
  private wanted: DiscordActivity | null = null;
  private sentKey: string | null = null;
  private nonce = 0;

  constructor(private readonly options: PresenceOptions) {}

  /** True when this build can show presence at all. */
  get available(): boolean {
    return isClientId(this.options.clientId);
  }

  get connected(): boolean {
    return this.ready;
  }

  setEnabled(on: boolean): void {
    const next = on && this.available;
    if (next === this.enabled) return;
    this.enabled = next;
    if (next) this.connectSoon(0);
    else this.shutdown();
  }

  /** The activity to show, or null to clear it. Sent once connected, and only when it changed. */
  update(activity: DiscordActivity | null): void {
    this.wanted = activity;
    if (this.enabled && this.ready) this.flush();
  }

  private log(line: string): void {
    this.options.log?.(`discord presence: ${line}`);
  }

  private connectSoon(delay: number): void {
    if (!this.enabled || this.retry || this.connecting || this.socket) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.tryConnect();
    }, delay);
    this.retry.unref?.();
  }

  private async tryConnect(): Promise<void> {
    if (!this.enabled || this.socket || this.connecting) return;
    this.connecting = true;
    try {
      const paths = this.options.candidates ?? socketCandidates(process.platform, process.env);
      for (const path of paths) {
        if (!this.enabled) return;
        const socket = await this.open(path);
        if (!socket) continue;
        this.attach(socket);
        return;
      }
      this.connectSoon(RETRY_MS);
    } finally {
      this.connecting = false;
    }
  }

  private open(path: string): Promise<Socket | null> {
    return new Promise((resolve) => {
      const socket = connect(path);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        socket.removeAllListeners("connect");
        socket.removeAllListeners("error");
        if (!ok) socket.destroy();
        resolve(ok ? socket : null);
      };
      const timer = setTimeout(() => done(false), CONNECT_TIMEOUT_MS);
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    this.ready = false;
    this.sentKey = null;
    this.buffer = new Uint8Array(0);
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.drop());
    socket.on("close", () => this.drop());
    socket.write(encodeFrame(OP.HANDSHAKE, handshake(this.options.clientId)));
  }

  private onData(chunk: Buffer): void {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer, 0);
    joined.set(chunk, this.buffer.length);
    let frames;
    try {
      ({ frames, rest: this.buffer } = decodeFrames(joined));
    } catch (err) {
      this.log(`unreadable message, closing (${err instanceof Error ? err.message : String(err)})`);
      this.drop();
      return;
    }
    for (const frame of frames) {
      const data = frame.data as { cmd?: string; evt?: string } | null;
      if (frame.op === OP.PING) this.socket?.write(encodeFrame(OP.PONG, frame.data));
      else if (frame.op === OP.CLOSE) this.drop();
      else if (frame.op === OP.FRAME && data?.cmd === "DISPATCH" && data.evt === "READY") {
        this.ready = true;
        this.log("connected");
        this.flush();
      }
    }
  }

  private flush(): void {
    const key = activityKey(this.wanted);
    if (!this.socket || key === this.sentKey) return;
    this.sentKey = key;
    this.socket.write(encodeFrame(OP.FRAME, setActivity(this.options.pid ?? process.pid, this.wanted, String(++this.nonce))));
  }

  private drop(): void {
    const had = this.socket;
    this.socket = null;
    this.ready = false;
    this.sentKey = null;
    had?.removeAllListeners();
    // A socket with no error listener throws into the process on a late error.
    had?.on("error", () => undefined);
    had?.destroy();
    if (this.enabled) this.connectSoon(RETRY_MS);
  }

  /** Clear what Discord shows and close the socket. Turning presence off must leave nothing behind. */
  private shutdown(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const socket = this.socket;
    if (socket && this.ready) {
      try {
        socket.write(encodeFrame(OP.FRAME, setActivity(this.options.pid ?? process.pid, null, String(++this.nonce))));
      } catch {
        /* closing anyway */
      }
    }
    this.socket = null;
    this.ready = false;
    this.sentKey = null;
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.end();
      setTimeout(() => socket.destroy(), 200).unref?.();
    }
  }

  dispose(): void {
    this.enabled = false;
    this.shutdown();
  }
}

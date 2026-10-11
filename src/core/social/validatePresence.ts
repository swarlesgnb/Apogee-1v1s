/**
 * Validate Discord Rich Presence against a fake Discord on a local socket.
 *
 *   npm run validate:presence
 *
 * The client (src/app/discordPresence.ts) speaks to whatever listens on the socket it is
 * given, so a server here plays Discord: it reads the handshake, answers READY, and
 * records every frame. Checked:
 *
 *   - inert: with no application id, or with presence off (the default), no connection is
 *     ever made;
 *   - the handshake carries the id and protocol version 1, and activity is sent only after
 *     READY, only when it changed, and cleared when presence is turned off;
 *   - PING is answered with PONG, and a frame larger than any real one closes the socket
 *     rather than being read;
 *   - what friends see: each state's words, an elapsed timer, and nothing else; a category
 *     with characters no season name has is left out rather than sent;
 *   - the framing round-trips, including a frame split across reads.
 */

import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiscordPresence } from "../../app/discordPresence.ts";
import { activityFor, decodeFrames, encodeFrame, isClientId, MAX_FRAME, OP, socketCandidates, type PresenceState } from "./presence.ts";

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
  } else if (process.env.VERBOSE) console.log(`  ok   ${name}${detail ? `: ${detail}` : ""}`);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await wait(10);
  }
  return cond();
}

const CLIENT_ID = "123456789012345678";
const dir = mkdtempSync(join(tmpdir(), "apogee-discord-"));

interface FakeDiscord {
  server: Server;
  path: string;
  connections: number;
  frames: { op: number; data: any }[];
  sockets: Socket[];
  close: () => Promise<void>;
}

function fakeDiscord(name: string, opts: { ready?: boolean } = {}): Promise<FakeDiscord> {
  const path = join(dir, name);
  const fake: FakeDiscord = { server: null as unknown as Server, path, connections: 0, frames: [], sockets: [], close: async () => {} };
  fake.server = createServer((socket) => {
    fake.connections++;
    fake.sockets.push(socket);
    let buffer = new Uint8Array(0);
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      const joined = new Uint8Array(buffer.length + chunk.length);
      joined.set(buffer);
      joined.set(chunk, buffer.length);
      const { frames, rest } = decodeFrames(joined);
      buffer = new Uint8Array(rest);
      for (const f of frames) {
        fake.frames.push(f);
        if (f.op === OP.HANDSHAKE && opts.ready !== false) {
          socket.write(encodeFrame(OP.FRAME, { cmd: "DISPATCH", evt: "READY", data: { v: 1 } }));
        }
      }
    });
  });
  fake.close = () => new Promise((r) => {
    for (const s of fake.sockets) s.destroy();
    fake.server.close(() => r());
  });
  return new Promise((r) => fake.server.listen(path, () => r(fake)));
}

const activity = (s: PresenceState) => activityFor(s);
const since = Date.UTC(2026, 9, 3, 20, 0, 0);

// ---- what friends see -----------------------------------------------------------------
console.log("what friends see");
const ranked = activity({ kind: "match", category: "Precise Tracking", since, mode: "ranked" });
check("a ranked match: 'In a ranked match', its category, an elapsed timer", ranked?.details === "In a ranked match" && ranked.state === "Precise Tracking" && ranked.timestamps.start === since);
check("a ghost race", activity({ kind: "ghost", since, friend: false })?.details === "Racing a ghost");
check("a friend's ghost", activity({ kind: "ghost", since, friend: true })?.details === "Racing a friend's ghost");
const daily = activity({ kind: "daily", number: 14, band: "Intermediate", since });
check("the Daily: 'Playing Apogee Daily #14', its band", daily?.details === "Playing Apogee Daily #14" && daily.state === "Intermediate");
check("an open challenge says so", activity({ kind: "match", category: "Speed Switching", since, mode: "open" })?.details === "In an open challenge");
check("idle clears the activity", activity({ kind: "idle" }) === null);
const keys = new Set<string>();
for (const s of [ranked, daily, activity({ kind: "ghost", since, friend: true })]) for (const k of Object.keys(s ?? {})) keys.add(k);
check("nothing but details, state, an elapsed timer and the logo is ever sent", [...keys].sort().join() === "assets,details,instance,state,timestamps");
check("a category with characters no season name has is left out", activity({ kind: "match", category: "<img src=x onerror=alert(1)>", since, mode: "ranked" })?.state === undefined);
check("an overlong category is left out", activity({ kind: "match", category: "x".repeat(200), since, mode: "ranked" })?.state === undefined);
check("an application id is a snowflake", isClientId(CLIENT_ID) && !isClientId("") && !isClientId("abc") && !isClientId("1".repeat(25)));

// ---- framing ---------------------------------------------------------------------------
console.log("framing");
const frame = encodeFrame(OP.FRAME, { cmd: "SET_ACTIVITY", args: { pid: 1 } });
check("a frame is opcode, length, JSON", new DataView(frame.buffer).getUint32(0, true) === 1 && new DataView(frame.buffer).getUint32(4, true) === frame.length - 8);
const two = new Uint8Array([...frame, ...encodeFrame(OP.PING, { a: 1 })]);
const split = decodeFrames(two.subarray(0, frame.length + 5));
check("a frame split across reads waits for the rest", split.frames.length === 1 && split.rest.length === 5);
check("and completes when it arrives", decodeFrames(new Uint8Array([...split.rest, ...two.subarray(frame.length + 5)])).frames[0]?.op === OP.PING);
let threw = false;
try {
  const huge = new Uint8Array(8);
  new DataView(huge.buffer).setUint32(4, MAX_FRAME + 1, true);
  decodeFrames(huge);
} catch {
  threw = true;
}
check("a frame claiming more than 64 KiB is refused", threw);
check("Windows looks for a named pipe", socketCandidates("win32", {})[0] === "\\\\?\\pipe\\discord-ipc-0");
check("Linux looks in the runtime directory, Flatpak and Snap too", socketCandidates("linux", { XDG_RUNTIME_DIR: "/run/user/1000" }).slice(0, 3).join() === "/run/user/1000/discord-ipc-0,/run/user/1000/app/com.discordapp.Discord/discord-ipc-0,/run/user/1000/snap.discord/discord-ipc-0");

// ---- the client against a fake Discord ----------------------------------------------------
console.log("the client");
{
  const fake = await fakeDiscord("inert-id");
  const p = new DiscordPresence({ clientId: "", candidates: [fake.path] });
  p.setEnabled(true);
  p.update(ranked);
  await wait(300);
  check("with no application id: not available, no connection", !p.available && fake.connections === 0);
  p.dispose();
  await fake.close();
}
{
  const fake = await fakeDiscord("inert-off");
  const p = new DiscordPresence({ clientId: CLIENT_ID, candidates: [fake.path] });
  p.update(ranked);
  await wait(300);
  check("with an id but presence off (the default): no connection", p.available && fake.connections === 0);
  p.dispose();
  await fake.close();
}
{
  const fake = await fakeDiscord("live");
  const p = new DiscordPresence({ clientId: CLIENT_ID, candidates: [join(dir, "nobody-here"), fake.path], pid: 4242 });
  p.update(ranked);
  p.setEnabled(true);
  const connected = await until(() => fake.frames.some((f) => f.data?.cmd === "SET_ACTIVITY"));
  const hs = fake.frames[0];
  check("a missing socket is skipped for the next one", connected && fake.connections === 1);
  check("the handshake is version 1 with the application id", hs?.op === OP.HANDSHAKE && hs.data.v === 1 && hs.data.client_id === CLIENT_ID);
  const set = fake.frames.find((f) => f.data?.cmd === "SET_ACTIVITY");
  check("after READY the activity is sent, with the pid", set?.data.args.pid === 4242 && JSON.stringify(set.data.args.activity) === JSON.stringify(ranked));
  const sent = () => fake.frames.filter((f) => f.data?.cmd === "SET_ACTIVITY").length;
  p.update(activity({ kind: "match", category: "Precise Tracking", since, mode: "ranked" }));
  await wait(150);
  check("the same activity again is not resent", sent() === 1);
  p.update(daily);
  await until(() => sent() === 2);
  check("a changed activity is sent", sent() === 2 && fake.frames.at(-1)?.data.args.activity.details === "Playing Apogee Daily #14");
  fake.sockets[0].write(encodeFrame(OP.PING, { n: 7 }));
  await until(() => fake.frames.some((f) => f.op === OP.PONG));
  check("PING is answered with PONG", fake.frames.some((f) => f.op === OP.PONG && f.data.n === 7));
  p.setEnabled(false);
  await until(() => sent() === 3);
  check("turning presence off clears it", fake.frames.at(-1)?.data?.args?.activity === null);
  await wait(300);
  check("and closes the connection", !p.connected);
  p.dispose();
  await fake.close();
}
{
  const fake = await fakeDiscord("hostile");
  const p = new DiscordPresence({ clientId: CLIENT_ID, candidates: [fake.path] });
  p.setEnabled(true);
  const wasReady = await until(() => p.connected);
  const huge = new Uint8Array(8);
  new DataView(huge.buffer).setUint32(0, OP.FRAME, true);
  new DataView(huge.buffer).setUint32(4, MAX_FRAME * 4, true);
  fake.sockets[0].write(huge);
  const dropped = await until(() => !p.connected);
  check("an oversized frame from the socket closes it, and nothing throws", wasReady && dropped);
  p.dispose();
  await fake.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "OK" : "FAILED"}: ${checks - failures} of ${checks} presence checks passed`);
process.exit(failures > 0 ? 1 : 0);

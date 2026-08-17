/**
 * Desktop side of Steam sign-in.
 *
 * Implements the RFC 8252 native-app pattern: the app listens on an ephemeral loopback
 * port, sends the user to the browser to authenticate, and receives a single-use token
 * back on that port. No client secret is involved, because a desktop app cannot keep
 * one.
 *
 * The server half lives in supabase/functions/steam-auth/.
 */

import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";

export interface SteamAuthConfig {
  /** Public URL of the deployed steam-auth Edge Function. */
  functionUrl: string;
  /** How long to wait for the user to finish in the browser. */
  timeoutMs?: number;
  /**
   * How to send the user to the sign-in URL. Defaults to the system browser.
   *
   * Injectable so the loopback half can be tested without launching anything, and so a
   * failure to open a browser can be reported rather than leaving the user staring at
   * a button that appears to do nothing.
   */
  open?: (url: string) => void;
}

export interface SteamAuthResult {
  steamId: string;
  /** Single-use token to redeem via supabase.auth.verifyOtp. */
  tokenHash: string;
}

/**
 * How long to wait for the browser round trip.
 *
 * Long enough for a Steam login including a Steam Guard prompt, short enough that a
 * flow which silently failed does not leave the app unusable for five minutes.
 */
const DEFAULT_TIMEOUT_MS = 3 * 60_000;

/** Compare two strings without leaking length or content through timing. */
function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function openBrowser(url: string): void {
  // Windows `start` needs an empty title argument, otherwise a quoted URL is
  // swallowed as the window title and nothing opens.
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];

  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });

  // A browser that never opens leaves the user looking at a button that did nothing,
  // which is indistinguishable from a broken app. Surface it instead.
  child.on("error", (err) => {
    throw new Error(`could not open your browser: ${err.message}`);
  });

  child.unref();
}

function closeQuietly(server: Server): void {
  try {
    server.close();
  } catch {
    /* already closing */
  }
}

/**
 * Run the full sign-in flow. Resolves once Steam has been verified server-side and a
 * redeemable token has come back over loopback.
 */
export function signInWithSteam(config: SteamAuthConfig): Promise<SteamAuthResult> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 32 bytes of CSPRNG state; this is what stops a stray request on the loopback
  // port from being accepted as our callback.
  const state = randomBytes(32).toString("base64url");

  return new Promise<SteamAuthResult>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeQuietly(server);
      fn();
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (!url.pathname.startsWith("/callback")) {
        res.writeHead(404).end("Not found");
        return;
      }

      const reply = (status: number, message: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Apogee</title>` +
            `<body style="font:15px system-ui;padding:3rem;text-align:center">` +
            `<p>${message}</p></body>`,
        );
      };

      const returnedState = url.searchParams.get("state") ?? "";
      if (!safeEquals(returnedState, state)) {
        // Not our flow. Say nothing useful and do not settle the promise.
        reply(400, "Unexpected request.");
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        reply(400, "Sign-in failed. You can close this tab.");
        finish(() => reject(new Error(error)));
        return;
      }

      const steamId = url.searchParams.get("steam_id") ?? "";
      const tokenHash = url.searchParams.get("token_hash") ?? "";
      if (!/^7656\d{13}$/.test(steamId) || !tokenHash) {
        reply(400, "Sign-in failed. You can close this tab.");
        finish(() => reject(new Error("malformed callback")));
        return;
      }

      reply(200, "Signed in. You can close this tab and return to Apogee.");
      finish(() => resolve({ steamId, tokenHash }));
    });

    server.on("error", (err) => finish(() => reject(err)));

    // Port 0 asks the OS for a free ephemeral port; binding to 127.0.0.1 rather than
    // 0.0.0.0 keeps the listener off the network entirely.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;

      const start = new URL(`${config.functionUrl.replace(/\/$/, "")}/start`);
      start.searchParams.set("port", String(port));
      start.searchParams.set("state", state);

      timer = setTimeout(
        () => finish(() => reject(new Error("timed out waiting for Steam sign-in"))),
        timeoutMs,
      );

      try {
        (config.open ?? openBrowser)(start.toString());
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
  });
}

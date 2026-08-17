/**
 * Steam sign-in and session persistence for the desktop client.
 *
 * The flow, end to end:
 *
 *   1. `signInWithSteam` opens the system browser and listens on a loopback port
 *      (RFC 8252). Steam authenticates the user; our Edge Function verifies the
 *      assertion and hands back a single-use token over loopback.
 *   2. That token is redeemed here for a real Supabase session.
 *   3. The refresh token is stored **encrypted at rest** via Electron's safeStorage,
 *      which uses the OS keychain (DPAPI on Windows). A plaintext token in userData
 *      would be readable by anything else running as the user.
 *
 * The access token is deliberately not persisted: it is short-lived and is recovered
 * from the refresh token on launch.
 */

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { app, safeStorage, shell } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Injected at build time from .env (see tools/buildApp.mjs). The anon key is designed
 * to be public and ships inside the client; row-level security is what protects the
 * data, not this key.
 */
declare const __APOGEE_SUPABASE_URL__: string;
declare const __APOGEE_SUPABASE_ANON_KEY__: string;
declare const __APOGEE_STEAM_AUTH_URL__: string;

export const SUPABASE_URL =
  typeof __APOGEE_SUPABASE_URL__ === "string" ? __APOGEE_SUPABASE_URL__ : "";
export const SUPABASE_ANON_KEY =
  typeof __APOGEE_SUPABASE_ANON_KEY__ === "string" ? __APOGEE_SUPABASE_ANON_KEY__ : "";
export const STEAM_AUTH_URL =
  typeof __APOGEE_STEAM_AUTH_URL__ === "string" ? __APOGEE_STEAM_AUTH_URL__ : "";

export function isConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && STEAM_AUTH_URL);
}

/**
 * Open the system browser via Electron's own shell rather than spawning `cmd /c start`.
 *
 * Electron already knows how to do this correctly on every platform, and it reports
 * failure instead of returning a detached process that may or may not have worked.
 */
function openSystemBrowser(url: string): void {
  void shell.openExternal(url).catch((err) => {
    console.error("could not open the browser:", err);
  });
}

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!client) {
    if (!isConfigured()) {
      throw new Error(
        "Apogee was built without Supabase settings. Fill in .env and rebuild.",
      );
    }
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        // The desktop app manages its own persistence, encrypted, below.
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}

function tokenPath(): string {
  return join(app.getPath("userData"), "session.bin");
}

function saveRefreshToken(token: string): void {
  const path = tokenPath();
  mkdirSync(dirname(path), { recursive: true });

  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(path, safeStorage.encryptString(token));
    return;
  }

  // No OS keychain available. Rather than silently writing a bearer token in the
  // clear, stay signed out and make the user re-authenticate each launch.
  console.warn("OS encryption unavailable; the session will not be remembered");
}

function loadRefreshToken(): string | null {
  const path = tokenPath();
  if (!existsSync(path)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;

  try {
    return safeStorage.decryptString(readFileSync(path));
  } catch {
    // A token encrypted under a different OS profile or a reinstalled keychain.
    clearStoredSession();
    return null;
  }
}

export function clearStoredSession(): void {
  try {
    rmSync(tokenPath(), { force: true });
  } catch {
    /* nothing to remove */
  }
}

export interface ApogeeSession {
  playerId: string;
  steamId: string;
  displayName: string;
  avatarUrl: string | null;
  kovaaksUsername: string | null;
}

async function profileFor(session: Session): Promise<ApogeeSession | null> {
  const { data, error } = await supabase()
    .from("players")
    .select("id, steam_id, display_name, avatar_url, kovaaks_username")
    .eq("id", session.user.id)
    .maybeSingle();

  if (error || !data) return null;

  return {
    playerId: data.id,
    steamId: data.steam_id,
    displayName: data.display_name,
    avatarUrl: data.avatar_url,
    kovaaksUsername: data.kovaaks_username,
  };
}

/** Restore a session from the encrypted refresh token, if there is one. */
export async function restoreSession(): Promise<ApogeeSession | null> {
  if (!isConfigured()) return null;

  const refreshToken = loadRefreshToken();
  if (!refreshToken) return null;

  const { data, error } = await supabase().auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) {
    clearStoredSession();
    return null;
  }

  saveRefreshToken(data.session.refresh_token);
  return profileFor(data.session);
}

/**
 * Run the full Steam sign-in.
 *
 * @param openLoopback the loopback flow from src/core/sync/steamAuth.ts, injected so
 *   this module stays testable and does not reach for a browser on import.
 */
export async function signIn(
  openLoopback: (config: {
    functionUrl: string;
    open?: (url: string) => void;
  }) => Promise<{ steamId: string; tokenHash: string }>,
  onUrl?: (url: string) => void,
): Promise<ApogeeSession> {
  if (!isConfigured()) {
    throw new Error("Apogee was built without Supabase settings. Fill in .env and rebuild.");
  }

  const { tokenHash } = await openLoopback({
    functionUrl: STEAM_AUTH_URL,
    // The URL is reported as well as opened. If the browser fails to launch, or opens
    // the wrong one, the user can still finish by pasting it, instead of staring at a
    // button that appears to do nothing.
    open: (url) => {
      onUrl?.(url);
      openSystemBrowser(url);
    },
  });

  // The single-use token becomes a real session here, in the main process. It never
  // touches the renderer.
  const { data, error } = await supabase().auth.verifyOtp({
    token_hash: tokenHash,
    type: "magiclink",
  });

  if (error || !data.session) {
    throw new Error(error?.message ?? "Steam sign-in did not produce a session");
  }

  saveRefreshToken(data.session.refresh_token);

  const profile = await profileFor(data.session);
  if (!profile) throw new Error("signed in, but no player profile was found");
  return profile;
}

export async function signOut(): Promise<void> {
  clearStoredSession();
  if (client) await client.auth.signOut().catch(() => undefined);
}

/** Current access token, for calling the Edge Functions. */
export async function accessToken(): Promise<string | null> {
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * The bot's configuration, read from the repo's `.env`.
 *
 * Same minimal reader as tools/verifyDeployment.ts rather than a dependency: the file is
 * KEY=value lines and nothing more. Missing keys fail at startup with the key's name,
 * because a bot that boots without a token reports a generic 401 that points nowhere.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = readFileSync(join(ROOT, ".env"), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (m && m[2]) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const file = readEnvFile();

function get(key: string): string | undefined {
  return process.env[key] || file[key];
}

function need(key: string, where: string): string {
  const v = get(key);
  if (!v) throw new Error(`${key} is missing from .env (${where})`);
  return v;
}

export interface DiscordEnv {
  token: string;
  guildId: string;
  appId: string;
}

export function discordEnv(): DiscordEnv {
  const where = "see discord/README.md";
  return {
    token: need("DISCORD_TOKEN", where),
    guildId: need("DISCORD_GUILD_ID", where),
    appId: need("DISCORD_APP_ID", where),
  };
}

export interface ApogeeEnv {
  supabaseUrl: string;
  serviceKey: string;
  /** Optional: without it /link cannot prove Steam ownership and says so. */
  steamKey: string | undefined;
}

export function apogeeEnv(): ApogeeEnv {
  return {
    supabaseUrl: need("APOGEE_SUPABASE_URL", "Supabase project URL").replace(/\/+$/, ""),
    serviceKey: need("SUPABASE_SERVICE_ROLE_KEY", "Supabase service key"),
    steamKey: get("STEAM_WEB_API_KEY"),
  };
}

/**
 * The Apogee Discord bot.
 *
 *   npm run bot
 *
 * Slash commands are registered to the one guild on every start, which takes effect
 * immediately (global commands take up to an hour), so a renamed option is live the
 * moment the bot restarts. Pollers each run once at startup and then on their interval;
 * one failing is logged and retried next tick, never fatal, because a Supabase hiccup
 * shouldn't take /reflex down with it.
 */

import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  Partials,
  REST,
  Routes,
} from "discord.js";

import { loadSeason } from "../src/core/season/season.ts";
import { Apogee } from "./apogee.ts";
import type { Ctx, Feature } from "./core.ts";
import { discordEnv } from "./env.ts";
import { bounties } from "./features/bounties.ts";
import { callouts } from "./features/callouts.ts";
import { community, welcomeMember } from "./features/community.ts";
import { feed } from "./features/feed.ts";
import { games } from "./features/games.ts";
import { link } from "./features/link.ts";
import { moderation } from "./features/moderation.ts";
import { predictions } from "./features/predictions.ts";
import { sotd } from "./features/sotd.ts";
import { textChannel } from "./guild.ts";
import { Store } from "./store.ts";

export const FEATURES: Feature[] = [community, link, feed, predictions, sotd, bounties, callouts, games, moderation];

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function log(line: string): void {
  console.log(`[${stamp()}] ${line}`);
}

async function main(): Promise<void> {
  const env = discordEnv();
  const store = new Store();
  let apogee: Apogee | null = null;
  try {
    apogee = new Apogee();
  } catch (e) {
    log(`Apogee features off: ${e instanceof Error ? e.message : e}`);
  }
  const season = loadSeason();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  const commands = FEATURES.flatMap((f) => f.commands ?? []);
  const names = new Set<string>();
  for (const c of commands) {
    if (names.has(c.name)) throw new Error(`two features register /${c.name}`);
    names.add(c.name);
  }
  await new REST().setToken(env.token).put(Routes.applicationGuildCommands(env.appId, env.guildId), {
    body: commands.map((c) => c.toJSON()),
  });
  log(`registered ${commands.length} commands`);

  const ready = new Promise<void>((res) => client.once(Events.ClientReady, () => res()));
  await client.login(env.token);
  await ready;
  const guild = await client.guilds.fetch(env.guildId);
  await guild.channels.fetch();
  await guild.roles.fetch();
  const ctx: Ctx = { client: client as Client<true>, guild, store, apogee, season, log };
  log(`online as ${client.user!.tag} in ${guild.name}${apogee ? "" : " (Apogee off)"}`);
  client.user!.setActivity({ name: "KovaaK's 1v1s · /daily", type: ActivityType.Competing });

  const commandOwner = new Map<string, Feature>();
  for (const f of FEATURES) for (const name of Object.keys(f.onCommand ?? {})) commandOwner.set(name, f);
  const buttonOwner = new Map<string, Feature>();
  for (const f of FEATURES) for (const prefix of Object.keys(f.onButton ?? {})) buttonOwner.set(prefix, f);

  client.on(Events.InteractionCreate, async (i: Interaction) => {
    try {
      if (i.guildId !== guild.id) return;
      if (i.isChatInputCommand()) {
        await commandOwner.get(i.commandName)?.onCommand?.[i.commandName](ctx, i);
      } else if (i.isButton()) {
        const [prefix, ...args] = i.customId.split(":");
        await buttonOwner.get(prefix)?.onButton?.[prefix](ctx, i, args);
      }
    } catch (e) {
      log(`interaction failed: ${e instanceof Error ? e.stack : e}`);
      if (i.isRepliable()) {
        const body = { content: "Something broke on our side. It's been logged.", ephemeral: true };
        await (i.replied || i.deferred ? i.followUp(body) : i.reply(body)).catch(() => undefined);
      }
    }
  });

  client.on(Events.MessageCreate, async (m) => {
    if (m.author.bot || m.guildId !== guild.id) return;
    for (const f of FEATURES) {
      try {
        await f.onMessage?.(ctx, m);
      } catch (e) {
        log(`${f.name} message handler failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  });

  client.on(Events.MessageReactionAdd, async (r, user) => {
    for (const f of FEATURES) {
      try {
        await f.onReaction?.(ctx, r, user);
      } catch (e) {
        log(`${f.name} reaction handler failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.guild.id === guild.id && !member.user.bot) await welcomeMember(ctx, member);
  });

  for (const f of FEATURES) {
    for (const job of f.every ?? []) {
      let running = false;
      const tick = async () => {
        if (running) return;
        running = true;
        try {
          await job.run(ctx);
        } catch (e) {
          log(`${f.name} poller failed: ${e instanceof Error ? e.message : e}`);
        } finally {
          running = false;
        }
      };
      void tick();
      setInterval(tick, job.ms);
    }
  }

  await textChannel(guild, "botadmin")
    ?.send(`🟢 Online. ${commands.length} commands. Apogee ${apogee ? "connected" : "**not connected**"}.`)
    .catch(() => undefined);

  const shutdown = async () => {
    log("shutting down");
    await client.destroy();
    store.db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && /bot\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

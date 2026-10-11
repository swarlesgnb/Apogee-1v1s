/**
 * The standing messages in START HERE.
 *
 * Each carries a footer marker, and provision.ts finds its own previous copy by that
 * marker and edits it in place, so a rerun after a copy change updates the pinned
 * message instead of stacking a second one under it.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";

import { ACCENT, FAN_ROLES, PING_ROLES, REGION_ROLES } from "./blueprint.ts";
import { LEVEL_ROLES, STAR_THRESHOLD } from "./rules.ts";

export const REPO = "https://github.com/swarlesgnb/Apogee-1v1s";

export interface Panel {
  key: string;
  channel: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

export function marker(key: string): string {
  return `apogee · ${key}`;
}

function embed(key: string): EmbedBuilder {
  return new EmbedBuilder().setColor(ACCENT).setFooter({ text: marker(key) });
}

/** `ch` turns a blueprint channel key into a mention, which needs the live channel id. */
export function panels(rankNames: string[], ch: (key: string) => string): Panel[] {
  const welcome = embed("welcome")
    .setTitle("Apogee: ranked 1v1 for KovaaK's")
    .setDescription(
      [
        "Queue a category, get matched against someone near your rank, play three scenarios in KovaaK's as normal, and the ladder settles itself.",
        "",
        "Scores are read straight from your stats folder. Nobody types a number in, here or in the app.",
        "",
        `**Get the client:** ${REPO}/releases`,
        `**Link your account:** ${ch("link")} unlocks your rank role, the match feed, predictions and bounties.`,
        `**Pick your roles:** ${ch("roles")}`,
      ].join("\n"),
    )
    .addFields(
      {
        name: "The ladder",
        value: rankNames.join(" → ") + "\nYour role here is your rank in the app, synced every few minutes.",
      },
      {
        name: "Stardust ✦",
        value:
          "The server's currency. Earned by chatting, `/daily`, playing ranked, bounties, Scenario of the Day and good calls in #predictions. Spent in `/shop`. It never touches your rating.",
      },
      {
        name: "Levels",
        value: LEVEL_ROLES.map((l) => `${l.level}: ${l.name}`).join(" · "),
      },
      {
        name: "Things to do",
        value: [
          "`/reflex` how fast are you, really",
          "`/flick` five targets, one at a time",
          "`/trivia` know your scenarios",
          "`/callout @someone` and settle it in a ranked duel",
          `⭐ a clip in ${ch("clips")} ${STAR_THRESHOLD} times to put it in ${ch("hof")}`,
        ].join("\n"),
      },
    );

  const rules = embed("rules")
    .setTitle("Rules")
    .setDescription(
      [
        "**1. Be decent.** Trash talk about aim is fine. About people, it isn't.",
        "**2. No cheating talk.** No selling, sharing or asking for anything that touches scores or the stats folder.",
        "**3. Disputes go through the app.** A voided match has a dispute path in FAIR-PLAY.md, so don't relitigate it in chat.",
        "**4. No invites or ads.** Discord invite links are removed automatically.",
        `**5. Keep channels on topic.** Clips in ${ch("clips")}, setups in ${ch("setups")}, everything else in ${ch("offtopic")}.`,
        "**6. Never share your keys.** Nobody from Apogee will ever ask for your Steam login or the contents of your `.env`.",
        "",
        "Mods warn first and time out second. Repeat it and you're out.",
      ].join("\n"),
    );

  const link = embed("link")
    .setTitle("Link your Apogee account")
    .setDescription(
      [
        "Linking proves the Steam account you play Apogee on is yours. It takes a minute and never asks for a password.",
        "",
        "**1.** `/link start steam:` with your Steam profile URL or SteamID64",
        "**2.** Put the code it gives you anywhere in your Steam **profile name** (or Real Name) for a moment",
        "**3.** `/link confirm`, then change your name back",
        "",
        "You need to have signed in to Apogee at least once. Unlinking is `/link remove`.",
      ].join("\n"),
    );

  const roles = embed("roles")
    .setTitle("Pick your roles")
    .setDescription(
      [
        "Click to toggle. Click again to remove.",
        "",
        "**Aim type** you main · **Region** for finding scrims · **Pings** you want",
        ...PING_ROLES.map((p) => `• **${p.name}**: ${p.note}`),
      ].join("\n"),
    );

  const row = (names: string[], style: ButtonStyle) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      names.map((n) => new ButtonBuilder().setCustomId(`role:${n}`).setLabel(n).setStyle(style)),
    );

  return [
    { key: "welcome", channel: "welcome", embeds: [welcome], components: [] },
    { key: "rules", channel: "rules", embeds: [rules], components: [] },
    { key: "link", channel: "link", embeds: [link], components: [] },
    {
      key: "roles",
      channel: "roles",
      embeds: [roles],
      components: [
        row(FAN_ROLES, ButtonStyle.Primary),
        row(REGION_ROLES, ButtonStyle.Secondary),
        row(
          PING_ROLES.map((p) => p.name),
          ButtonStyle.Success,
        ),
      ],
    },
  ];
}

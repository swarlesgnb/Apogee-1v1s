# Apogee Discord

The community server's bot. `provision.ts` builds the server from `blueprint.ts`;
`bot.ts` runs everything in it.

```
npm run bot:provision -- --dry-run   what would change
npm run bot:provision                build or repair the server (never deletes anything)
npm run bot                          run the bot
npm run validate:discord             rules, blueprint and the read-only guarantee, offline
```

## Setup

1. Discord Developer Portal → the application → **Bot**: turn on **Server Members Intent**
   and **Message Content Intent**. Without them login fails with "Used disallowed intents".
2. Invite it with scopes `bot applications.commands` and the Administrator permission:
   `https://discord.com/oauth2/authorize?client_id=<DISCORD_APP_ID>&scope=bot+applications.commands&permissions=8&guild_id=<DISCORD_GUILD_ID>`
3. `.env` (gitignored) needs `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_APP_ID`, plus the
   `APOGEE_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `STEAM_WEB_API_KEY` already there.
4. `npm run bot:provision`. If it says the bot's role sits below the Apogee roles, drag the
   bot's role to the top in Server Settings → Roles and run it again. A second run should
   print "No changes".
5. Give yourself the **Admin** role, then `npm run bot`.

## What it does

| | |
|---|---|
| `/link` | Proves Steam ownership with a code in the Steam profile name; grants Verified and the rank role |
| Rank roles | Every 5 min, each linked member's role follows `ratings.tier_id`; rank-ups post to #promotions |
| #match-feed | Every settled match by a linked player, with rating change and win streaks |
| #leaderboard | Linked players by rating, plus most improved this week; edited hourly |
| #predictions | Back or fade a linked player's open match; parimutuel, 15-minute window |
| #scenario-of-the-day | A seeded season scenario per UTC day, ranked by verified runs; top 3 paid |
| #bounties | Three weekly goals checked against real matches; `/bounties` claims |
| `/callout` `/rivals` | Public challenges, settled with an in-app duel |
| `/reflex` `/flick` `/trivia` | Mini-games; rewards capped at 10 paid rounds a day |
| `/daily` `/shop` `/give` `/profile` `/top` | Stardust, streaks, name colours, titles, Streak Shields |
| Levels | Chat XP on a 60 s cooldown, six launch-themed level roles |
| Starboard | 5 ⭐ on a #clips post reposts it to #hall-of-fame |
| `/event double-xp` | Staff; weekends are a Stardust Storm (×1.5) automatically |
| `/warn` `/timeout` `/warnings` | Logged to #mod-log; invite links are removed automatically |

## Boundaries

The bot **reads** Apogee and never writes to it. `apogee.ts` holds the only Supabase
client, has no write calls, and `validate:discord` fails if one appears or if a feature
reaches Supabase around it. It uses the service key because RLS limits player reads to
the player themself, which is exactly why it must never write.

Its own state (links, XP, stardust, bets) lives in `discord/.data/apogee-bot.db`,
gitignored. Losing it costs the community layer its memory; rank roles and the feed are
re-derived from Apogee on the next poll. Nothing here touches `supabase/**`, so there is
nothing to deploy.

The bot runs only while this machine is on.

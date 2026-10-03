# Setting up Apogee

Two halves: creating the Supabase project the client talks to, and running the client
itself. Assumes no prior Supabase experience. Roughly 20 minutes, most of it waiting for
the project to provision.

The code side needs nothing: the schema applies cleanly to a real Postgres, the seed
loads, and the row-level security policies pass `npm run validate:schema`. What follows
is pointing it at a live project and getting a window on screen.

If the backend is already deployed and you only want the app running, skip to
[§6, Run the client](#6-run-the-client).

---

## 0. Before you start

```bash
npm install
```

Nothing else in this document works without it. The tooling is all local: `tsx` runs
every script below, `supabase` is what `npx supabase` resolves to, and Electron is what
`npm start` launches. Skip the install and the first command fails with `'tsx' is not
recognized`, which reads like a broken machine rather than a missing step.

Developed and verified on Node 22. Nothing pins a minimum, so older versions may work,
but that is untested.

## 1. Create the project

1. Go to supabase.com/dashboard and sign in (GitHub login is easiest).
2. Click New project.
3. Fill in:
   - Name: `apogee` is fine. Only you see it.
   - Database password: click *Generate a password*, then **save it somewhere
     safe immediately**. You need it in step 3 and Supabase will not show it again.
   - Region: pick the one closest to where your players are. This is the single
     hardest thing to change later, since it means recreating the project. For a
     mostly-US aim community, an East or West US region is the safe pick.
   - Plan: Free is enough. Apogee's entire dataset is small; the free tier's limits
     are far above what a closed beta will touch.
4. Click Create new project and wait. Provisioning takes one to three minutes.

> On the free plan a project pauses after about a week with no activity. Nothing is
> lost, but the first request afterwards fails until you un-pause it from the dashboard.
> Worth knowing before you conclude something is broken.

## 2. Copy the three values

Open Project Settings (the gear, bottom-left). All three live under the API headings,
but which page holds which has moved more than once, and the project URL is often not on
the same page as the keys. Look for the labels rather than a click path:

| Dashboard label | Goes in `.env` as | What it is |
|---|---|---|
| Project URL | `APOGEE_SUPABASE_URL` | The address of your project |
| `anon` `public`, or `publishable` | `APOGEE_SUPABASE_ANON_KEY` | Safe to ship inside the desktop app |
| `service_role` `secret` | `SUPABASE_SERVICE_ROLE_KEY` | **Never** ship this |

The distinction matters more than anything else in this document.

The anon key is designed to be public. It is compiled into the client, and row-level
security is what actually protects your data. Someone holding it can only do what your
RLS policies allow, which is: read reference data, insert their own runs, read their own
rows. That is why the schema was written the way it was.

The service_role key bypasses row-level security entirely. Anyone holding it can
read, edit, or delete every row in your database, including rewriting ratings and match
results. It belongs only in Edge Function secrets on Supabase's servers. Never put it in
the desktop client, never commit it, never paste it into a Discord thread when asking
for help.

`.env` is already in `.gitignore`, so filling it in will not commit anything.

## 3. Fill in `.env`

Copy `.env.example` to `.env` (`cp .env.example .env`, or `copy .env.example .env` in
PowerShell); the blanks are marked. Paste each value after its `=`, with no quotes and no
spaces. The value is read verbatim to the end
of the line, so a stray quote becomes part of the key:

```
APOGEE_SUPABASE_URL=https://abcdefghijk.supabase.co
APOGEE_SUPABASE_ANON_KEY=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
```

Projects created before mid-2025 issue the older JWT-style keys instead, which begin
`eyJhbGciOi...`. Either format works; the newer ones are simply easier to tell apart at
a glance, which is worth something given how different their privileges are.

The Project URL must be the bare origin, with no path. Copying the REST endpoint
(`.../rest/v1/`) is the easy mistake: the client libraries append their own paths, so
every request then resolves somewhere that does not exist.

Then set the two derived values in the same file:

```
APOGEE_STEAM_AUTH_URL=https://abcdefghijk.supabase.co/functions/v1/steam-auth
STEAM_AUTH_FUNCTION_URL=https://abcdefghijk.supabase.co/functions/v1/steam-auth
```

Both are your project URL with `/functions/v1/steam-auth` on the end. They are separate
variables because one is read by the desktop client and the other by the Edge Function
itself.

Optionally `STEAM_WEB_API_KEY`, from steamcommunity.com/dev/apikey. Without it sign-in
still works, but players get a generic display name and no avatar: the function reads the
key as an empty string and skips the profile lookup.

Optionally `APOGEE_DISCORD_CLIENT_ID`, for Discord Rich Presence. Create an application at
discord.com/developers/applications and copy its Application ID (17 to 20 digits) from
General Information. Uploading an image named `apogee` under Rich Presence -> Art Assets
gives the presence its logo; without one Discord shows the text alone. The id is public by
design and is baked into the client by `npm run build:app`, like the URL and anon key.
Without it the client opens no Discord socket at all and the toggle in Links & Discord is
greyed out. With it, presence is still off until a player turns it on.

### Which command needs which value

Nothing reads all of them, and a missing one usually surfaces as a confusing failure
several steps after the point it was needed.

| | URL | anon | service_role | `STEAM_AUTH_FUNCTION_URL` |
|---|---|---|---|---|
| `npm run build:app`, `start`, `dev` | yes | yes | — | as `APOGEE_STEAM_AUTH_URL` |
| `npm run sync:reference` | yes | — | yes | — |
| `npm run verify:deployment` | yes | yes | yes | yes |

`npm run doctor` checks every one of them and names whichever is missing, which is faster
than reading this table.

## 4. Deploy

Already done for project Apogee (`upzdvxfclfdskklhxfql`, us-east-2, Postgres 17.6).
The sequence below is the one to run for a second environment, and the order matters: the
sync writes to columns the migrations create, the functions read what the sync wrote, and
`steam-auth` will not boot without its secret.

```bash
npx supabase login                            # interactive; needs a real terminal
npx supabase link --project-ref <ref>
npx supabase db push --yes                    # tables, policies, triggers
npm run sync:reference                        # scenarios, score models, world records
npm run deploy:functions                      # every one of them
npx supabase secrets set \
  STEAM_AUTH_FUNCTION_URL=https://<ref>.supabase.co/functions/v1/steam-auth
npm run verify:deployment                     # proves it against the live API
```

Append `STEAM_WEB_API_KEY=...` to that `secrets set` line if you have one. The command
takes any number of assignments, so setting just the one is fine.

Three mistakes, all of which happened during the real deploy:

- Do not reach for `--include-seed`. `db push` on its own does not apply the seed,
  which is what sends people looking for the flag, but `--include-seed` **silently skips
  a seed it has already recorded**. On the second run it updates the stored hash, reports
  success, and applies nothing. The columns exist and stay null, which looks like a code
  bug rather than a deploy one. `npm run sync:reference` replaces it: an idempotent
  upsert that never touches player rows, and can be re-run whenever reference data
  changes.

- Every function has to go up, not just `steam-auth`.
  `npm run deploy:functions` does them in one pass. `verify:deployment` asserts every one
  is live, so deploying only the auth bridge fails verification in a way that looks like a
  broken deploy rather than an incomplete one.

- `SUPABASE_*` names are reserved. Supabase injects `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY` and friends into every Edge Function automatically, and
  refuses to let you set them as secrets. Only the custom `STEAM_*` names need setting,
  which is why `secrets set --env-file .env` is the wrong command here.

## 5. The functions

```bash
npm run deploy:functions
```

| Function | JWT | What it does |
|---|---|---|
| `steam-auth` | no | Steam OpenID 2.0 bridge. Steam's servers call it directly and cannot present a JWT, which is why this one is public |
| `submit-run` | yes | Parses the raw CSV **server-side**, verifies it, stores it, recomputes the baseline |
| `find-match` | yes | Picks an opponent by rating and generates the scenario set from a server seed |
| `settle-match` | yes | Recomputes deltas from stored rows, settles, applies Glicko-2 |
| `abandon-match` | yes | Closes out a match nobody is going to finish, without letting either side dodge the loss |
| `refresh-baselines` | yes | Recomputes a player's baselines when their run history changes underneath them |
| `refresh-apex` | yes | Recomputes a player's post-rank standing from their KovaaK's-verified bests, for the public apex board |
| `apex-board` | yes | Serves the public apex leaderboard, joining display names with the service role so `apex_standing` never has to be world-readable |
| `send-duel` | yes | Creates a seeding match addressed at one named player, plus the `duels` row pointing at it |
| `answer-duel` | yes | Accepts, declines, or withdraws a duel; accepting builds the contested match from the challenger's side |
| `list-duels` | yes | Everything the duel panel shows, with names joined under the service role since `players` is owner-only |
| `daily-submit` | yes | Puts a finished Apogee Daily on the day's board: redraws the day, re-verifies the three CSVs, rebuilds each baseline from runs the server held before the day began |
| `daily-board` | yes | One band of one day as a distribution and the caller's place in it, never another player's name; refuses a day that has not started |
| `open-duel` | yes | Open challenges by code: post one (your three first), look a code up, answer it with an unrated match, take one back, list yours |

Every function except `steam-auth` requires a session, and `npm run verify:deployment`
asserts they refuse anonymous callers. It goes one step further for `find-match` and
`settle-match`, the two that can move a rating on their own, and proves they also
refuse the anon key as a caller identity. The anon key identifies the app, never a player.

`submit-run` takes the raw CSV rather than a parsed summary, so the integrity checks
run over the file as KovaaK's wrote it. A client cannot present a tidy summary that
contradicts rows it never sent.

Challenge links. The packaged client registers the `apogee://` scheme the first time it
runs (`electron-builder.yml` `protocols` covers macOS and Linux; on Windows the app calls
`setAsDefaultProtocolClient` itself, since the NSIS installer does not). A development
build does not register, so it never takes the scheme from an installed copy; paste a link
into Links & Discord instead, or pass one on the command line: `npx electron . apogee://daily`.
The https form of every link lands on `site/c/index.html`, which `npm run build:site`
writes beside the front page; publish both directories together.

## 6. Run the client

```bash
npm run doctor     # preflight: Node, Electron, .env, bundle freshness, stats folder, season
npm start          # build the client and launch it
```

`npm run dev` is the same as `npm start` but rebuilds and relaunches on every save, which
is what you want while changing anything under `src/app/`. `npm run smoke` boots
headlessly, asserts the window rendered, and exits. That is useful over SSH or in a
check script, where there is nobody to look at a window.

Run `doctor` first. Every line in it exists because the answer to a real half-hour of
confusion was further up the stack than where the looking started.

Apogee reads scores from your KovaaK's stats folder. It finds it by asking the
registry where Steam is, then walking `libraryfolders.vdf` for every library on the
machine and probing `steamapps/common/FPSAimTrainer/FPSAimTrainer/stats` in each. That
covers a normal install on any drive. When it comes up empty, whether from a moved
folder or a non-Steam copy, `doctor` prints every path it tried, and Apogee → Choose
folder… in the menu points it at the right one. That choice is remembered, so it is asked
once.

`.env` is baked into the client at build time. The project URL, anon key and auth
function URL are compiled into `dist/app/main.cjs` (`clientEnv` in `tools/buildApp.mjs`);
the service role key is never read there and would be a serious mistake to include.
Editing `.env` therefore changes nothing until the next `npm run build:app`, which
`npm start` and `npm run dev` do for you, but which matters after
[rotating a key](#rotate-the-keys-when-convenient). Building with any of the three
missing prints a warning and produces a client with sign-in disabled, rather than failing.

A running window keeps the bundle it started with, so a client change needs a relaunch.
`doctor` says outright when the bundle is older than a source file.

## Verified live

`npm run verify:deployment` checks the claims the design rests on against the deployed
project, not a local copy:

- 1,498 scenarios and 261 benchmark memberships, readable with the anon key
- the anon key cannot write to `ratings`, `matches`, `scenarios`, or `runs` (401)
- an anonymous reader sees no other player's rows
- every authenticated function is deployed and refuses anonymous callers
- `steam-auth` answers without a JWT, because Steam's servers call it directly and
  cannot supply one
- `/start` redirects to Steam's OpenID endpoint with our callback as the return address
- an invalid loopback port, a missing state, and a forged Steam assertion are all
  rejected

It only reads, so it is safe to point at production whenever something looks wrong.

## Rotate the keys when convenient

Any secret that has passed through a chat, a screenshot, or a support thread should be
rolled once things work. Rotate them from the API keys page under Project Settings,
then:

1. Update `APOGEE_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`.
2. **Rebuild the client** with `npm run build:app`. The old anon key is compiled into the
   existing bundle and goes on being used until you do.
3. `npm run verify:deployment`, to confirm the new keys work against the live project.

There is no `secrets set` to re-run. The only secrets you own are
`STEAM_AUTH_FUNCTION_URL` and `STEAM_WEB_API_KEY`, and rotating Supabase keys touches
neither; the `SUPABASE_*` values the functions use are injected by Supabase and roll on
their own.

## If something goes wrong

- `'tsx' is not recognized`, or an `npm run` script failing instantly: dependencies
  were never installed. `npm install`.
- `db push` says the migration already applied: harmless, it is idempotent.
- `functions deploy` fails on login: run `npx supabase login` again; the token
  expires.
- `verify:deployment` reports a function is not deployed: only `steam-auth` went up.
  Run `npm run deploy:functions`.
- Columns exist but are null after a deploy: the seed was skipped. Run
  `npm run sync:reference`.
- Steam sign-in fails with "Steam could not confirm this sign-in": `STEAM_AUTH_FUNCTION_URL`
  does not exactly match the deployed function's URL. Steam checks that the return
  address matches the realm it was given.
- Everything 401s: the anon key was pasted where the service role key belongs, or
  the reverse.
- Sign-in is disabled, or the app behaves as though `.env` were empty: the bundle
  predates the `.env` edit. `npm run build:app`, then relaunch.
- `No handler registered for apogee:…`, and every button does nothing: a stale bundle
  against a newer renderer. Same fix, or use `npm run dev`.
- "Could not find your KovaaK's stats folder": `npm run doctor` lists every path it
  probed; Apogee → Choose folder… sets it for good.

Nothing here is destructive. If the project ends up in a bad state, deleting it in the
dashboard and starting again costs only the provisioning wait.

# Deploying Apogee's backend

A one-time walkthrough for creating the Supabase project and pushing the schema. Assumes
no prior Supabase experience. Roughly 15 minutes, most of it waiting for the project to
provision.

Everything on the code side is already done and verified: the schema applies cleanly to
a real Postgres, the seed loads, and the row-level security policies are proven correct
(`npm run validate:schema`). This is only about pointing it at a live project.

---

## 1. Create the project

1. Go to **supabase.com/dashboard** and sign in (GitHub login is easiest).
2. Click **New project**.
3. Fill in:
   - **Name**: `apogee` is fine. Only you see it.
   - **Database password**: click *Generate a password*, then **save it somewhere
     safe immediately**. You need it in step 3 and Supabase will not show it again.
   - **Region**: pick the one closest to where your players are. This is the single
     hardest thing to change later, since it means recreating the project. For a
     mostly-US aim community, an East or West US region is the safe pick.
   - **Plan**: Free is enough. Apogee's entire dataset is small; the free tier's limits
     are far above what a closed beta will touch.
4. Click **Create new project** and wait. Provisioning takes one to three minutes.

> On the free plan a project **pauses after about a week with no activity**. Nothing is
> lost, but the first request afterwards fails until you un-pause it from the dashboard.
> Worth knowing before you conclude something is broken.

## 2. Copy the three values

In the dashboard, open **Project Settings** (the gear, bottom-left), then **API**.

You are looking for three things:

| Dashboard label | Goes in `.env` as | What it is |
|---|---|---|
| Project URL | `APOGEE_SUPABASE_URL` | The address of your project |
| `anon` `public` key | `APOGEE_SUPABASE_ANON_KEY` | Safe to ship inside the desktop app |
| `service_role` `secret` key | `SUPABASE_SERVICE_ROLE_KEY` | **Never** ship this |

**The distinction matters more than anything else in this document.**

The **anon key** is designed to be public. It is compiled into the client, and row-level
security is what actually protects your data. Someone holding it can only do what your
RLS policies allow, which is: read reference data, insert their own runs, read their own
rows. That is why the schema was written the way it was.

The **service_role key bypasses row-level security entirely.** Anyone holding it can
read, edit, or delete every row in your database, including rewriting ratings and match
results. It belongs only in Edge Function secrets on Supabase's servers. Never put it in
the desktop client, never commit it, never paste it into a Discord thread when asking
for help.

`.env` is already in `.gitignore`, so filling it in will not commit anything.

## 3. Fill in `.env`

A `.env` file has been created for you with the blanks marked. Open it and paste each
value after its `=`, with no quotes and no spaces:

```
APOGEE_SUPABASE_URL=https://abcdefghijk.supabase.co
APOGEE_SUPABASE_ANON_KEY=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
```

Projects created before mid-2025 issue the older JWT-style keys instead, which begin
`eyJhbGciOi...`. Either format works; the newer ones are simply easier to tell apart at
a glance, which is worth something given how different their privileges are.

The Project URL must be the **bare origin**, with no path. Copying the REST endpoint
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

Optionally, a **Steam Web API key** from steamcommunity.com/dev/apikey. Without it,
sign-in still works but players get a generic display name and no avatar.

## 4. Deploy

Done for project **Apogee** (`upzdvxfclfdskklhxfql`, us-east-2, Postgres 17.6). The
sequence, for reference or for a second environment:

```bash
npx supabase login                            # interactive; needs a real terminal
npx supabase link --project-ref <ref>
npx supabase db push --yes                    # tables, policies, triggers
npx supabase db push --include-seed --yes     # reference data
npx supabase functions deploy steam-auth
npx supabase secrets set STEAM_AUTH_FUNCTION_URL=... STEAM_WEB_API_KEY=...
npm run verify:deployment                     # proves it against the live API
```

Three things that are easy to get wrong, all of which bit during the real deploy:

- **`db push` does not apply the seed.** It needs `--include-seed`, which is a separate
  pass after the migrations land.
- **`--include-seed` silently skips a seed it has already recorded.** On the second run
  it updates the stored hash, reports success, and applies nothing. The columns exist
  and stay null, which looks like a code bug rather than a deploy one. Reference data
  is therefore synced explicitly instead:

  ```bash
  npm run sync:reference     # idempotent upsert; never touches player rows
  ```

- **`SUPABASE_*` names are reserved.** Supabase injects `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY` and friends into every Edge Function automatically, and
  refuses to let you set them as secrets. Only the custom names need setting, which is
  why `secrets set --env-file .env` is the wrong command here.

## The functions

```bash
npm run deploy:functions
```

| Function | JWT | What it does |
|---|---|---|
| `steam-auth` | no | Steam OpenID 2.0 bridge. Steam's servers call it directly and cannot present a JWT, which is why this one is public |
| `submit-run` | yes | Parses the raw CSV **server-side**, verifies it, stores it, recomputes the baseline |
| `find-match` | yes | Picks an opponent by rating and generates the scenario set from a server seed |
| `settle-match` | yes | Recomputes deltas from stored rows, settles, applies Glicko-2 |

The three that move ratings require a session, and `npm run verify:deployment` asserts
they refuse both anonymous callers and the anon key. The anon key identifies the app,
never a player.

`submit-run` takes the **raw CSV rather than a parsed summary**, so the integrity checks
run over the file as KovaaK's wrote it. A client cannot present a tidy summary that
contradicts rows it never sent.

## Verified live

`npm run verify:deployment` checks the claims the design rests on against the deployed
project, not a local copy:

- **248 scenarios**, **261 benchmark memberships**, readable with the anon key
- the anon key **cannot** write to `ratings`, `matches`, `scenarios`, or `runs` (401)
- an anonymous reader sees no other player's rows
- `steam-auth` answers without a JWT, because Steam's servers call it directly and
  cannot supply one
- `/start` redirects to Steam's OpenID endpoint with our callback as the return address
- an invalid loopback port, a missing state, and a **forged Steam assertion** are all
  rejected

## Rotate the keys when convenient

Any secret that has passed through a chat, a screenshot, or a support thread should be
rolled once things work. **Project Settings → API → Rotate**, then update `.env` and
re-run `npx supabase secrets set`. It costs nothing and takes seconds.

## If something goes wrong

- **`db push` says the migration already applied**: harmless, it is idempotent.
- **`functions deploy` fails on login**: run `npx supabase login` again; the token
  expires.
- **Steam sign-in returns "Steam rejected the assertion"**: `STEAM_AUTH_FUNCTION_URL`
  does not exactly match the deployed function's URL. Steam checks that the return
  address matches the realm it was given.
- **Everything 401s**: the anon key was pasted where the service role key belongs, or
  the reverse.

Nothing here is destructive. If the project ends up in a bad state, deleting it in the
dashboard and starting again costs only the provisioning wait.

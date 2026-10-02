# Background refresh and verification hardening

Snapshot updates retain the newest state while the app is hidden or unfocused. Returning to the app paints once and refreshes practice data. Expedition also postpones DOM replacement, preserving progress updates from the main process.

Verified now requires matching nonempty hash and challenge start, finite matching scores, and a server epoch within three minutes of the corrected local end time. Ranked verification also checks the server epoch against the match window. Missing evidence degrades to the existing local grading policy; it does not automatically reject honest runs.

Ranked submissions cannot skip the match window by omitting the filename timestamp. Unknown scenarios and malformed timezone offsets are refused. Missing or out-of-window timestamps no longer extend a match deadline.

## Evidence

- 64 offline provenance assertions, including valid records, missing fields, stale-day replay, invalid timestamps and match-window checks.
- 14 cases invoke the bundled submit-run handler with isolated database/auth boundaries, including valid acceptance and rejection without unauthorized writes.
- Actual Chromium renderer: 100 unfocused snapshot updates performed no snapshot renders; focus painted the latest once. This proves rendering behavior, not improved game FPS.
- Expedition UI: background deferral, campaigns, all 122 rewards, compact layouts, reduced motion, WebGL lifecycle and focus checks passed in the focused Expedition suite.
- Typecheck, Edge imports/names, presentation checks, desktop smoke, live KovaaK's contract checks and local RLS attack checks passed.
- Corpus verification checked 14,193 genuine runs without a hard rejection. This corpus did not contain ranked match windows; separate adversarial fixtures cover those guards.

## Boundaries and remaining work

The broader UI suite fails its queue-fit assertion at 1440x1080 on both this branch and the unchanged baseline: button bottom 1048.5 versus inner height 1015. Existing standing and season-file bounds failures also predate this work.

The CSV attack harness still produces coherent miss-to-hit forgeries and an unmodelled score edit that survive hard checks. Local coherence cannot establish authenticity, and Consistent still counts under the current rating policy. The accuracy advisory is not supplied by the live submission path. Review that path, semantic replay protection, baseline trust and settlement next.

Earlier MiracastPowerManager crashes and WerFault bursts remain a lead for the reported FPS drops, not a proven cause. There is no game frame-time capture correlating those events, and no Windows services or recording settings were changed. A later one-hour Event 1000 query returned no matching events; this does not demonstrate a fix.

Source changes need backend deployment before server-side protections are live. No backend deployment or installer release is included.

## Second pass: replay and settlement

The old database accepted two different byte hashes for the same player, scenario and end instant in different matches. The migration test reproduces this before applying migration 21. Afterward, a claim table reserves that identity independently of CSV formatting, including after privileged deletion of a run. Existing duplicate rows are retained as evidence; their identities are reserved without rewriting historical results.

Runs receive a server-owned match submission time when first attached to a match. Settlement orders attempts by that receipt and then row ID, rather than the client-supplied play time. Claiming an older history row cannot put it ahead of a run already submitted to the match. Existing ranked rows use created_at as the best available historical receipt; actual historical claim times cannot be recovered.

Match baselines now require both played_at and server-owned created_at to predate the match. A Postgres-backed test drives the shipped baseline query with five genuine prior rows and 50 later uploads with backdated play times: only the five prior rows count. Ordinary history refresh still sees all 55. Uploading fabricated history before queueing remains a separate trust limitation.

Validation includes the migration with existing duplicate history, replay refusal, receipt ordering, history claims, protected columns, and retained claims after deletion; the actual settlement handler with both completed and abandoned first-attempt controls; schema/seed application; RLS attacks; typecheck; and function imports/names. Tests run against isolated local Postgres and mocked identity boundaries, not production traffic. Separate simultaneous database connections have not been exercised; replay exclusion relies on the database primary key.

Deployment order: apply migration 20261002000021_ranked_run_claims.sql before deploying settle-match and the functions importing baselineFor. Deploying the new ordering without its column would fail. Server-issued provenance is still required to authenticate a timestamp: changing the claimed run identity is outside the cosmetic-replay protection this migration establishes.

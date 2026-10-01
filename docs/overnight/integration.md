# September 30 work integrated on October 1

The delivery includes every `overnight/*` branch, including the later ghost-links and
share commits. The unfinished ghost-link function, rate limit, deployment inventory,
validator, and share-panel files have been incorporated as well.

The integration completes the missing client wiring: the result screens load the share
panel, and Ghost Mode accepts a friend's code. Friend races explain each side's own
baseline, unmeasured practice rounds, and their exclusion from the past-self streak.
Friend results do not offer share cards: that renderer describes a past-self race on a
shared baseline. Main refuses them too. This resolves the combined branch's type error.

## Checks run

- TypeScript typecheck, app build, and desktop smoke test passed. The smoke test found
  14,153 stats files, rendered the client, and observed all three past-self ghost choices.
- Ghost core and friend-link validation passed against the local stats library. The
  friend replay exercised 206 links, 618 rounds, 112 practice races, and 50 races decided
  on exactly two measured rounds.
- Ghost UI checks passed, including code submission, distinct friend baselines,
  practice-abandon copy, past-self flow, result timing, narrow layout, and seeding offer.
- `validate:share` passed real main-process rendering at 1200x675 and 1080x1920 for both
  ranked and past-self results, PNG saving, copy callback, save cancellation, void
  refusal, and shipped panel controls. The test substitutes the clipboard callback and
  save dialog; it does not establish native clipboard or dialog behavior.
- Schema checks passed in local Postgres; function checks read all 17 functions.
- Every command in `npm run validate` was run (continuing separately after the first
  failure). All passed except the two existing failing validators below.
- `git diff --check` passed. The portrait card and friend-ready screenshot were inspected.

## Existing failures reproduced on main before integration

- `validate:standing`: two assertions fail because the supplied scores earn zero
  standing points and no scored family is placed on a sampled board.
- `validate:season-files`: ten scenario-profile comparisons fall outside the measured
  reference ranges: Gravclick Novice; Blastoff Novice, Intermediate and Advanced;
  Thread Novice; Arc Novice; and all four InvadersTS bands.

Both validators produced the same failures on main at `f853c20`. This integration does
not change their code or season data. The full validation suite is therefore not green.

## Scope

This integrates and pushes source. It does not deploy database migrations or Edge
Functions, publish an installer, or validate a live friend-to-friend race. Ghost codes
need the corresponding server deployment. Local past-self racing works without it.
Generated videos remain in their original ignored `media` folders; their reproducible
tooling and branding assets are included in source control.

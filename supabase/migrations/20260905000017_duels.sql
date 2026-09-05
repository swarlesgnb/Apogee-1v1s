-- ---------------------------------------------------------------------------
-- Duels: a match addressed at somebody
--
-- The ladder ships asynchronous (PLAN.md §6) and that part works with one person
-- online. What it does not do is give anybody a reason to come back: a pool match
-- is against a stored run from a stranger, nothing waits on you, and nobody
-- notices if you stop. At the size this launches at, a named person expecting an
-- answer is the only thing that does.
--
-- A duel is not a new kind of match. The challenger plays the seeding match that
-- already exists; accepting creates the same two-sided contested match find-match
-- has always created, with the opponent pinned by id rather than chosen by rating.
-- Settlement, verification, forfeit and the match clock are untouched.
--
-- WHAT THIS IS NOT FOR
--
-- Not a queue, not a lobby, and not a second write path into `matches`. Rows here
-- point at matches; they never duplicate what a match already knows.
-- ---------------------------------------------------------------------------

create type duel_status as enum ('open', 'accepted', 'declined', 'cancelled', 'expired');

-- One duel: who sent it, to whom, and the match they played to send it.
--
-- The challenger's score is deliberately NOT copied here. It lives on their side of
-- `match_id`, where the recipient has no side and so no read - and that is the point.
-- A recipient who could see how the challenger did before deciding whether to accept
-- is cherry-picking, which is the same thing find-match's one-open-match rule exists
-- to stop, pointed the other way.
create table duels (
  id                uuid primary key default gen_random_uuid(),
  challenger_id     uuid not null references players (id) on delete cascade,
  challenged_id     uuid not null references players (id) on delete cascade,

  -- The seeding match the challenger played. One side, settled unrated by the path
  -- settle-match already has for a match with nobody on the other end.
  match_id          uuid not null references matches (id) on delete cascade,

  -- The contested match created on accept. Null until then, which also makes it the
  -- repair flag: 'accepted' with nothing here is a function that died between the
  -- two writes, and the sweep reopens it.
  answer_match_id   uuid references matches (id) on delete set null,

  status            duel_status not null default 'open',
  created_at        timestamptz not null default now(),
  -- Days, not the eight minutes a match gets. A match deadline is how long you have
  -- to play three scenarios; a duel's is how long somebody has to notice it.
  expires_at        timestamptz not null,
  -- Stamped by the compare-and-swap that claims a duel, so a stalled accept can be
  -- told from a live one without holding a lock.
  claimed_at        timestamptz,
  answered_at       timestamptz,

  constraint duels_not_self check (challenger_id <> challenged_id)
);

comment on table duels is
  'A match addressed at a named player. Points at the challenger''s seeding match and, '
  'once accepted, at the contested match created from it. Written only by the duel Edge '
  'Functions under the service role; read by the two players it names.';

-- The inbox, which is the only query that matters for the feature to feel alive.
create index duels_inbox_idx on duels (challenged_id, status, created_at desc);

-- The outgoing list, and the duplicate check when one is sent.
create index duels_outbox_idx on duels (challenger_id, status, created_at desc);

-- Settlement asks "was this match somebody's duel?" for every match that settles,
-- including the pool matches that are not. Partial, because the answer is null for every
-- duel until it is accepted and the index has no reason to carry those.
create index duels_answer_idx on duels (answer_match_id) where answer_match_id is not null;

-- One live duel per ordered pair, so a misfire cannot fill somebody's inbox with the
-- same name. Partial on purpose: a declined or expired duel must not block the
-- rematch, which a plain unique constraint would do for good.
create unique index duels_one_open_idx
  on duels (challenger_id, challenged_id) where status = 'open';

-- A shortlist, not a relationship.
--
-- One-sided and consent-free: adding somebody puts them at the top of your picker and
-- tells them nothing. There is no request, no acceptance and no notification, because
-- none of that decides anything - the roster is already open to everyone signed in,
-- so a friends list is a convenience over a list you can already see.
create table friendships (
  player_id  uuid not null references players (id) on delete cascade,
  friend_id  uuid not null references players (id) on delete cascade,
  added_at   timestamptz not null default now(),

  primary key (player_id, friend_id),
  constraint friendships_not_self check (player_id <> friend_id)
);

comment on table friendships is
  'A one-sided shortlist for the duel picker. Decides nothing: a forged row only '
  'clutters the forger''s own list, which is why this is the rare table a client may '
  'write to directly.';

-- No index on (friend_id). "Who has me on their list" is a question nobody asks, and
-- an index nothing reads is weight in every write.

-- ---------------------------------------------------------------------------
-- row level security
-- ---------------------------------------------------------------------------

alter table duels enable row level security;
alter table friendships enable row level security;

-- Both ends read their own duels and nothing else. No insert, update or delete
-- policy: every write goes through an Edge Function under the service role, because
-- a client that could write here could forge an accepted duel and mint a match.
--
-- Note what this policy does NOT hand over. It exposes player ids the caller is
-- already in a duel with, and nothing about them - `players` has been owner-only
-- since 20260817000004, so a display name still comes from a function that decides
-- to give it.
create policy duels_read_own on duels
  for select using (auth.uid() = challenger_id or auth.uid() = challenged_id);

-- Client-writable, and the only table in the match area that is. It decides nothing,
-- so the rule that keeps clients out of `ratings` and `match_sides` has nothing to
-- protect here; keeping it read-only would mean an Edge Function whose entire job is
-- to insert a row a player is allowed to insert.
create policy friendships_all_self on friendships
  for all using (auth.uid() = player_id) with check (auth.uid() = player_id);

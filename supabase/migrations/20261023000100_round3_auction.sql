-- Migration 13 — Round 3 "THE KNOWLEDGE AUCTION": auction sets, immutable published versions,
-- six-digit codes, live auctions with open (organiser-recorded) bidding, public budgets and private scores.
--
--   r3_sets / r3_set_topics / r3_set_questions / r3_set_answers   the editable DRAFT (any number of topics and
--        questions; each question is NORMAL or BLIND; answers + explanations in their own table, organizer RPCs only)
--   r3_versions / r3_version_questions / r3_version_answers       IMMUTABLE snapshots taken by Publish (a trigger
--        refuses every UPDATE and DELETE). A set keeps ONE six-digit code; the code opens its latest version.
--   r3_sessions          one live auction (created only by Start Round 3) for one version, one section and exactly
--                        three distinct registered teams. At most one live auction per section.
--   r3_session_teams     per team: BUDGET (public, starts at 100, never below 0) and SCORE (private, starts at 0) —
--                        two separate columns, changed only by r3s_record_outcome.
--   r3_bids              the bids of the open question (status bid / pass / no_bid; multiples of 10, ≥ 10, ≤ budget).
--   r3_events            audit ledger (bids, closes, tie resolutions, reopenings, reveals, outcomes with their
--                        deltas). One outcome per team per question per auction (unique index); request ids make
--                        outcome confirmation idempotent.
--   r3_question_results  one row per completed question per auction ("used").
--
-- Scoring (server-side only, integers): highest bidder correct → score + bid/2; highest bidder wrong → budget − bid/2;
-- lower-ranked bidder correct → score + 10; every other outcome (wrong lower bidder, pass, timeout) → no change.
-- The projector board (r3s_board with p_host = false) never contains scores, the answer before Reveal Answer,
-- the question before Reveal Question, or the topic of a BLIND question before Reveal Topic.
-- Also: _r2s_new_code now also avoids Round 3 codes (so a code never opens two different sets).
-- The function permission set is re-applied in full (as in migration 12) with the r3s_* functions added.
-- Data: no existing table or row is changed. Rollback: drop the r3s_* / _r3_* functions and the r3_* tables.

-- ===========================================================================
-- Tables
-- ===========================================================================
create table if not exists public.r3_sets (
  id               uuid primary key default gen_random_uuid(),
  title            text not null check (char_length(title) between 1 and 80),
  description      text check (description is null or char_length(description) <= 500),
  section          text not null default 'BOTH' check (section in ('UG', 'PG', 'BOTH')),
  bid_seconds      integer not null default 30 check (bid_seconds between 5 and 300),
  answer_seconds   integer not null default 25 check (answer_seconds between 5 and 300),
  join_code        text unique check (join_code ~ '^[0-9]{6}$'),
  published_version integer not null default 0,
  published_at     timestamptz,
  draft_updated_at timestamptz not null default now(),
  archived_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.r3_set_topics (
  id         uuid primary key default gen_random_uuid(),
  set_id     uuid not null references public.r3_sets(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  position   integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists r3_set_topics_name_key on public.r3_set_topics (set_id, lower(name));

create table if not exists public.r3_set_questions (
  id            uuid primary key default gen_random_uuid(),
  set_id        uuid not null references public.r3_sets(id) on delete cascade,
  topic_id      uuid not null references public.r3_set_topics(id) on delete cascade,
  mode          text not null default 'NORMAL' check (mode in ('NORMAL', 'BLIND')),
  position      integer not null default 0,
  question_text text not null check (char_length(question_text) between 1 and 1000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists r3_set_questions_topic_idx on public.r3_set_questions (topic_id);

create table if not exists public.r3_set_answers (
  question_id uuid primary key references public.r3_set_questions(id) on delete cascade,
  answer_text text not null check (char_length(answer_text) between 1 and 500),
  explanation text check (explanation is null or char_length(explanation) <= 1000)
);

create table if not exists public.r3_versions (
  id             uuid primary key default gen_random_uuid(),
  set_id         uuid not null references public.r3_sets(id) on delete restrict,
  version        integer not null,
  title          text not null,
  description    text,
  section        text not null,
  bid_seconds    integer not null,
  answer_seconds integer not null,
  published_at   timestamptz not null default now(),
  published_by   uuid,
  unique (set_id, version)
);

create table if not exists public.r3_version_questions (
  id             uuid primary key default gen_random_uuid(),
  version_id     uuid not null references public.r3_versions(id) on delete restrict,
  seq            integer not null,
  topic_name     text not null,
  topic_position integer not null,
  mode           text not null check (mode in ('NORMAL', 'BLIND')),
  mystery_no     integer,
  question_text  text not null,
  unique (version_id, seq)
);

create table if not exists public.r3_version_answers (
  question_id uuid primary key references public.r3_version_questions(id) on delete restrict,
  answer_text text not null,
  explanation text
);

-- Published snapshots are immutable: no UPDATE, no DELETE (not even by an organizer, a function or a cascade).
create or replace function public._r3_snapshot_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '42501', message = 'R3_SNAPSHOT_IMMUTABLE: A published auction version cannot be changed. Edit the draft and publish a new version.';
end $$;
do $$
declare t text;
begin
  foreach t in array array['r3_versions', 'r3_version_questions', 'r3_version_answers'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_immutable', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public._r3_snapshot_immutable()', t || '_immutable', t);
  end loop;
end $$;

create table if not exists public.r3_sessions (
  id                uuid primary key default gen_random_uuid(),
  request_id        uuid not null unique,
  set_id            uuid not null references public.r3_sets(id) on delete restrict,
  version_id        uuid not null references public.r3_versions(id) on delete restrict,
  section           text not null check (section in ('UG', 'PG')),
  status            text not null default 'live' check (status in ('live', 'ended')),
  results_revealed  boolean not null default false,
  phase             text not null default 'idle' check (phase in ('idle', 'selected', 'bidding', 'tie', 'closed', 'answering', 'between', 'done')),
  question_id       uuid references public.r3_version_questions(id) on delete restrict,
  topic_revealed    boolean not null default false,
  bid_started_at    timestamptz,
  bids_closed_at    timestamptz,
  bid_order         uuid[] not null default '{}',
  order_pos         integer not null default 0,
  current_team_id   uuid,
  question_revealed boolean not null default false,
  answer_started_at timestamptz,
  answer_revealed   boolean not null default false,
  last_event_id     bigint,
  started_at        timestamptz not null default now(),
  started_by        uuid,
  ended_at          timestamptz,
  updated_at        timestamptz not null default now()
);
-- At most one live auction per section.
create unique index if not exists r3_sessions_one_live on public.r3_sessions (section) where status = 'live';

create table if not exists public.r3_session_teams (
  session_id uuid not null references public.r3_sessions(id) on delete cascade,
  team_id    uuid not null references public.teams(id) on delete cascade,
  seat       integer not null check (seat between 1 and 3),
  budget     integer not null default 100 check (budget >= 0),
  score      integer not null default 0 check (score >= 0),
  primary key (session_id, team_id),
  unique (session_id, seat)
);

create table if not exists public.r3_bids (
  session_id  uuid not null references public.r3_sessions(id) on delete cascade,
  question_id uuid not null references public.r3_version_questions(id) on delete restrict,
  team_id     uuid not null references public.teams(id) on delete cascade,
  status      text not null check (status in ('bid', 'pass', 'no_bid')),
  amount      integer check (amount is null or (amount >= 10 and amount % 10 = 0)),
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  primary key (session_id, question_id, team_id),
  check ((status = 'bid') = (amount is not null))
);

create table if not exists public.r3_events (
  id           bigint generated always as identity primary key,
  request_id   uuid unique,
  session_id   uuid not null references public.r3_sessions(id) on delete cascade,
  question_id  uuid references public.r3_version_questions(id) on delete restrict,
  seq          integer,
  team_id      uuid references public.teams(id) on delete set null,
  team_number  integer,
  team_name    text,
  kind         text not null check (kind in ('bid', 'bidding_started', 'bidding_closed', 'tie_resolved', 'bidding_reopened', 'topic_revealed',
                 'question_revealed', 'outcome', 'next_bidder', 'answer_revealed', 'question_completed', 'question_cancelled', 'auction_ended', 'results_revealed')),
  outcome      text check (outcome in ('correct', 'wrong', 'pass', 'timeout')),
  was_top      boolean,
  bid          integer,
  score_delta  integer not null default 0,
  budget_delta integer not null default 0,
  score_after  integer,
  budget_after integer,
  detail       jsonb,
  actor        uuid,
  created_at   timestamptz not null default now()
);
create index if not exists r3_events_session_idx on public.r3_events (session_id, id);
-- A team answers (or passes) a question at most once per auction.
create unique index if not exists r3_events_one_outcome on public.r3_events (session_id, question_id, team_id) where kind = 'outcome';

create table if not exists public.r3_question_results (
  session_id     uuid not null references public.r3_sessions(id) on delete cascade,
  question_id    uuid not null references public.r3_version_questions(id) on delete restrict,
  seq            integer not null,
  topic_name     text not null,
  mode           text not null,
  result         text not null check (result in ('correct', 'no_correct', 'no_bids')),
  winner_team_id uuid references public.teams(id) on delete set null,
  top_team_id    uuid references public.teams(id) on delete set null,
  top_bid        integer,
  bid_order      uuid[] not null default '{}',
  bids           jsonb not null default '[]'::jsonb,
  completed_at   timestamptz not null default now(),
  primary key (session_id, question_id)
);

-- ===========================================================================
-- Helpers
-- ===========================================================================
create or replace function public._r3_touch(p_set uuid) returns void
language sql security definer set search_path = '' as $$
  update public.r3_sets set draft_updated_at = now(), updated_at = now() where id = p_set;
$$;

create or replace function public._r3_lock_set(p_set uuid) returns public.r3_sets
language plpgsql security definer set search_path = '' as $$
declare s public.r3_sets;
begin
  select * into s from public.r3_sets where id = p_set for update;
  if not found then perform public._err('R3_NOT_FOUND', 'Auction set not found.'); end if;
  if s.archived_at is not null then perform public._err('R3_SET_ARCHIVED', 'This auction set is archived.'); end if;
  return s;
end $$;

create or replace function public._r3_lock_session(p_session uuid) returns public.r3_sessions
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions;
begin
  select * into g from public.r3_sessions where id = p_session for update;
  if not found then perform public._err('R3_SESSION_NOT_FOUND', 'Round 3 auction not found.'); end if;
  if g.status <> 'live' then perform public._err('R3_SESSION_ENDED', 'This auction has ended.'); end if;
  return g;
end $$;

-- The session's open question must be p_question (and, if given, in one of the phases).
create or replace function public._r3_require(g public.r3_sessions, p_question uuid, p_phases text[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if g.question_id is null or g.question_id is distinct from p_question then
    perform public._err('R3_NOT_SELECTED', 'That question is not the one open in this auction.');
  end if;
  if p_phases is not null and not (g.phase = any (p_phases)) then
    perform public._err('R3_WRONG_PHASE', 'That action is not possible in the current auction phase (' || g.phase || ').');
  end if;
end $$;

create or replace function public._r3_by_code(p_code text) returns public.r3_sets
language plpgsql stable security definer set search_path = '' as $$
declare s public.r3_sets; c text := regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g');
begin
  if c !~ '^[0-9]{6}$' then return null; end if;
  select * into s from public.r3_sets where join_code = c and archived_at is null and published_version > 0;
  return s;
end $$;

-- Unique six-digit code: never used by another auction set, a trivia set or a Round 1 quiz set (current or retired).
create or replace function public._r3_new_code() returns text
language plpgsql security definer set search_path = '' as $$
declare c text; tries integer := 0;
begin
  loop
    tries := tries + 1;
    if tries > 60 then perform public._err('CODE_GENERATION_FAILED', 'Could not generate a unique code. Try again.'); end if;
    c := lpad((('x' || public._random_bytes_hex(4))::bit(32)::bigint % 1000000)::text, 6, '0');
    exit when not exists (select 1 from public.r3_sets where join_code = c)
          and not exists (select 1 from public.r2_sets where join_code = c)
          and not exists (select 1 from public.quiz_sessions where join_code = c)
          and not exists (select 1 from public.retired_join_codes where code = c);
  end loop;
  return c;
end $$;

-- Round 2 codes now also avoid Round 3 codes (body otherwise unchanged from migration 10).
create or replace function public._r2s_new_code() returns text
language plpgsql security definer set search_path = '' as $$
declare c text; tries integer := 0;
begin
  loop
    tries := tries + 1;
    if tries > 60 then perform public._err('CODE_GENERATION_FAILED', 'Could not generate a unique code. Try again.'); end if;
    c := lpad((('x' || public._random_bytes_hex(4))::bit(32)::bigint % 1000000)::text, 6, '0');
    exit when not exists (select 1 from public.r2_sets where join_code = c)
          and not exists (select 1 from public.r3_sets where join_code = c)
          and not exists (select 1 from public.quiz_sessions where join_code = c)
          and not exists (select 1 from public.retired_join_codes where code = c);
  end loop;
  return c;
end $$;

create or replace function public._r3_publish_issues(p_set uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select array_remove(array[
    case when not exists (select 1 from public.r3_set_topics where set_id = p_set) then 'Add at least one topic.' end,
    case when not exists (select 1 from public.r3_set_questions where set_id = p_set) then 'Add at least one question.' end,
    (select 'Topic "' || t.name || '" has no questions — add one or delete the topic.' from public.r3_set_topics t
      where t.set_id = p_set and not exists (select 1 from public.r3_set_questions q where q.topic_id = t.id)
      order by t.position limit 1),
    case when exists (select 1 from public.r3_set_questions q where q.set_id = p_set
                      and not exists (select 1 from public.r3_set_answers a where a.question_id = q.id)) then 'Every question needs a correct answer.' end
  ], null);
$$;

-- Score / budget change of an outcome (the only scoring rule; integers, bids are multiples of 10).
create or replace function public._r3_deltas(p_was_top boolean, p_outcome text, p_bid integer, out score_delta integer, out budget_delta integer)
language sql immutable set search_path = '' as $$
  select case when p_outcome = 'correct' then (case when p_was_top then p_bid / 2 else 10 end) else 0 end,
         case when p_outcome = 'wrong' and p_was_top then -(p_bid / 2) else 0 end;
$$;

create or replace function public._r3_event(g public.r3_sessions, p_kind text, p_team uuid default null, p_detail jsonb default null) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint; t public.teams; q public.r3_version_questions;
begin
  if p_team is not null then select * into t from public.teams where id = p_team; end if;
  if g.question_id is not null then select * into q from public.r3_version_questions where id = g.question_id; end if;
  insert into public.r3_events (session_id, question_id, seq, team_id, team_number, team_name, kind, detail, actor)
  values (g.id, g.question_id, q.seq, p_team, t.team_number, t.team_name, p_kind, p_detail, auth.uid()) returning id into v_id;
  update public.r3_sessions set updated_at = now() where id = g.id;
  return v_id;
end $$;

-- Mark the open question completed (used) and move to the "done" phase.
create or replace function public._r3_complete(g public.r3_sessions, p_result text, p_winner uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.r3_version_questions; v_top uuid := g.bid_order[1]; v_top_bid integer;
begin
  select * into q from public.r3_version_questions where id = g.question_id;
  if v_top is not null then select amount into v_top_bid from public.r3_bids where session_id = g.id and question_id = q.id and team_id = v_top; end if;
  insert into public.r3_question_results (session_id, question_id, seq, topic_name, mode, result, winner_team_id, top_team_id, top_bid, bid_order, bids)
  values (g.id, q.id, q.seq, q.topic_name, q.mode, p_result, p_winner, v_top, v_top_bid, g.bid_order,
    coalesce((select jsonb_agg(jsonb_build_object('team_id', b.team_id, 'status', b.status, 'amount', b.amount) order by b.amount desc nulls last)
      from public.r3_bids b where b.session_id = g.id and b.question_id = q.id), '[]'::jsonb));
  update public.r3_sessions set phase = 'done', current_team_id = null, updated_at = now() where id = g.id;
  perform public._r3_event(g, 'question_completed', p_winner, jsonb_build_object('result', p_result));
end $$;

-- Teams of an auction: public fields (+ the private score for the host), with the open question's bid.
create or replace function public._r3_teams(p_session uuid, p_host boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('team_id', t.id, 'team_number', t.team_number, 'team_name', t.team_name, 'section', t.section,
      'seat', st.seat, 'budget', st.budget,
      'bid_status', coalesce(b.status, 'none'), 'bid', b.amount)
      || case when p_host then jsonb_build_object('score', st.score) else '{}'::jsonb end
    order by st.seat), '[]'::jsonb)
  from public.r3_session_teams st join public.teams t on t.id = st.team_id
  join public.r3_sessions g on g.id = st.session_id
  left join public.r3_bids b on b.session_id = g.id and b.question_id = g.question_id and b.team_id = st.team_id
  where st.session_id = p_session;
$$;

-- ===========================================================================
-- Organizer: auction sets (draft editing)
-- ===========================================================================
create or replace function public.r3s_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_organizer();
  return jsonb_build_object(
    'server_now', now(),
    'sets', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'title', s.title, 'description', s.description, 'section', s.section, 'bid_seconds', s.bid_seconds, 'answer_seconds', s.answer_seconds,
        'join_code', s.join_code, 'published_version', s.published_version, 'published_at', s.published_at, 'archived_at', s.archived_at,
        'draft_updated_at', s.draft_updated_at, 'created_at', s.created_at,
        'unpublished_changes', s.published_version > 0 and s.draft_updated_at > s.published_at,
        'topic_count', (select count(*) from public.r3_set_topics t where t.set_id = s.id),
        'question_count', (select count(*) from public.r3_set_questions q where q.set_id = s.id),
        'live_sessions', (select count(*) from public.r3_sessions g where g.set_id = s.id and g.status = 'live'))
      order by s.archived_at nulls first, s.created_at desc) from public.r3_sets s), '[]'::jsonb),
    'sessions', coalesce((select jsonb_agg(jsonb_build_object(
        'id', g.id, 'set_id', g.set_id, 'title', v.title, 'version', v.version, 'section', g.section, 'status', g.status, 'phase', g.phase,
        'results_revealed', g.results_revealed, 'started_at', g.started_at, 'ended_at', g.ended_at, 'join_code', s.join_code,
        'teams', (select jsonb_agg(jsonb_build_object('team_number', t.team_number, 'team_name', t.team_name) order by st.seat)
                  from public.r3_session_teams st join public.teams t on t.id = st.team_id where st.session_id = g.id),
        'played', (select count(*) from public.r3_question_results r where r.session_id = g.id),
        'question_count', (select count(*) from public.r3_version_questions q where q.version_id = g.version_id))
      order by g.status = 'live' desc, g.started_at desc)
      from public.r3_sessions g join public.r3_versions v on v.id = g.version_id join public.r3_sets s on s.id = g.set_id), '[]'::jsonb));
end $$;

create or replace function public.r3s_set_detail(p_set_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.r3_sets;
begin
  perform public._require_organizer();
  select * into s from public.r3_sets where id = p_set_id;
  if not found then perform public._err('R3_NOT_FOUND', 'Auction set not found.'); end if;
  return jsonb_build_object(
    'set', to_jsonb(s) || jsonb_build_object('unpublished_changes', s.published_version > 0 and s.draft_updated_at > s.published_at),
    'topics', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'position', t.position, 'created_at', t.created_at)
      order by t.position, t.created_at) from public.r3_set_topics t where t.set_id = s.id), '[]'::jsonb),
    'questions', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'topic_id', q.topic_id, 'mode', q.mode, 'position', q.position,
      'question_text', q.question_text, 'answer_text', a.answer_text, 'explanation', a.explanation, 'created_at', q.created_at) order by q.position, q.created_at)
      from public.r3_set_questions q left join public.r3_set_answers a on a.question_id = q.id where q.set_id = s.id), '[]'::jsonb),
    'issues', to_jsonb(public._r3_publish_issues(s.id)),
    'live_sessions', (select count(*) from public.r3_sessions g where g.set_id = s.id and g.status = 'live'));
end $$;

create or replace function public.r3s_save_set(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid; v_title text := public._clean(p->>'title'); v_desc text := public._clean(p->>'description');
  v_section text := upper(coalesce(nullif(btrim(p->>'section'), ''), 'BOTH'));
  v_bid text := btrim(coalesce(p->>'bid_seconds', '')); v_ans text := btrim(coalesce(p->>'answer_seconds', ''));
  s public.r3_sets;
begin
  perform public._require_organizer();
  if v_title is null or char_length(v_title) > 80 then perform public._err('VALIDATION', 'The auction set title is required (max 80 characters).'); end if;
  if v_desc is not null and char_length(v_desc) > 500 then perform public._err('VALIDATION', 'The description can be at most 500 characters.'); end if;
  if v_section not in ('UG', 'PG', 'BOTH') then perform public._err('VALIDATION', 'Section must be UG, PG or both.'); end if;
  if v_bid <> '' and (v_bid !~ '^[0-9]+$' or v_bid::int not between 5 and 300) then perform public._err('VALIDATION', 'The bidding timer must be 5–300 whole seconds.'); end if;
  if v_ans <> '' and (v_ans !~ '^[0-9]+$' or v_ans::int not between 5 and 300) then perform public._err('VALIDATION', 'The answer timer must be 5–300 whole seconds.'); end if;
  if v_id is null then
    insert into public.r3_sets (title, description, section, bid_seconds, answer_seconds)
    values (v_title, v_desc, v_section, coalesce(nullif(v_bid, '')::int, 30), coalesce(nullif(v_ans, '')::int, 25)) returning id into v_id;
  else
    s := public._r3_lock_set(v_id);
    update public.r3_sets set title = v_title, description = v_desc, section = v_section,
      bid_seconds = coalesce(nullif(v_bid, '')::int, bid_seconds), answer_seconds = coalesce(nullif(v_ans, '')::int, answer_seconds)
    where id = v_id;
    perform public._r3_touch(v_id);
  end if;
  return v_id;
end $$;

create or replace function public.r3s_delete_set(p_set_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.r3_sets;
begin
  perform public._require_organizer();
  select * into s from public.r3_sets where id = p_set_id for update;
  if not found then perform public._err('R3_NOT_FOUND', 'Auction set not found.'); end if;
  if s.published_version > 0 then perform public._err('R3_SET_PUBLISHED', 'A published auction set cannot be deleted. Archive it instead.'); end if;
  delete from public.r3_sets where id = s.id;
  return jsonb_build_object('deleted', true);
end $$;

create or replace function public.r3s_archive_set(p_set_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.r3_sets;
begin
  perform public._require_organizer();
  s := public._r3_lock_set(p_set_id);
  if exists (select 1 from public.r3_sessions where set_id = s.id and status = 'live') then
    perform public._err('R3_SESSION_LIVE', 'End the live auction of this set first.');
  end if;
  update public.r3_sets set archived_at = now(), updated_at = now() where id = s.id;
  return jsonb_build_object('archived', true);
end $$;

create or replace function public.r3s_save_topic(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p->>'id', '')::uuid; v_set uuid := nullif(p->>'set_id', '')::uuid; v_name text := public._clean(p->>'name'); v_pos integer;
begin
  perform public._require_organizer();
  if v_id is not null then select set_id into v_set from public.r3_set_topics where id = v_id; end if;
  if v_set is null then perform public._err('R3_NOT_FOUND', 'Topic not found.'); end if;
  perform public._r3_lock_set(v_set);
  if v_name is null or char_length(v_name) > 60 then perform public._err('VALIDATION', 'Topic name is required (max 60 characters).'); end if;
  if exists (select 1 from public.r3_set_topics where set_id = v_set and lower(name) = lower(v_name) and id is distinct from v_id) then
    perform public._err('VALIDATION', 'A topic with that name already exists in this set.');
  end if;
  if v_id is null then
    select coalesce(max(position), 0) + 1 into v_pos from public.r3_set_topics where set_id = v_set;
    insert into public.r3_set_topics (set_id, name, position) values (v_set, v_name, v_pos) returning id into v_id;
  else
    update public.r3_set_topics set name = v_name where id = v_id;
  end if;
  perform public._r3_touch(v_set);
  return v_id;
end $$;

create or replace function public.r3s_delete_topic(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_set uuid;
begin
  perform public._require_organizer();
  select set_id into v_set from public.r3_set_topics where id = p_id;
  if v_set is null then perform public._err('R3_NOT_FOUND', 'Topic not found.'); end if;
  perform public._r3_lock_set(v_set);
  delete from public.r3_set_topics where id = p_id;
  perform public._r3_touch(v_set);
  return jsonb_build_object('deleted', true);
end $$;

create or replace function public.r3s_save_question(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_topic uuid := nullif(p->>'topic_id', '')::uuid;
  v_mode text := upper(coalesce(nullif(btrim(p->>'mode'), ''), 'NORMAL'));
  v_text text := public._clean(p->>'question_text');
  v_answer text := public._clean(p->>'answer_text');
  v_expl text := nullif(btrim(coalesce(p->>'explanation', '')), '');
  v_set uuid; v_pos integer; v_old_topic uuid;
begin
  perform public._require_organizer();
  select set_id into v_set from public.r3_set_topics where id = v_topic;
  if v_set is null then perform public._err('VALIDATION', 'Choose a topic.'); end if;
  perform public._r3_lock_set(v_set);
  if v_mode not in ('NORMAL', 'BLIND') then perform public._err('VALIDATION', 'The topic mode must be NORMAL or BLIND.'); end if;
  if v_text is null or char_length(v_text) > 1000 then perform public._err('VALIDATION', 'Question text is required (max 1000 characters).'); end if;
  if v_answer is null or char_length(v_answer) > 500 then perform public._err('VALIDATION', 'The correct answer is required (max 500 characters).'); end if;
  if v_expl is not null and char_length(v_expl) > 1000 then perform public._err('VALIDATION', 'The explanation can be at most 1000 characters.'); end if;
  if v_id is null then
    select coalesce(max(position), 0) + 1 into v_pos from public.r3_set_questions where topic_id = v_topic;
    insert into public.r3_set_questions (set_id, topic_id, mode, position, question_text) values (v_set, v_topic, v_mode, v_pos, v_text) returning id into v_id;
    insert into public.r3_set_answers (question_id, answer_text, explanation) values (v_id, v_answer, v_expl);
  else
    select topic_id into v_old_topic from public.r3_set_questions where id = v_id and set_id = v_set;
    if not found then perform public._err('R3_NOT_FOUND', 'Question not found.'); end if;
    if v_old_topic <> v_topic then
      select coalesce(max(position), 0) + 1 into v_pos from public.r3_set_questions where topic_id = v_topic;
      update public.r3_set_questions set position = v_pos where id = v_id;
    end if;
    update public.r3_set_questions set topic_id = v_topic, mode = v_mode, question_text = v_text, updated_at = now() where id = v_id;
    insert into public.r3_set_answers (question_id, answer_text, explanation) values (v_id, v_answer, v_expl)
    on conflict (question_id) do update set answer_text = excluded.answer_text, explanation = excluded.explanation;
  end if;
  perform public._r3_touch(v_set);
  return v_id;
end $$;

create or replace function public.r3s_delete_question(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_set uuid;
begin
  perform public._require_organizer();
  select set_id into v_set from public.r3_set_questions where id = p_id;
  if v_set is null then perform public._err('R3_NOT_FOUND', 'Question not found.'); end if;
  perform public._r3_lock_set(v_set);
  delete from public.r3_set_questions where id = p_id;
  perform public._r3_touch(v_set);
  return jsonb_build_object('deleted', true);
end $$;

-- Move a topic or a question one place up (-1) or down (+1) within its list.
create or replace function public.r3s_move(p_kind text, p_id uuid, p_dir integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_set uuid; v_scope uuid; v_ids uuid[]; i integer; j integer;
begin
  perform public._require_organizer();
  if p_dir not in (-1, 1) then perform public._err('VALIDATION', 'Move up (-1) or down (1).'); end if;
  if p_kind = 'topic' then
    select set_id into v_set from public.r3_set_topics where id = p_id;
    if v_set is null then perform public._err('R3_NOT_FOUND', 'Topic not found.'); end if;
    perform public._r3_lock_set(v_set);
    select array_agg(id order by position, created_at, id) into v_ids from public.r3_set_topics where set_id = v_set;
  elsif p_kind = 'question' then
    select set_id, topic_id into v_set, v_scope from public.r3_set_questions where id = p_id;
    if v_set is null then perform public._err('R3_NOT_FOUND', 'Question not found.'); end if;
    perform public._r3_lock_set(v_set);
    select array_agg(id order by position, created_at, id) into v_ids from public.r3_set_questions where topic_id = v_scope;
  else
    perform public._err('VALIDATION', 'Unknown item.');
  end if;
  i := array_position(v_ids, p_id); j := i + p_dir;
  if j >= 1 and j <= cardinality(v_ids) then
    v_ids[i] := v_ids[j]; v_ids[j] := p_id;
  end if;
  if p_kind = 'topic' then
    update public.r3_set_topics t set position = x.n from unnest(v_ids) with ordinality x(id, n) where t.id = x.id;
  else
    update public.r3_set_questions q set position = x.n from unnest(v_ids) with ordinality x(id, n) where q.id = x.id;
  end if;
  perform public._r3_touch(v_set);
  return jsonb_build_object('ok', true);
end $$;

-- Validate and freeze the draft as a new, immutable version. The set keeps its code.
create or replace function public.r3s_publish_set(p_set_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.r3_sets; v_issues text[]; v_ver public.r3_versions; v_code text; q record; v_qid uuid;
begin
  perform public._require_organizer();
  s := public._r3_lock_set(p_set_id);
  v_issues := public._r3_publish_issues(s.id);
  if cardinality(v_issues) > 0 then perform public._err('VALIDATION', array_to_string(v_issues, ' ')); end if;
  v_code := coalesce(s.join_code, public._r3_new_code());
  insert into public.r3_versions (set_id, version, title, description, section, bid_seconds, answer_seconds, published_by)
  values (s.id, s.published_version + 1, s.title, s.description, s.section, s.bid_seconds, s.answer_seconds, auth.uid())
  returning * into v_ver;
  for q in
    select x.id, x.mode, x.question_text, t.name as topic_name, a.answer_text, a.explanation,
           dense_rank() over (order by t.position, t.created_at, t.id)::int as topic_position,
           (row_number() over (order by t.position, t.created_at, t.id, x.position, x.created_at, x.id))::int as seq
    from public.r3_set_questions x join public.r3_set_topics t on t.id = x.topic_id join public.r3_set_answers a on a.question_id = x.id
    where x.set_id = s.id order by seq
  loop
    insert into public.r3_version_questions (version_id, seq, topic_name, topic_position, mode, mystery_no, question_text)
    values (v_ver.id, q.seq, q.topic_name, q.topic_position, q.mode,
      case when q.mode = 'BLIND' then (select count(*) + 1 from public.r3_version_questions w where w.version_id = v_ver.id and w.mode = 'BLIND') end,
      q.question_text) returning id into v_qid;
    insert into public.r3_version_answers (question_id, answer_text, explanation) values (v_qid, q.answer_text, q.explanation);
  end loop;
  update public.r3_sets set join_code = v_code, published_version = v_ver.version, published_at = v_ver.published_at,
    draft_updated_at = least(draft_updated_at, v_ver.published_at), updated_at = now()
  where id = s.id;
  return jsonb_build_object('ok', true, 'join_code', v_code, 'version', v_ver.version, 'version_id', v_ver.id);
end $$;

-- ===========================================================================
-- Organizer: Join Round 3 (code → set → section → three teams → Start)
-- ===========================================================================
create or replace function public.r3s_lookup(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.r3_sets; v public.r3_versions;
begin
  perform public._require_organizer();
  s := public._r3_by_code(p_code);
  if s.id is null then perform public._err('R3_CODE_INVALID', 'No published auction set has that code.'); end if;
  select * into v from public.r3_versions where set_id = s.id and version = s.published_version;
  return jsonb_build_object('set_id', s.id, 'join_code', s.join_code, 'version_id', v.id, 'version', v.version, 'title', v.title,
    'description', v.description, 'section', v.section, 'bid_seconds', v.bid_seconds, 'answer_seconds', v.answer_seconds, 'published_at', v.published_at,
    'questions', coalesce((select jsonb_agg(jsonb_build_object('seq', q.seq, 'mode', q.mode, 'topic_name', q.topic_name, 'mystery_no', q.mystery_no) order by q.seq)
      from public.r3_version_questions q where q.version_id = v.id), '[]'::jsonb),
    'live_session_id', (select g.id from public.r3_sessions g where g.status = 'live' and g.set_id = s.id limit 1));
end $$;

-- Registered teams of a section; Round 1 qualifiers and the latest Round 2 score are shown to help choose the top 3.
create or replace function public.r3s_eligible_teams(p_code text, p_section text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.r3_sets; v_section text := upper(btrim(coalesce(p_section, '')));
begin
  perform public._require_organizer();
  s := public._r3_by_code(p_code);
  if s.id is null then perform public._err('R3_CODE_INVALID', 'No published auction set has that code.'); end if;
  if v_section not in ('UG', 'PG') then perform public._err('VALIDATION', 'Choose UG or PG.'); end if;
  if (select section from public.r3_versions where set_id = s.id and version = s.published_version) not in ('BOTH', v_section) then
    perform public._err('R3_SECTION_MISMATCH', 'This auction set is not for the ' || v_section || ' section.');
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'team_number', t.team_number, 'team_name', t.team_name,
      'participant_1', t.participant_1, 'participant_2', t.participant_2,
      'r1_qualified', exists (select 1 from public.quiz_sessions q where q.is_current and q.section = t.section and t.id = any (q.qualifiers)),
      'round2', (select jsonb_build_object('title', v2.title, 'score', coalesce((select sum(r.points) from public.r2_session_results r where r.session_id = g2.id and r.team_id = t.id), 0))
                 from public.r2_session_teams st2 join public.r2_sessions g2 on g2.id = st2.session_id join public.r2_versions v2 on v2.id = g2.version_id
                 where st2.team_id = t.id order by g2.started_at desc limit 1),
      'in_live_auction', exists (select 1 from public.r3_session_teams x join public.r3_sessions g on g.id = x.session_id where x.team_id = t.id and g.status = 'live'))
      order by t.team_number)
    from public.teams t where t.section = v_section), '[]'::jsonb);
end $$;

-- Start a live auction: exactly three distinct registered teams of the section, budget 100, score 0.
create or replace function public.r3s_start_session(p_request_id uuid, p_code text, p_section text, p_team_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.r3_sets; v public.r3_versions; g public.r3_sessions; v_section text := upper(btrim(coalesce(p_section, ''))); v_ids uuid[] := coalesce(p_team_ids, '{}');
begin
  perform public._require_organizer();
  if p_request_id is null then perform public._err('VALIDATION', 'A request id is required.'); end if;
  select * into g from public.r3_sessions where request_id = p_request_id;
  if found then return jsonb_build_object('session_id', g.id, 'duplicate_request', true); end if;
  s := public._r3_by_code(p_code);
  if s.id is null then perform public._err('R3_CODE_INVALID', 'No published auction set has that code.'); end if;
  perform 1 from public.r3_sets where id = s.id for update;
  select * into v from public.r3_versions where set_id = s.id and version = s.published_version;
  if v_section not in ('UG', 'PG') then perform public._err('VALIDATION', 'Choose UG or PG.'); end if;
  if v.section not in ('BOTH', v_section) then perform public._err('R3_SECTION_MISMATCH', 'This auction set is not for the ' || v_section || ' section.'); end if;
  if cardinality(v_ids) <> 3 then perform public._err('R3_TEAM_COUNT', 'Select exactly three teams.'); end if;
  if (select count(distinct x) from unnest(v_ids) x) <> 3 then perform public._err('R3_TEAM_COUNT', 'The three teams must be different.'); end if;
  if exists (select 1 from unnest(v_ids) x where not exists (select 1 from public.teams t where t.id = x and t.section = v_section)) then
    perform public._err('R3_TEAM_NOT_ELIGIBLE', 'Every selected team must be a registered ' || v_section || ' team.');
  end if;
  if exists (select 1 from public.r3_sessions where status = 'live' and section = v_section) then
    perform public._err('R3_SESSION_LIVE', 'A ' || v_section || ' auction is already live. End it before starting another.');
  end if;
  insert into public.r3_sessions (request_id, set_id, version_id, section, started_by)
  values (p_request_id, s.id, v.id, v_section, auth.uid()) returning * into g;
  insert into public.r3_session_teams (session_id, team_id, seat, budget, score)
  select g.id, x.id, x.n, 100, 0 from unnest(v_ids) with ordinality x(id, n);
  return jsonb_build_object('session_id', g.id, 'duplicate_request', false, 'version', v.version);
end $$;

-- ===========================================================================
-- Organizer: live auction (per session; every write locks the session row)
-- ===========================================================================
create or replace function public.r3s_select_question(p_session_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions; q public.r3_version_questions;
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  if g.phase <> 'idle' then
    if g.phase = 'selected' and g.question_id = p_question_id then return jsonb_build_object('ok', true, 'phase', g.phase); end if;
    perform public._err('R3_QUESTION_ACTIVE', 'Another question is open. Finish or cancel it first.');
  end if;
  select * into q from public.r3_version_questions where id = p_question_id and version_id = g.version_id;
  if not found then perform public._err('R3_NOT_FOUND', 'That question is not in this auction.'); end if;
  if exists (select 1 from public.r3_question_results where session_id = g.id and question_id = q.id) then
    perform public._err('R3_QUESTION_USED', 'This question has already been played.');
  end if;
  update public.r3_sessions set phase = 'selected', question_id = q.id, topic_revealed = (q.mode = 'NORMAL'), bid_started_at = null, bids_closed_at = null,
    bid_order = '{}', order_pos = 0, current_team_id = null, question_revealed = false, answer_started_at = null, answer_revealed = false,
    last_event_id = null, updated_at = now()
  where id = g.id returning * into g;
  return jsonb_build_object('ok', true, 'phase', 'selected');
end $$;

-- Before the question is revealed, an open question can be put back unused (its bids are discarded).
create or replace function public.r3s_cancel_question(p_session_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions;
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  perform public._r3_require(g, p_question_id, array['selected', 'bidding', 'tie', 'closed']);
  if g.question_revealed then perform public._err('R3_QUESTION_LIVE', 'The question is already revealed. Record the outcomes instead.'); end if;
  delete from public.r3_bids where session_id = g.id and question_id = g.question_id;
  perform public._r3_event(g, 'question_cancelled');
  update public.r3_sessions set phase = 'idle', question_id = null, topic_revealed = false, bid_started_at = null, bids_closed_at = null,
    bid_order = '{}', order_pos = 0, current_team_id = null, updated_at = now() where id = g.id;
  return jsonb_build_object('ok', true);
end $$;

-- Opens bidding (or restarts the bidding timer while bidding is open). The deadline is server time.
create or replace function public.r3s_start_bidding(p_session_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions; v_restart boolean;
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  perform public._r3_require(g, p_question_id, array['selected', 'bidding']);
  v_restart := g.phase = 'bidding';
  update public.r3_sessions set phase = 'bidding', bid_started_at = now(), updated_at = now() where id = g.id returning * into g;
  perform public._r3_event(g, 'bidding_started', null, jsonb_build_object('restart', v_restart));
  return jsonb_build_object('ok', true, 'bid_started_at', g.bid_started_at);
end $$;

-- Record (or correct) a team's verbal bid while bidding is open. p_pass = true records a pass;
-- p_amount null with p_pass false clears the team's bid.
create or replace function public.r3s_record_bid(p_session_id uuid, p_question_id uuid, p_team_id uuid, p_amount integer, p_pass boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions; st public.r3_session_teams; v public.r3_versions;
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  perform public._r3_require(g, p_question_id, array['bidding']);
  select * into v from public.r3_versions where id = g.version_id;
  if now() > g.bid_started_at + make_interval(secs => v.bid_seconds + 2) then
    perform public._err('R3_BIDDING_TIME_UP', 'The bidding time is over. Close bidding, or restart the bidding timer to take more bids.');
  end if;
  select * into st from public.r3_session_teams where session_id = g.id and team_id = p_team_id;
  if not found then perform public._err('R3_TEAM_NOT_IN_AUCTION', 'That team is not in this auction.'); end if;
  if coalesce(p_pass, false) then
    insert into public.r3_bids (session_id, question_id, team_id, status, amount, updated_by) values (g.id, g.question_id, st.team_id, 'pass', null, auth.uid())
    on conflict (session_id, question_id, team_id) do update set status = 'pass', amount = null, updated_at = now(), updated_by = auth.uid();
  elsif p_amount is null then
    delete from public.r3_bids where session_id = g.id and question_id = g.question_id and team_id = st.team_id;
  else
    if st.budget < 10 then perform public._err('R3_CANNOT_BID', 'This team has less than 10 left and must pass.'); end if;
    if p_amount < 10 then perform public._err('R3_BID_TOO_LOW', 'The minimum bid is 10.'); end if;
    if p_amount % 10 <> 0 then perform public._err('R3_BID_STEP', 'Bids go up in steps of 10.'); end if;
    if p_amount > st.budget then perform public._err('R3_BID_OVER_BUDGET', 'The bid is more than the team''s budget (' || st.budget || ').'); end if;
    insert into public.r3_bids (session_id, question_id, team_id, status, amount, updated_by) values (g.id, g.question_id, st.team_id, 'bid', p_amount, auth.uid())
    on conflict (session_id, question_id, team_id) do update set status = 'bid', amount = excluded.amount, updated_at = now(), updated_by = auth.uid();
  end if;
  perform public._r3_event(g, 'bid', st.team_id, jsonb_build_object('amount', case when coalesce(p_pass, false) then null else p_amount end, 'pass', coalesce(p_pass, false)));
  return jsonb_build_object('ok', true);
end $$;

-- Lock the bids and build the order (highest first). Equal bids need the organizer's tie resolution.
create or replace function public.r3s_close_bidding(p_session_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions; v_order uuid[]; v_tie boolean;
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  perform public._r3_require(g, p_question_id, array['bidding']);
  insert into public.r3_bids (session_id, question_id, team_id, status, amount, updated_by)
  select g.id, g.question_id, st.team_id, 'no_bid', null, auth.uid() from public.r3_session_teams st where st.session_id = g.id
  on conflict (session_id, question_id, team_id) do nothing;
  select coalesce(array_agg(b.team_id order by b.amount desc, st.seat), '{}') into v_order
  from public.r3_bids b join public.r3_session_teams st on st.session_id = b.session_id and st.team_id = b.team_id
  where b.session_id = g.id and b.question_id = g.question_id and b.status = 'bid';
  select exists (select 1 from public.r3_bids where session_id = g.id and question_id = g.question_id and status = 'bid'
                 group by amount having count(*) > 1) into v_tie;
  update public.r3_sessions set bids_closed_at = now(), bid_order = v_order,
    phase = case when cardinality(v_order) = 0 then phase when v_tie then 'tie' else 'closed' end,
    order_pos = case when cardinality(v_order) > 0 and not v_tie then 1 else 0 end,
    current_team_id = case when cardinality(v_order) > 0 and not v_tie then v_order[1] end,
    updated_at = now()
  where id = g.id returning * into g;
  perform public._r3_event(g, 'bidding_closed', null, jsonb_build_object('order', to_jsonb(v_order), 'tie', v_tie));
  if cardinality(v_order) = 0 then
    perform public._r3_complete(g, 'no_bids', null);
    return jsonb_build_object('ok', true, 'phase', 'done', 'result', 'no_bids');
  end if;
  return jsonb_build_object('ok', true, 'phase', g.phase, 'order', to_jsonb(v_order), 'tie', v_tie);
end $$;

-- Tie resolution: the organizer gives the full order of the bidding teams (only equal bids may be reordered) and a reason.
create or replace function public.r3s_resolve_tie(p_session_id uuid, p_question_id uuid, p_order uuid[], p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions; v_reason text := public._clean(p_reason); v_amounts integer[];
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  perform public._r3_require(g, p_question_id, array['tie']);
  if v_reason is null or char_length(v_reason) > 200 then perform public._err('VALIDATION', 'Say how the tie was resolved (max 200 characters).'); end if;
  if p_order is null or cardinality(p_order) <> cardinality(g.bid_order)
     or exists (select 1 from unnest(g.bid_order) x where not (x = any (p_order)))
     or (select count(distinct x) from unnest(p_order) x) <> cardinality(p_order) then
    perform public._err('R3_TIE_ORDER', 'The order must list each bidding team exactly once.');
  end if;
  select array_agg(b.amount order by x.n) into v_amounts from unnest(p_order) with ordinality x(id, n)
  join public.r3_bids b on b.session_id = g.id and b.question_id = g.question_id and b.team_id = x.id;
  if exists (select 1 from generate_series(1, cardinality(v_amounts) - 1) i where v_amounts[i] < v_amounts[i + 1]) then
    perform public._err('R3_TIE_ORDER', 'Higher bids must stay ahead of lower bids; only equal bids can be reordered.');
  end if;
  update public.r3_sessions set bid_order = p_order, phase = 'closed', order_pos = 1, current_team_id = p_order[1], updated_at = now()
  where id = g.id returning * into g;
  perform public._r3_event(g, 'tie_resolved', p_order[1], jsonb_build_object('order', to_jsonb(p_order), 'reason', v_reason));
  return jsonb_build_object('ok', true, 'order', to_jsonb(p_order));
end $$;

-- Authorized correction before the question is revealed: reopen bidding (bids stay editable; timer restarts). Audited.
create or replace function public.r3s_reopen_bidding(p_session_id uuid, p_question_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions; v_reason text := public._clean(p_reason);
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  perform public._r3_require(g, p_question_id, array['tie', 'closed']);
  if g.question_revealed then perform public._err('R3_QUESTION_LIVE', 'The question is already revealed; bids are final.'); end if;
  if v_reason is null or char_length(v_reason) > 200 then perform public._err('VALIDATION', 'Give a reason for reopening bidding (max 200 characters).'); end if;
  delete from public.r3_bids where session_id = g.id and question_id = g.question_id and status = 'no_bid';
  update public.r3_sessions set phase = 'bidding', bid_started_at = now(), bids_closed_at = null, bid_order = '{}', order_pos = 0,
    current_team_id = null, updated_at = now() where id = g.id returning * into g;
  perform public._r3_event(g, 'bidding_reopened', null, jsonb_build_object('reason', v_reason));
  return jsonb_build_object('ok', true);
end $$;

-- BLIND questions: the topic is shown only when the organizer asks, and only after bidding has closed.
create or replace function public.r3s_reveal_topic(p_session_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions;
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  perform public._r3_require(g, p_question_id, null);
  if g.topic_revealed then return jsonb_build_object('ok', true); end if;
  if g.bids_closed_at is null or g.phase in ('selected', 'bidding') then
    perform public._err('R3_BIDDING_OPEN', 'Close bidding before revealing the topic of a blind question.');
  end if;
  update public.r3_sessions set topic_revealed = true, updated_at = now() where id = g.id returning * into g;
  perform public._r3_event(g, 'topic_revealed');
  return jsonb_build_object('ok', true);
end $$;

-- Shows the question to the highest bidder and starts the answer timer (server time). Repeating it changes nothing.
create or replace function public.r3s_reveal_question(p_session_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions;
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  perform public._r3_require(g, p_question_id, null);
  if g.question_revealed then return jsonb_build_object('ok', true, 'answer_started_at', g.answer_started_at); end if;
  if g.phase = 'tie' then perform public._err('R3_TIE_UNRESOLVED', 'Resolve the tie for the highest bid first.'); end if;
  if g.phase <> 'closed' then perform public._err('R3_BIDDING_OPEN', 'Close bidding before revealing the question.'); end if;
  if not g.topic_revealed then perform public._err('R3_TOPIC_HIDDEN', 'Reveal the topic of this blind question first.'); end if;
  update public.r3_sessions set phase = 'answering', question_revealed = true, answer_started_at = now(), updated_at = now()
  where id = g.id returning * into g;
  perform public._r3_event(g, 'question_revealed', g.current_team_id);
  return jsonb_build_object('ok', true, 'answer_started_at', g.answer_started_at);
end $$;

-- Confirm the current team's outcome. Atomic, idempotent by request id, once per team per question.
create or replace function public.r3s_record_outcome(p_request_id uuid, p_session_id uuid, p_question_id uuid, p_team_id uuid, p_outcome text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  g public.r3_sessions; e public.r3_events; st public.r3_session_teams; v public.r3_versions; t public.teams;
  v_top boolean; v_bid integer; d record; v_id bigint; v_next text;
begin
  perform public._require_organizer();
  if p_request_id is null then perform public._err('VALIDATION', 'A request id is required.'); end if;
  select * into e from public.r3_events where request_id = p_request_id;
  if found then
    return jsonb_build_object('duplicate_request', true, 'event_id', e.id, 'outcome', e.outcome, 'team_id', e.team_id, 'was_top', e.was_top, 'bid', e.bid,
      'score_delta', e.score_delta, 'budget_delta', e.budget_delta);
  end if;
  g := public._r3_lock_session(p_session_id);
  if p_outcome is null or p_outcome not in ('correct', 'wrong', 'pass', 'timeout') then perform public._err('VALIDATION', 'The outcome must be correct, wrong, pass or timeout.'); end if;
  perform public._r3_require(g, p_question_id, array['answering']);
  if g.current_team_id is distinct from p_team_id then perform public._err('R3_NOT_CURRENT_TEAM', 'It is not this team''s turn to answer.'); end if;
  if exists (select 1 from public.r3_events where session_id = g.id and question_id = g.question_id and team_id = p_team_id and kind = 'outcome') then
    perform public._err('R3_ALREADY_ANSWERED', 'This team already had its turn on this question.');
  end if;
  select * into v from public.r3_versions where id = g.version_id;
  if p_outcome = 'timeout' and now() < g.answer_started_at + make_interval(secs => v.answer_seconds) then
    perform public._err('R3_TIMER_RUNNING', 'The answer timer is still running.');
  end if;
  select * into st from public.r3_session_teams where session_id = g.id and team_id = p_team_id for update;
  select amount into v_bid from public.r3_bids where session_id = g.id and question_id = g.question_id and team_id = p_team_id and status = 'bid';
  v_top := g.order_pos = 1;
  select * into d from public._r3_deltas(v_top, p_outcome, v_bid);
  update public.r3_session_teams set score = score + d.score_delta, budget = budget + d.budget_delta
  where session_id = g.id and team_id = p_team_id returning * into st;
  select * into t from public.teams where id = p_team_id;
  insert into public.r3_events (request_id, session_id, question_id, seq, team_id, team_number, team_name, kind, outcome, was_top, bid,
    score_delta, budget_delta, score_after, budget_after, actor)
  values (p_request_id, g.id, g.question_id, (select seq from public.r3_version_questions where id = g.question_id), t.id, t.team_number, t.team_name,
    'outcome', p_outcome, v_top, v_bid, d.score_delta, d.budget_delta, st.score, st.budget, auth.uid())
  returning id into v_id;
  update public.r3_sessions set last_event_id = v_id, updated_at = now() where id = g.id returning * into g;
  if p_outcome = 'correct' then
    perform public._r3_complete(g, 'correct', p_team_id); v_next := 'done';
  elsif g.order_pos < cardinality(g.bid_order) then
    update public.r3_sessions set phase = 'between', updated_at = now() where id = g.id; v_next := 'next_bidder';
  else
    perform public._r3_complete(g, 'no_correct', null); v_next := 'done';
  end if;
  return jsonb_build_object('duplicate_request', false, 'event_id', v_id, 'outcome', p_outcome, 'team_id', p_team_id, 'was_top', v_top, 'bid', v_bid,
    'score_delta', d.score_delta, 'budget_delta', d.budget_delta, 'next', v_next);
end $$;

-- Offer the question to the next team in the finalized order; restarts the answer timer.
create or replace function public.r3s_next_bidder(p_session_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions;
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  perform public._r3_require(g, p_question_id, array['between']);
  update public.r3_sessions set phase = 'answering', order_pos = order_pos + 1, current_team_id = bid_order[order_pos + 1],
    answer_started_at = now(), updated_at = now() where id = g.id returning * into g;
  perform public._r3_event(g, 'next_bidder', g.current_team_id);
  return jsonb_build_object('ok', true, 'team_id', g.current_team_id);
end $$;

create or replace function public.r3s_reveal_answer(p_session_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions;
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  perform public._r3_require(g, p_question_id, array['answering', 'between', 'done']);
  if not g.question_revealed then perform public._err('R3_NOT_REVEALED', 'Reveal the question before its answer.'); end if;
  if not g.answer_revealed then
    update public.r3_sessions set answer_revealed = true, updated_at = now() where id = g.id returning * into g;
    perform public._r3_event(g, 'answer_revealed');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- After a completed question: back to the question list (the question stays used).
create or replace function public.r3s_finish_question(p_session_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions;
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  if g.phase = 'idle' then return jsonb_build_object('ok', true); end if;
  perform public._r3_require(g, p_question_id, array['done']);
  update public.r3_sessions set phase = 'idle', question_id = null, topic_revealed = false, bid_started_at = null, bids_closed_at = null,
    bid_order = '{}', order_pos = 0, current_team_id = null, question_revealed = false, answer_started_at = null, answer_revealed = false,
    updated_at = now() where id = g.id;
  return jsonb_build_object('ok', true);
end $$;

-- End the auction. Refused while a question is being bid on or answered (no scoring may be pending).
create or replace function public.r3s_end_auction(p_session_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions;
begin
  perform public._require_organizer();
  select * into g from public.r3_sessions where id = p_session_id for update;
  if not found then perform public._err('R3_SESSION_NOT_FOUND', 'Round 3 auction not found.'); end if;
  if g.status = 'ended' then return jsonb_build_object('ok', true); end if;
  if g.phase not in ('idle', 'done') then perform public._err('R3_QUESTION_LIVE', 'Finish or cancel the open question before ending the auction.'); end if;
  update public.r3_sessions set status = 'ended', ended_at = now(), phase = 'idle', question_id = null, topic_revealed = false, bid_order = '{}',
    order_pos = 0, current_team_id = null, question_revealed = false, answer_started_at = null, answer_revealed = false, bid_started_at = null,
    bids_closed_at = null, updated_at = now()
  where id = g.id returning * into g;
  perform public._r3_event(g, 'auction_ended');
  return jsonb_build_object('ok', true);
end $$;

-- Show (or hide) the final ranking on the projector — only after the auction has ended.
create or replace function public.r3s_reveal_results(p_session_id uuid, p_reveal boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions;
begin
  perform public._require_organizer();
  select * into g from public.r3_sessions where id = p_session_id for update;
  if not found then perform public._err('R3_SESSION_NOT_FOUND', 'Round 3 auction not found.'); end if;
  if g.status <> 'ended' then perform public._err('R3_NOT_ENDED', 'End the auction before revealing the final results.'); end if;
  update public.r3_sessions set results_revealed = coalesce(p_reveal, false), updated_at = now() where id = g.id returning * into g;
  perform public._r3_event(g, 'results_revealed', null, jsonb_build_object('revealed', g.results_revealed));
  return jsonb_build_object('ok', true, 'results_revealed', g.results_revealed);
end $$;

-- Final ranking (competition ranking: equal scores share a rank and are flagged as tied).
create or replace function public._r3_ranking(p_session uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('rank', x.rank, 'tied', x.tied, 'team_id', x.team_id, 'team_number', x.team_number, 'team_name', x.team_name,
      'section', x.section, 'score', x.score, 'budget', x.budget) order by x.rank, x.seat), '[]'::jsonb)
  from (
    select t.id as team_id, t.team_number, t.team_name, t.section, st.score, st.budget, st.seat,
      rank() over (order by st.score desc)::int as rank,
      count(*) over (partition by st.score) > 1 as tied
    from public.r3_session_teams st join public.teams t on t.id = st.team_id where st.session_id = p_session
  ) x;
$$;

-- Organizer results summary (works during and after the auction).
create or replace function public.r3s_results(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare g public.r3_sessions; v public.r3_versions;
begin
  perform public._require_organizer();
  select * into g from public.r3_sessions where id = p_session_id;
  if not found then perform public._err('R3_SESSION_NOT_FOUND', 'Round 3 auction not found.'); end if;
  select * into v from public.r3_versions where id = g.version_id;
  return jsonb_build_object(
    'session', jsonb_build_object('id', g.id, 'title', v.title, 'version', v.version, 'section', g.section, 'status', g.status,
      'results_revealed', g.results_revealed, 'started_at', g.started_at, 'ended_at', g.ended_at),
    'ranking', public._r3_ranking(g.id),
    'summary', coalesce((select jsonb_agg(jsonb_build_object('team_id', st.team_id,
        'correct', (select count(*) from public.r3_events e where e.session_id = g.id and e.team_id = st.team_id and e.kind = 'outcome' and e.outcome = 'correct'),
        'wrong', (select count(*) from public.r3_events e where e.session_id = g.id and e.team_id = st.team_id and e.kind = 'outcome' and e.outcome = 'wrong'),
        'passes', (select count(*) from public.r3_events e where e.session_id = g.id and e.team_id = st.team_id and e.kind = 'outcome' and e.outcome in ('pass', 'timeout')),
        'points_awarded', (select coalesce(sum(e.score_delta), 0) from public.r3_events e where e.session_id = g.id and e.team_id = st.team_id and e.kind = 'outcome'),
        'budget_deducted', (select coalesce(-sum(e.budget_delta), 0) from public.r3_events e where e.session_id = g.id and e.team_id = st.team_id and e.kind = 'outcome'))
      order by st.seat) from public.r3_session_teams st where st.session_id = g.id), '[]'::jsonb),
    'questions', coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('winner_name', w.team_name, 'top_name', tp.team_name) order by r.completed_at)
      from public.r3_question_results r left join public.teams w on w.id = r.winner_team_id left join public.teams tp on tp.id = r.top_team_id
      where r.session_id = g.id), '[]'::jsonb),
    'outcomes', coalesce((select jsonb_agg(to_jsonb(e) - 'request_id' order by e.id) from public.r3_events e where e.session_id = g.id and e.kind = 'outcome'), '[]'::jsonb));
end $$;

-- Board of one auction. p_host = false is the PUBLIC projector view: never scores, never an unrevealed topic
-- (BLIND), question or answer. p_host = true adds the private score, question, answer, the question list and the log.
create or replace function public.r3s_board(p_session_id uuid, p_host boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare g public.r3_sessions; v public.r3_versions; q public.r3_version_questions; a public.r3_version_answers; s public.r3_sets;
  v_host boolean := coalesce(p_host, false); b jsonb; e public.r3_events;
begin
  perform public._require_organizer();
  select * into g from public.r3_sessions where id = p_session_id;
  if not found then perform public._err('R3_SESSION_NOT_FOUND', 'Round 3 auction not found.'); end if;
  select * into v from public.r3_versions where id = g.version_id;
  if g.question_id is not null then
    select * into q from public.r3_version_questions where id = g.question_id;
    select * into a from public.r3_version_answers where question_id = q.id;
  end if;
  if g.last_event_id is not null and g.phase in ('between', 'done') then select * into e from public.r3_events where id = g.last_event_id; end if;
  b := jsonb_build_object(
    'server_now', now(),
    'view', case when v_host then 'host' else 'projector' end,
    'session', jsonb_build_object('id', g.id, 'status', g.status, 'section', g.section, 'title', v.title, 'version', v.version,
      'results_revealed', g.results_revealed, 'started_at', g.started_at, 'ended_at', g.ended_at),
    'settings', jsonb_build_object('bid_seconds', v.bid_seconds, 'answer_seconds', v.answer_seconds, 'min_bid', 10, 'bid_step', 10),
    'questions', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'seq', x.seq, 'mode', x.mode, 'mystery_no', x.mystery_no,
        'label', case when x.mode = 'BLIND' then 'MYSTERY QUESTION #' || x.mystery_no else x.topic_name end,
        'used', exists (select 1 from public.r3_question_results r where r.session_id = g.id and r.question_id = x.id)) order by x.seq)
      from public.r3_version_questions x where x.version_id = v.id), '[]'::jsonb),
    'current', jsonb_build_object(
      'phase', g.phase, 'question_id', g.question_id, 'seq', q.seq, 'mode', q.mode, 'mystery_no', q.mystery_no,
      'label', case when q.id is null then null when q.mode = 'BLIND' then 'MYSTERY QUESTION #' || q.mystery_no else q.topic_name end,
      'topic', case when g.topic_revealed then q.topic_name end,
      'topic_revealed', g.topic_revealed,
      'question_text', case when g.question_revealed then q.question_text end,
      'question_revealed', g.question_revealed,
      'answer_text', case when g.answer_revealed then a.answer_text end,
      'explanation', case when g.answer_revealed then a.explanation end,
      'answer_revealed', g.answer_revealed,
      'bid_started_at', g.bid_started_at, 'bids_closed_at', g.bids_closed_at, 'answer_started_at', g.answer_started_at,
      'bid_order', to_jsonb(g.bid_order), 'order_pos', g.order_pos, 'current_team_id', g.current_team_id),
    'teams', public._r3_teams(g.id, v_host),
    'last_outcome', case when e.id is not null and e.kind = 'outcome' then jsonb_build_object('team_id', e.team_id, 'team_name', e.team_name,
        'team_number', e.team_number, 'outcome', e.outcome, 'was_top', e.was_top, 'budget_delta', e.budget_delta) end,
    'final', case when g.status = 'ended' and g.results_revealed then public._r3_ranking(g.id) end);
  if not v_host then return b; end if;
  return b
    || jsonb_build_object('current', (b->'current') || jsonb_build_object('topic', q.topic_name, 'question_text', q.question_text,
          'answer_text', a.answer_text, 'explanation', a.explanation))
    || jsonb_build_object(
      'session', (b->'session') || jsonb_build_object('join_code', (select join_code from public.r3_sets where id = g.set_id)),
      'question_list', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'seq', x.seq, 'mode', x.mode, 'mystery_no', x.mystery_no, 'topic_name', x.topic_name,
          'question_text', x.question_text, 'used', exists (select 1 from public.r3_question_results r where r.session_id = g.id and r.question_id = x.id)) order by x.seq)
        from public.r3_version_questions x where x.version_id = v.id), '[]'::jsonb),
      'last_outcome', case when e.id is not null and e.kind = 'outcome' then jsonb_build_object('team_id', e.team_id, 'team_name', e.team_name, 'team_number', e.team_number,
          'outcome', e.outcome, 'was_top', e.was_top, 'bid', e.bid, 'score_delta', e.score_delta, 'budget_delta', e.budget_delta) end,
      'ranking', public._r3_ranking(g.id),
      'log', coalesce((select jsonb_agg(to_jsonb(x) - 'request_id' order by x.id desc) from (select * from public.r3_events where session_id = g.id order by id desc limit 60) x), '[]'::jsonb));
end $$;

-- ===========================================================================
-- Security: RLS (organizer read only; answers never readable directly), Realtime, function permissions
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['r3_sets', 'r3_set_topics', 'r3_set_questions', 'r3_set_answers', 'r3_versions', 'r3_version_questions', 'r3_version_answers',
                           'r3_sessions', 'r3_session_teams', 'r3_bids', 'r3_events', 'r3_question_results'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated, public', t);
  end loop;
  -- Organizers may read everything except the answer tables (answers only via organizer RPCs). Writes only through RPCs.
  foreach t in array array['r3_sets', 'r3_set_topics', 'r3_set_questions', 'r3_versions', 'r3_version_questions',
                           'r3_sessions', 'r3_session_teams', 'r3_bids', 'r3_events', 'r3_question_results'] loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_organizer_read', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.is_organizer()))', t || '_organizer_read', t);
  end loop;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['r3_sets', 'r3_set_topics', 'r3_set_questions', 'r3_sessions', 'r3_session_teams', 'r3_bids', 'r3_events'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- Organizer RPCs (each checks organizer membership internally). Identical to migration 12.
grant execute on function
  public.is_organizer(), public.server_now(), public.ensure_session(),
  public.save_team(jsonb), public.delete_team(uuid, boolean), public.import_teams(jsonb, boolean, boolean),
  public.save_question(jsonb), public.delete_question(uuid, boolean), public.reorder_questions(uuid[]),
  public.import_questions(jsonb, boolean, boolean), public.remove_demo_data(boolean, boolean, boolean),
  public.update_settings(jsonb), public.start_quiz(), public.pause_quiz(), public.resume_quiz(), public.reset_timer(),
  public.end_quiz(), public.go_to_question(integer), public.set_question_completed(uuid, boolean),
  public.set_projector_view(text), public.set_corrections(boolean, text), public.new_session(),
  public.record_answer(uuid, uuid, uuid, text, boolean, text), public.undo_last_action(uuid), public.get_standings(),
  public.set_tiebreak(uuid, numeric, text), public.confirm_qualifiers(uuid[], text), public.reopen_results(text),
  public.reveal_results(boolean), public.restore_backup(jsonb),
  public.update_quiz_details(jsonb), public.publish_quiz(), public.unpublish_quiz(), public.regenerate_join_code(),
  public.set_registration(boolean), public.revoke_participant(uuid), public.rotate_team_pin(uuid),
  public.create_set(jsonb), public.duplicate_set(uuid), public.delete_set(uuid), public.archive_set(uuid, text),
  public.revoke_join_code(), public.finalize_expired_attempts(), public.finalize_attempt(uuid, text),
  public.reset_attempt(uuid, text), public.correct_set_question(uuid, jsonb, text), public.get_set_results()
to authenticated;

-- Round 2 organizer RPCs: migration-7 board (kept for compatibility) …
grant execute on function
  public.r2_save_topic(jsonb), public.r2_delete_topic(uuid), public.r2_save_question(jsonb), public.r2_delete_question(uuid),
  public.r2_set_teams(uuid[]), public.r2_update_settings(jsonb), public.r2_select_question(uuid), public.r2_cancel_selection(),
  public.r2_reveal_question(uuid), public.r2_reveal_answer(uuid), public.r2_score_question(uuid, uuid, uuid, text),
  public.r2_close_question(uuid, uuid), public.r2_reset_results(text), public.r2_board()
to authenticated;

-- … and trivia sets, versions and sessions (migrations 10 and 11).
grant execute on function
  public.r2s_overview(), public.r2s_set_detail(uuid), public.r2s_save_set(jsonb), public.r2s_delete_set(uuid), public.r2s_archive_set(uuid),
  public.r2s_save_topic(jsonb), public.r2s_delete_topic(uuid), public.r2s_save_question(jsonb), public.r2s_delete_question(uuid),
  public.r2s_publish_set(uuid), public.r2s_lookup(text), public.r2s_eligible_teams(text, text),
  public.r2s_start_session(uuid, text, text, uuid[]), public.r2s_end_session(uuid),
  public.r2s_select(uuid, uuid), public.r2s_cancel(uuid), public.r2s_reveal_question(uuid, uuid), public.r2s_reveal_answer(uuid, uuid),
  public.r2s_score(uuid, uuid, uuid, uuid, text), public.r2s_close_question(uuid, uuid, uuid), public.r2s_board(uuid, boolean)
to authenticated;

-- Round 3 organizer RPCs: auction sets, versions and live auctions (this migration).
grant execute on function
  public.r3s_overview(), public.r3s_set_detail(uuid), public.r3s_save_set(jsonb), public.r3s_delete_set(uuid), public.r3s_archive_set(uuid),
  public.r3s_save_topic(jsonb), public.r3s_delete_topic(uuid), public.r3s_save_question(jsonb), public.r3s_delete_question(uuid),
  public.r3s_move(text, uuid, integer), public.r3s_publish_set(uuid), public.r3s_lookup(text), public.r3s_eligible_teams(text, text),
  public.r3s_start_session(uuid, text, text, uuid[]), public.r3s_select_question(uuid, uuid), public.r3s_cancel_question(uuid, uuid),
  public.r3s_start_bidding(uuid, uuid), public.r3s_record_bid(uuid, uuid, uuid, integer, boolean), public.r3s_close_bidding(uuid, uuid),
  public.r3s_resolve_tie(uuid, uuid, uuid[], text), public.r3s_reopen_bidding(uuid, uuid, text), public.r3s_reveal_topic(uuid, uuid),
  public.r3s_reveal_question(uuid, uuid), public.r3s_record_outcome(uuid, uuid, uuid, uuid, text), public.r3s_next_bidder(uuid, uuid),
  public.r3s_reveal_answer(uuid, uuid), public.r3s_finish_question(uuid, uuid), public.r3s_end_auction(uuid),
  public.r3s_reveal_results(uuid, boolean), public.r3s_results(uuid), public.r3s_board(uuid, boolean)
to authenticated;

-- Registration desk RPCs (each checks registration staff OR organizer internally).
grant execute on function
  public.registration_access(), public.is_registration_staff(), public.reg_overview(), public.reg_save_team(jsonb)
to authenticated;

-- Participant RPCs (anon and authenticated; identical to migration 12).
grant execute on function
  public.join_lookup(text), public.join_roster(text, text), public.join_registered_team(text, text, integer, text),
  public.join_team(text, integer, text, text),
  public.register_team(text, text, text, text, text, text), public.participant_state(text, integer),
  public.participant_start(text), public.participant_submit(text, uuid, uuid, text), public.participant_finish(text),
  public.participant_leave(text)
to anon, authenticated;

-- Self-check (as in migration 12, extended to Round 3).
-- Only checks that stay true when an older migration is re-run later (a later migration may add r3s_* functions that
-- this file does not know): Round 2 functions callable, nothing callable by anon, no internal helper exposed.
-- "Every r3s_* function is executable by signed-in users" is verified by the test suite and the README check query.
do $$
declare bad text;
begin
  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'r2s\_%' and not has_function_privilege('authenticated', p.oid, 'execute');
  if bad is not null then raise exception 'Permission check failed: authenticated cannot execute %', bad; end if;
  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and (p.proname like 'r2s\_%' or p.proname like 'r3s\_%' or p.proname like 'r2\_%' or p.proname in ('get_standings', 'publish_quiz', 'record_answer', 'restore_backup'))
    and has_function_privilege('anon', p.oid, 'execute');
  if bad is not null then raise exception 'Permission check failed: anon can execute organizer function(s) %', bad; end if;
  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like '\_%' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
  if bad is not null then raise exception 'Permission check failed: internal helper(s) are callable: %', bad; end if;
end $$;

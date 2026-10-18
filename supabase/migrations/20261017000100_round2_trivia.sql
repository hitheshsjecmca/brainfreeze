-- Migration 7 — Round 2 "MIND MELTDOWN": organizer-controlled trivia board.
--
-- New tables only; no Round 1 table or function changes (the final block re-applies the
-- complete function permission set, as migration 6 did, so new functions are never
-- executable by anon or by default PUBLIC grants).
--
--   r2_settings  singleton: question timer (default 18 s) and wrong-answer penalty (default 50 % of the value)
--   r2_topics    any number of topics
--   r2_questions any number of point-valued questions per topic; `used` once scored or closed
--   r2_answers   the answer, in its own table: never returned by r2_board() until the host reveals it,
--                and not published to Realtime
--   r2_teams     the Round 2 roster (e.g. Round 1 qualifiers), chosen by an organizer
--   r2_results   one row per scored/closed question (audit: question, team, result, value, points, host, time);
--                a partial unique index allows exactly one live result per question
--   r2_game      singleton game state: idle → selected (tile chosen, question hidden) → revealed (timer running)
--
-- All writes go through SECURITY DEFINER RPCs that require an organizer. Scores are computed in
-- the database from the stored point value and the penalty setting; the client never sends a score.
-- Rollback: drop the r2_* functions and tables (no other object depends on them).

-- ===========================================================================
-- Tables
-- ===========================================================================
create table if not exists public.r2_settings (
  id                    smallint primary key default 1 check (id = 1),
  timer_seconds         integer not null default 18 check (timer_seconds between 5 and 120),
  wrong_penalty_percent numeric(5,2) not null default 50 check (wrong_penalty_percent between 0 and 100),
  updated_at            timestamptz not null default now()
);
insert into public.r2_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.r2_topics (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 60),
  position   integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists r2_topics_name_key on public.r2_topics (lower(name));

create table if not exists public.r2_questions (
  id            uuid primary key default gen_random_uuid(),
  topic_id      uuid not null references public.r2_topics(id) on delete cascade,
  points        numeric(10,2) not null check (points > 0 and points <= 10000),
  question_text text not null check (char_length(question_text) between 1 and 1000),
  used          boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists r2_questions_topic_idx on public.r2_questions (topic_id);

create table if not exists public.r2_answers (
  question_id uuid primary key references public.r2_questions(id) on delete cascade,
  answer_text text not null check (char_length(answer_text) between 1 and 500)
);

create table if not exists public.r2_teams (
  team_id  uuid primary key references public.teams(id) on delete cascade,
  added_at timestamptz not null default now()
);

create table if not exists public.r2_results (
  id              bigint generated always as identity primary key,
  request_id      uuid not null unique,
  question_id     uuid references public.r2_questions(id) on delete set null,
  topic_name      text not null,
  question_text   text not null,
  team_id         uuid references public.teams(id) on delete set null,
  team_number     integer,
  team_name       text,
  team_section    text,
  result          text not null check (result in ('right', 'wrong', 'no_score')),
  point_value     numeric(10,2) not null,
  points          numeric(10,2) not null,
  answer_revealed boolean not null default false,
  revealed_at     timestamptz,
  actor           uuid,
  created_at      timestamptz not null default now(),
  voided_at       timestamptz,
  void_reason     text
);
-- Each question can be scored (or closed) once; a reset voids results instead of deleting them.
create unique index if not exists r2_results_one_per_question on public.r2_results (question_id) where voided_at is null;
create index if not exists r2_results_team_idx on public.r2_results (team_id);

create table if not exists public.r2_game (
  id              smallint primary key default 1 check (id = 1),
  phase           text not null default 'idle' check (phase in ('idle', 'selected', 'revealed')),
  question_id     uuid references public.r2_questions(id) on delete set null,
  revealed_at     timestamptz,
  answer_revealed boolean not null default false,
  last_result_id  bigint references public.r2_results(id) on delete set null,
  updated_at      timestamptz not null default now()
);
insert into public.r2_game (id) values (1) on conflict (id) do nothing;

-- ===========================================================================
-- Helpers
-- ===========================================================================
create or replace function public._r2_game_lock() returns public.r2_game
language plpgsql security definer set search_path = '' as $$
declare g public.r2_game;
begin
  insert into public.r2_game (id) values (1) on conflict (id) do nothing;
  select * into g from public.r2_game where id = 1 for update;
  return g;
end $$;

create or replace function public._r2_settings() returns public.r2_settings
language plpgsql security definer set search_path = '' as $$
declare st public.r2_settings;
begin
  insert into public.r2_settings (id) values (1) on conflict (id) do nothing;
  select * into st from public.r2_settings where id = 1;
  return st;
end $$;

-- Score change for a result: right = +value; wrong = −(value × penalty %), rounded to 2 decimals; otherwise 0.
create or replace function public._r2_delta(p_points numeric, p_result text, p_penalty_percent numeric) returns numeric
language sql immutable set search_path = '' as $$
  select case p_result
    when 'right' then p_points
    when 'wrong' then -round(p_points * p_penalty_percent / 100, 2)
    else 0::numeric end;
$$;

create or replace function public._r2_idle() returns void
language sql security definer set search_path = '' as $$
  update public.r2_game set phase = 'idle', question_id = null, revealed_at = null, answer_revealed = false, updated_at = now() where id = 1;
$$;

-- ===========================================================================
-- Organizer: topics, questions, roster, settings
-- ===========================================================================
create or replace function public.r2_save_topic(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p->>'id', '')::uuid; v_name text := public._clean(p->>'name'); v_pos integer;
begin
  perform public._require_organizer();
  if v_name is null or char_length(v_name) > 60 then perform public._err('VALIDATION', 'Topic name is required (max 60 characters).'); end if;
  if exists (select 1 from public.r2_topics where lower(name) = lower(v_name) and id is distinct from v_id) then
    perform public._err('VALIDATION', 'A topic with that name already exists.');
  end if;
  if v_id is null then
    select coalesce(max(position), 0) + 1 into v_pos from public.r2_topics;
    insert into public.r2_topics (name, position) values (v_name, v_pos) returning id into v_id;
  else
    update public.r2_topics set name = v_name where id = v_id;
    if not found then perform public._err('TRIVIA_NOT_FOUND', 'Topic not found.'); end if;
  end if;
  return v_id;
end $$;

create or replace function public.r2_delete_topic(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r2_game;
begin
  perform public._require_organizer();
  g := public._r2_game_lock();
  if not exists (select 1 from public.r2_topics where id = p_id) then perform public._err('TRIVIA_NOT_FOUND', 'Topic not found.'); end if;
  if g.phase <> 'idle' and exists (select 1 from public.r2_questions where id = g.question_id and topic_id = p_id) then
    perform public._err('TRIVIA_QUESTION_ACTIVE', 'A question of this topic is open on the board.');
  end if;
  if exists (select 1 from public.r2_questions where topic_id = p_id and used) then
    perform public._err('TRIVIA_HAS_RESULTS', 'This topic has questions that were already played. Reset Round 2 results first.');
  end if;
  delete from public.r2_topics where id = p_id;
  return jsonb_build_object('deleted', true);
end $$;

create or replace function public.r2_save_question(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_topic uuid := nullif(p->>'topic_id', '')::uuid;
  v_points_raw text := btrim(coalesce(p->>'points', ''));
  v_points numeric;
  v_text text := public._clean(p->>'question_text');
  v_answer text := public._clean(p->>'answer_text');
  g public.r2_game;
  q public.r2_questions;
begin
  perform public._require_organizer();
  g := public._r2_game_lock();
  if v_topic is null or not exists (select 1 from public.r2_topics where id = v_topic) then perform public._err('VALIDATION', 'Choose a topic.'); end if;
  if v_points_raw !~ '^[0-9]+(\.[0-9]{1,2})?$' then perform public._err('VALIDATION', 'Points must be a positive number (up to 2 decimals).'); end if;
  v_points := v_points_raw::numeric;
  if v_points <= 0 or v_points > 10000 then perform public._err('VALIDATION', 'Points must be between 0.01 and 10000.'); end if;
  if v_text is null or char_length(v_text) > 1000 then perform public._err('VALIDATION', 'Question text is required (max 1000 characters).'); end if;
  if v_answer is null or char_length(v_answer) > 500 then perform public._err('VALIDATION', 'The answer is required (max 500 characters).'); end if;
  if v_id is null then
    insert into public.r2_questions (topic_id, points, question_text) values (v_topic, v_points, v_text) returning id into v_id;
    insert into public.r2_answers (question_id, answer_text) values (v_id, v_answer);
  else
    select * into q from public.r2_questions where id = v_id for update;
    if not found then perform public._err('TRIVIA_NOT_FOUND', 'Question not found.'); end if;
    if q.used then perform public._err('TRIVIA_QUESTION_USED', 'This question was already played and cannot be edited.'); end if;
    if g.phase <> 'idle' and g.question_id = v_id then perform public._err('TRIVIA_QUESTION_ACTIVE', 'This question is open on the board.'); end if;
    update public.r2_questions set topic_id = v_topic, points = v_points, question_text = v_text, updated_at = now() where id = v_id;
    insert into public.r2_answers (question_id, answer_text) values (v_id, v_answer)
    on conflict (question_id) do update set answer_text = excluded.answer_text;
  end if;
  return v_id;
end $$;

create or replace function public.r2_delete_question(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r2_game; q public.r2_questions;
begin
  perform public._require_organizer();
  g := public._r2_game_lock();
  select * into q from public.r2_questions where id = p_id for update;
  if not found then perform public._err('TRIVIA_NOT_FOUND', 'Question not found.'); end if;
  if g.phase <> 'idle' and g.question_id = p_id then perform public._err('TRIVIA_QUESTION_ACTIVE', 'This question is open on the board.'); end if;
  if q.used then perform public._err('TRIVIA_HAS_RESULTS', 'This question was already played. Reset Round 2 results first.'); end if;
  delete from public.r2_questions where id = p_id;
  return jsonb_build_object('deleted', true);
end $$;

-- Replace the Round 2 roster. Teams that already have (non-voided) results cannot be removed.
create or replace function public.r2_set_teams(p_team_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[] := coalesce(p_team_ids, '{}');
begin
  perform public._require_organizer();
  perform public._r2_game_lock();
  if exists (select 1 from unnest(v_ids) x where not exists (select 1 from public.teams t where t.id = x)) then
    perform public._err('TEAM_NOT_FOUND', 'A selected team no longer exists.');
  end if;
  if exists (select 1 from public.r2_teams rt where not (rt.team_id = any (v_ids))
             and exists (select 1 from public.r2_results r where r.team_id = rt.team_id and r.voided_at is null)) then
    perform public._err('TRIVIA_HAS_RESULTS', 'A team with Round 2 points cannot be removed. Reset Round 2 results first.');
  end if;
  delete from public.r2_teams where not (team_id = any (v_ids));
  insert into public.r2_teams (team_id) select distinct x from unnest(v_ids) x on conflict (team_id) do nothing;
  return jsonb_build_object('teams', (select count(*) from public.r2_teams));
end $$;

create or replace function public.r2_update_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r2_game; v_timer text := btrim(coalesce(p->>'timer_seconds', '')); v_pct text := btrim(coalesce(p->>'wrong_penalty_percent', ''));
begin
  perform public._require_organizer();
  g := public._r2_game_lock();
  if g.phase <> 'idle' then perform public._err('TRIVIA_QUESTION_ACTIVE', 'Finish or cancel the open question before changing the rules.'); end if;
  if v_timer <> '' and (v_timer !~ '^[0-9]+$' or v_timer::int not between 5 and 120) then
    perform public._err('VALIDATION', 'The question timer must be 5–120 whole seconds.');
  end if;
  if v_pct <> '' and (v_pct !~ '^[0-9]+(\.[0-9]{1,2})?$' or v_pct::numeric > 100) then
    perform public._err('VALIDATION', 'The wrong-answer penalty must be 0–100 % of the question value.');
  end if;
  perform public._r2_settings();
  update public.r2_settings set
    timer_seconds = coalesce(nullif(v_timer, '')::int, timer_seconds),
    wrong_penalty_percent = coalesce(nullif(v_pct, '')::numeric, wrong_penalty_percent),
    updated_at = now()
  where id = 1;
  return jsonb_build_object('ok', true);
end $$;

-- ===========================================================================
-- Organizer: gameplay
-- ===========================================================================
-- Choosing a tile only opens it on the host's control panel; the question stays hidden.
create or replace function public.r2_select_question(p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r2_game; q public.r2_questions;
begin
  perform public._require_organizer();
  g := public._r2_game_lock();
  if g.phase <> 'idle' then
    if g.phase = 'selected' and g.question_id = p_question_id then return jsonb_build_object('ok', true, 'phase', g.phase); end if;
    perform public._err('TRIVIA_QUESTION_ACTIVE', 'Another question is open. Finish or cancel it first.');
  end if;
  select * into q from public.r2_questions where id = p_question_id;
  if not found then perform public._err('TRIVIA_NOT_FOUND', 'Question not found.'); end if;
  if q.used then perform public._err('TRIVIA_QUESTION_USED', 'This question has already been played.'); end if;
  update public.r2_game set phase = 'selected', question_id = q.id, revealed_at = null, answer_revealed = false,
    last_result_id = null, updated_at = now() where id = 1;
  return jsonb_build_object('ok', true, 'phase', 'selected');
end $$;

create or replace function public.r2_cancel_selection() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r2_game;
begin
  perform public._require_organizer();
  g := public._r2_game_lock();
  if g.phase = 'revealed' then
    perform public._err('TRIVIA_ALREADY_REVEALED', 'The question is already on screen. Score it, or close it without points.');
  end if;
  if g.phase = 'selected' then perform public._r2_idle(); end if;
  return jsonb_build_object('ok', true);
end $$;

-- Shows the question and starts the timer (server time). Repeating it never restarts the timer.
create or replace function public.r2_reveal_question(p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r2_game;
begin
  perform public._require_organizer();
  g := public._r2_game_lock();
  if g.question_id is distinct from p_question_id or g.phase = 'idle' then
    perform public._err('TRIVIA_NOT_SELECTED', 'That question is not the one open on the board.');
  end if;
  if g.phase = 'selected' then
    update public.r2_game set phase = 'revealed', revealed_at = now(), updated_at = now() where id = 1 returning * into g;
  end if;
  return jsonb_build_object('ok', true, 'revealed_at', g.revealed_at);
end $$;

-- Shows the stored answer. Never changes a score.
create or replace function public.r2_reveal_answer(p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r2_game;
begin
  perform public._require_organizer();
  g := public._r2_game_lock();
  if g.phase <> 'revealed' or g.question_id is distinct from p_question_id then
    perform public._err('TRIVIA_NOT_REVEALED', 'Reveal the question before its answer.');
  end if;
  update public.r2_game set answer_revealed = true, updated_at = now() where id = 1;
  return jsonb_build_object('ok', true);
end $$;

-- Record Right/Wrong for the team the host confirmed. Atomic, idempotent by request id,
-- one result per question; the score change is computed here from the stored value.
create or replace function public.r2_score_question(p_request_id uuid, p_question_id uuid, p_team_id uuid, p_result text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r2_game; q public.r2_questions; st public.r2_settings; t public.teams; r public.r2_results; v_pts numeric; v_id bigint;
begin
  perform public._require_organizer();
  if p_request_id is null then perform public._err('VALIDATION', 'A request id is required.'); end if;
  g := public._r2_game_lock(); -- serializes all gameplay writes
  select * into r from public.r2_results where request_id = p_request_id;
  if found then
    return jsonb_build_object('duplicate_request', true, 'result_id', r.id, 'result', r.result, 'team_id', r.team_id, 'points', r.points);
  end if;
  if p_result is null or p_result not in ('right', 'wrong') then perform public._err('VALIDATION', 'The result must be right or wrong.'); end if;
  select * into q from public.r2_questions where id = p_question_id for update;
  if not found then perform public._err('TRIVIA_NOT_FOUND', 'Question not found.'); end if;
  if q.used then perform public._err('TRIVIA_QUESTION_USED', 'This question has already been scored.'); end if;
  if g.phase <> 'revealed' or g.question_id is distinct from p_question_id then
    perform public._err('TRIVIA_NOT_REVEALED', 'Reveal the question before scoring it.');
  end if;
  select tm.* into t from public.teams tm join public.r2_teams rt on rt.team_id = tm.id where tm.id = p_team_id;
  if not found then perform public._err('TRIVIA_TEAM_NOT_IN_ROUND', 'That team is not in the Round 2 roster.'); end if;
  st := public._r2_settings();
  v_pts := public._r2_delta(q.points, p_result, st.wrong_penalty_percent);
  insert into public.r2_results (request_id, question_id, topic_name, question_text, team_id, team_number, team_name, team_section,
    result, point_value, points, answer_revealed, revealed_at, actor)
  values (p_request_id, q.id, (select name from public.r2_topics where id = q.topic_id), q.question_text, t.id, t.team_number, t.team_name, t.section,
    p_result, q.points, v_pts, g.answer_revealed, g.revealed_at, auth.uid())
  returning id into v_id;
  update public.r2_questions set used = true, updated_at = now() where id = q.id;
  perform public._r2_idle();
  update public.r2_game set last_result_id = v_id where id = 1;
  return jsonb_build_object('duplicate_request', false, 'result_id', v_id, 'result', p_result, 'team_id', t.id, 'points', v_pts);
end $$;

-- Close an open question without points (e.g. nobody answered in time). Marks it used.
create or replace function public.r2_close_question(p_request_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r2_game; q public.r2_questions; r public.r2_results; v_id bigint;
begin
  perform public._require_organizer();
  if p_request_id is null then perform public._err('VALIDATION', 'A request id is required.'); end if;
  g := public._r2_game_lock();
  select * into r from public.r2_results where request_id = p_request_id;
  if found then return jsonb_build_object('duplicate_request', true, 'result_id', r.id, 'result', r.result, 'points', r.points); end if;
  select * into q from public.r2_questions where id = p_question_id for update;
  if not found then perform public._err('TRIVIA_NOT_FOUND', 'Question not found.'); end if;
  if q.used then perform public._err('TRIVIA_QUESTION_USED', 'This question has already been scored.'); end if;
  if g.phase <> 'revealed' or g.question_id is distinct from p_question_id then
    perform public._err('TRIVIA_NOT_REVEALED', 'Only a revealed question can be closed without points. Use Cancel instead.');
  end if;
  insert into public.r2_results (request_id, question_id, topic_name, question_text, result, point_value, points, answer_revealed, revealed_at, actor)
  values (p_request_id, q.id, (select name from public.r2_topics where id = q.topic_id), q.question_text, 'no_score', q.points, 0,
    g.answer_revealed, g.revealed_at, auth.uid())
  returning id into v_id;
  update public.r2_questions set used = true, updated_at = now() where id = q.id;
  perform public._r2_idle();
  update public.r2_game set last_result_id = v_id where id = 1;
  return jsonb_build_object('duplicate_request', false, 'result_id', v_id, 'result', 'no_score', 'points', 0);
end $$;

-- Rehearsal reset: voids every result (kept for audit), makes all questions available again.
create or replace function public.r2_reset_results(p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_reason text := public._clean(p_reason); n integer;
begin
  perform public._require_organizer();
  if v_reason is null then perform public._err('REASON_REQUIRED', 'A reason is required to reset Round 2 results.'); end if;
  perform public._r2_game_lock();
  update public.r2_results set voided_at = now(), void_reason = v_reason where voided_at is null;
  get diagnostics n = row_count;
  update public.r2_questions set used = false, updated_at = now() where used;
  perform public._r2_idle();
  update public.r2_game set last_result_id = null where id = 1;
  return jsonb_build_object('voided', n);
end $$;

-- ===========================================================================
-- Projector board: no answer before the host reveals it; no question text before Reveal Question.
-- ===========================================================================
create or replace function public.r2_board() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare g public.r2_game; st public.r2_settings; q public.r2_questions;
begin
  perform public._require_organizer();
  select * into g from public.r2_game where id = 1;
  select * into st from public.r2_settings where id = 1;
  if g.question_id is not null then select * into q from public.r2_questions where id = g.question_id; end if;
  return jsonb_build_object(
    'server_now', now(),
    'settings', jsonb_build_object('timer_seconds', coalesce(st.timer_seconds, 18), 'wrong_penalty_percent', coalesce(st.wrong_penalty_percent, 50)),
    'topics', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'questions', coalesce((
        select jsonb_agg(jsonb_build_object('id', x.id, 'points', x.points, 'used', x.used) order by x.points, x.created_at)
        from public.r2_questions x where x.topic_id = t.id), '[]'::jsonb)) order by t.position, t.created_at)
      from public.r2_topics t), '[]'::jsonb),
    'game', jsonb_build_object(
      'phase', coalesce(g.phase, 'idle'),
      'question_id', g.question_id,
      'topic', (select name from public.r2_topics where id = q.topic_id),
      'points', q.points,
      'question_text', case when g.phase = 'revealed' then q.question_text end,
      'answer_revealed', coalesce(g.answer_revealed, false),
      'answer_text', case when g.phase = 'revealed' and g.answer_revealed then (select answer_text from public.r2_answers where question_id = q.id) end,
      'revealed_at', g.revealed_at),
    'scores', coalesce((
      select jsonb_agg(jsonb_build_object('team_id', tm.id, 'team_number', tm.team_number, 'team_name', tm.team_name, 'section', tm.section,
        'score', coalesce((select sum(r.points) from public.r2_results r where r.team_id = tm.id and r.voided_at is null), 0))
        order by tm.section, tm.team_number)
      from public.r2_teams rt join public.teams tm on tm.id = rt.team_id), '[]'::jsonb),
    'last_result', (
      select jsonb_build_object('id', r.id, 'result', r.result, 'points', r.points, 'point_value', r.point_value, 'topic', r.topic_name,
        'team_name', r.team_name, 'team_number', r.team_number, 'section', r.team_section)
      from public.r2_results r where r.id = g.last_result_id and r.voided_at is null)
  );
end $$;

-- ===========================================================================
-- Security: RLS (organizer read only), Realtime, function permissions
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['r2_settings', 'r2_topics', 'r2_questions', 'r2_answers', 'r2_teams', 'r2_results', 'r2_game'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated, public', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_organizer_read', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.is_organizer()))', t || '_organizer_read', t);
  end loop;
  -- Live board updates for organizer screens. r2_answers is deliberately NOT published.
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['r2_settings', 'r2_topics', 'r2_questions', 'r2_teams', 'r2_results', 'r2_game'] loop
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

-- Organizer RPCs (each checks organizer membership internally). Round 1 list unchanged from migration 6.
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

-- Round 2 organizer RPCs (migration 7).
grant execute on function
  public.r2_save_topic(jsonb), public.r2_delete_topic(uuid), public.r2_save_question(jsonb), public.r2_delete_question(uuid),
  public.r2_set_teams(uuid[]), public.r2_update_settings(jsonb), public.r2_select_question(uuid), public.r2_cancel_selection(),
  public.r2_reveal_question(uuid), public.r2_reveal_answer(uuid), public.r2_score_question(uuid, uuid, uuid, text),
  public.r2_close_question(uuid, uuid), public.r2_reset_results(text), public.r2_board()
to authenticated;

-- Registration desk RPCs (each checks registration staff OR organizer internally).
grant execute on function
  public.registration_access(), public.is_registration_staff(), public.reg_overview(), public.reg_save_team(jsonb)
to authenticated;

-- Participant RPCs: callable without an account; authorized by join code / team PIN / device token.
grant execute on function
  public.join_lookup(text), public.join_team(text, integer, text, text),
  public.register_team(text, text, text, text, text, text), public.participant_state(text, integer),
  public.participant_start(text), public.participant_submit(text, uuid, uuid, text), public.participant_finish(text),
  public.participant_leave(text)
to anon, authenticated;

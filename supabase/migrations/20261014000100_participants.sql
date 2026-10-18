-- BRAINFREZE — COLD START · participant joining (migration 4 of 4)
-- Adds: quiz details + question selection, draft/publish lifecycle, six-digit
-- join codes, team PINs, participant device sessions, join rate limiting and
-- participant answer submission. Run AFTER the three 20261013* migrations.
-- Re-runnable. If you ever re-run an earlier migration, re-run this one too
-- (its grant section restores the full function permission set).
--
-- Participant security model
--   * Participants never get a Supabase account and never get table access.
--   * They call six SECURITY DEFINER functions as the `anon` role.
--   * join_team / register_team return a random 256-bit device token; only its
--     SHA-256 hash is stored. Every participant call is authorized by that token,
--     which is bound to ONE team in ONE quiz session.
--   * Responses never contain answer keys, explanations, results or points
--     (except the team's own final score after the organizer reveals results).

-- ===========================================================================
-- Schema
-- ===========================================================================
alter table public.quiz_sessions add column if not exists description text;
alter table public.quiz_sessions add column if not exists question_ids uuid[];          -- null = whole bank
alter table public.quiz_sessions add column if not exists published_at timestamptz;
alter table public.quiz_sessions add column if not exists join_code text;
alter table public.quiz_sessions add column if not exists join_code_active boolean not null default false;
alter table public.quiz_sessions add column if not exists registration_open boolean not null default false;
alter table public.quiz_sessions add column if not exists self_registration boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'quiz_sessions_description_ck') then
    alter table public.quiz_sessions add constraint quiz_sessions_description_ck check (description is null or char_length(description) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quiz_sessions_join_code_ck') then
    alter table public.quiz_sessions add constraint quiz_sessions_join_code_ck check (join_code is null or join_code ~ '^[0-9]{6}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quiz_sessions_join_active_ck') then
    alter table public.quiz_sessions add constraint quiz_sessions_join_active_ck
      check (not join_code_active or (join_code is not null and published_at is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quiz_sessions_registration_ck') then
    alter table public.quiz_sessions add constraint quiz_sessions_registration_ck check (not registration_open or join_code_active);
  end if;
end $$;
-- A code is unique among joinable quizzes (enforced by the database, not the browser).
create unique index if not exists quiz_sessions_active_join_code on public.quiz_sessions (join_code) where join_code_active;

alter table public.teams add column if not exists self_registered boolean not null default false;
alter table public.team_answers add column if not exists source text not null default 'organizer';
alter table public.score_events add column if not exists source text not null default 'organizer';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'team_answers_source_ck') then
    alter table public.team_answers add constraint team_answers_source_ck check (source in ('organizer', 'participant'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'score_events_source_ck') then
    alter table public.score_events add constraint score_events_source_ck check (source in ('organizer', 'participant'));
  end if;
end $$;

-- Team PINs (private: organizer-readable only, like answer keys).
create table if not exists public.team_credentials (
  team_id    uuid primary key references public.teams (id) on delete cascade,
  pin        text not null check (pin ~ '^[A-HJ-NP-Z2-9]{6}$'),
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

-- One row per joined device. token_hash = sha256(token); the token itself is never stored.
create table if not exists public.participant_sessions (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.quiz_sessions (id) on delete cascade,
  team_id        uuid not null references public.teams (id) on delete cascade,
  token_hash     text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  device_label   text check (device_label is null or char_length(device_label) <= 80),
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  revoked_reason text check (revoked_reason is null or char_length(revoked_reason) <= 200)
);
create unique index if not exists participant_sessions_one_active on public.participant_sessions (session_id, team_id) where revoked_at is null;
create index if not exists participant_sessions_session_idx on public.participant_sessions (session_id);

-- Failed join attempts for rate limiting (client key = sha256 of client IP header).
create table if not exists public.join_attempts (
  id         bigint generated always as identity primary key,
  client_key text not null,
  kind       text not null check (kind in ('code', 'pin', 'register')),
  ok         boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists join_attempts_key_idx on public.join_attempts (client_key, created_at);
create index if not exists join_attempts_time_idx on public.join_attempts (created_at);

-- Codes that were replaced; never handed out again so a stale code cannot join a different quiz.
create table if not exists public.retired_join_codes (
  code       text primary key check (code ~ '^[0-9]{6}$'),
  retired_at timestamptz not null default now()
);

-- ===========================================================================
-- Random helpers (CSPRNG: gen_random_uuid() uses pg_strong_random)
-- ===========================================================================
-- First 12 hex chars of a v4 UUID are fully random (version/variant bits come later).
create or replace function public._random_bytes_hex(p_bytes integer) returns text
language sql volatile set search_path = '' as $$
  select left(string_agg(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), ''), p_bytes * 2)
  from generate_series(1, ceil(p_bytes / 6.0)::int);
$$;

-- Uniform 6-digit code via rejection sampling (no modulo bias).
create or replace function public._random_join_code() returns text
language plpgsql volatile set search_path = '' as $$
declare v bigint;
begin
  loop
    v := ('x' || public._random_bytes_hex(4))::bit(32)::bigint;
    if v < 4294000000 then return lpad((v % 1000000)::text, 6, '0'); end if;
  end loop;
end $$;

-- 6 characters from a 31-symbol alphabet without 0/O/1/I/L (≈ 8.9 × 10^8 PINs).
create or replace function public._random_pin() returns text
language plpgsql volatile set search_path = '' as $$
declare alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; v_pin text := ''; b integer; hex text;
begin
  while char_length(v_pin) < 6 loop
    hex := public._random_bytes_hex(6);
    for i in 0..5 loop
      b := ('x' || substr(hex, i * 2 + 1, 2))::bit(8)::int;
      if b < 248 and char_length(v_pin) < 6 then v_pin := v_pin || substr(alphabet, (b % 31) + 1, 1); end if;
    end loop;
  end loop;
  return v_pin;
end $$;

create or replace function public._sha256_hex(p text) returns text
language sql immutable set search_path = '' as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex'); $$;

-- Every team gets a PIN automatically.
create or replace function public.tg_team_credentials() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.team_credentials (team_id, pin) values (new.id, public._random_pin()) on conflict (team_id) do nothing;
  return new;
end $$;
drop trigger if exists teams_credentials on public.teams;
create trigger teams_credentials after insert on public.teams for each row execute function public.tg_team_credentials();
insert into public.team_credentials (team_id, pin)
select t.id, public._random_pin() from public.teams t
where not exists (select 1 from public.team_credentials c where c.team_id = t.id);

-- Audit trigger now also protects the new `source` column.
create or replace function public.tg_score_events_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception using errcode = 'P0001', message = 'AUDIT_IMMUTABLE: Audit history cannot be deleted.';
  end if;
  if new.id <> old.id or new.session_id <> old.session_id or new.action <> old.action
     or new.request_id is distinct from old.request_id or new.source is distinct from old.source
     or new.prev_selected is distinct from old.prev_selected or new.prev_points is distinct from old.prev_points
     or new.new_selected is distinct from old.new_selected or new.new_points is distinct from old.new_points
     or new.reason is distinct from old.reason or new.created_at <> old.created_at
     or (old.undone and not new.undone) then
    raise exception using errcode = 'P0001', message = 'AUDIT_IMMUTABLE: Audit history is append-only.';
  end if;
  return new;
end $$;

-- ===========================================================================
-- Session question selection
-- ===========================================================================
-- The quiz's questions in projector order; idx is the 0-based current_index.
create or replace function public._session_questions(s public.quiz_sessions)
returns table (id uuid, idx integer)
language sql stable security definer set search_path = '' as $$
  select q.id, (row_number() over (order by q.position) - 1)::int
  from public.questions q
  where s.question_ids is null or q.id = any (s.question_ids)
  order by q.position;
$$;

create or replace function public._session_question_count(s public.quiz_sessions) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public._session_questions(s);
$$;

create or replace function public._renumber_questions() returns void
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  with o as (select id, row_number() over (order by position, created_at) as rn from public.questions)
  update public.questions q set position = o.rn from o where q.id = o.id and q.position <> o.rn;
  update public.quiz_sessions x set
    question_ids = case when x.question_ids is null then null
      else array(select y from unnest(x.question_ids) y where exists (select 1 from public.questions q where q.id = y)) end,
    completed_question_ids = array(select y from unnest(x.completed_question_ids) y where exists (select 1 from public.questions q where q.id = y))
  where x.is_current;
  select * into s from public.quiz_sessions where is_current;
  if found then
    update public.quiz_sessions set current_index = greatest(0, least(current_index, public._session_question_count(s) - 1)) where id = s.id;
  end if;
end $$;

-- Standings count only the quiz's selected questions.
create or replace function public._standings(p_session uuid)
returns table (team_id uuid, team_number integer, team_name text, is_demo boolean, points numeric,
               correct integer, incorrect integer, unanswered integer, recorded integer, tiebreak numeric, rank integer)
language sql stable security definer set search_path = '' as $$
  with st as (select * from public.quiz_settings where session_id = p_session),
  qn as (select public._session_question_count(x) as n from public.quiz_sessions x where x.id = p_session),
  agg as (
    select t.id, t.team_number, t.team_name, t.is_demo,
      coalesce(sum(a.points), 0) as rec_points,
      count(a.id) filter (where a.result = 'correct')::int as correct,
      count(a.id) filter (where a.result = 'incorrect')::int as incorrect,
      count(a.id)::int as recorded
    from public.teams t
    left join public.team_answers a on a.team_id = t.id and a.session_id = p_session
    group by t.id
  ),
  calc as (
    select agg.*,
      round(agg.rec_points + greatest(0, qn.n - agg.recorded) * st.marks_unanswered, 2) as pts,
      greatest(0, qn.n - agg.correct - agg.incorrect) as unans,
      case when st.accuracy_tiebreak then agg.incorrect else 0 end as inc_key,
      tb.score as tb
    from agg cross join qn cross join st
    left join public.tiebreak_results tb on tb.session_id = p_session and tb.team_id = agg.id
  ),
  grp as (
    select calc.*,
      case when count(*) over w > 1 and bool_and(calc.tb is not null) over w then calc.tb end as eff_tb
    from calc
    window w as (partition by calc.pts, calc.inc_key)
  )
  select g.id, g.team_number, g.team_name, g.is_demo, g.pts, g.correct, g.incorrect, g.unans, g.recorded, g.tb,
    (rank() over (order by g.pts desc, g.inc_key asc, g.eff_tb desc nulls last))::int
  from grp g
  order by 11, g.team_number;
$$;

-- Readiness shared by publish_quiz and start_quiz.
create or replace function public._assert_quiz_ready(s public.quiz_sessions, p_need_teams boolean) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_need_teams and not exists (select 1 from public.teams) then perform public._err('QUIZ_NOT_READY', 'Add at least one team.'); end if;
  if public._session_question_count(s) = 0 then perform public._err('QUIZ_NOT_READY', 'Select at least one question for this quiz.'); end if;
  if exists (select 1 from public._session_questions(s) sq where not exists (select 1 from public.question_keys k where k.question_id = sq.id)) then
    perform public._err('QUIZ_NOT_READY', 'Every question needs an answer key.');
  end if;
end $$;

-- ===========================================================================
-- Updated organizer functions (same signatures as before)
-- ===========================================================================
create or replace function public.start_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status <> 'setup' then perform public._err('INVALID_STATE', 'The quiz has already started.'); end if;
  perform public._assert_quiz_ready(s, not s.self_registration);
  if not exists (select 1 from public.teams) then perform public._err('QUIZ_NOT_READY', 'No teams have registered yet.'); end if;
  perform public._settings(s.id);
  update public.quiz_sessions set status = 'running', started_at = now(), timer_started_at = now(), elapsed_ms = 0,
    current_index = 0, projector_view = 'question'
  where id = s.id;
  return jsonb_build_object('ok', true, 'server_now', now());
end $$;

create or replace function public.go_to_question(p_index integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if p_index is null or p_index < 0 or p_index >= public._session_question_count(s) then
    perform public._err('VALIDATION', 'Question index out of range.');
  end if;
  update public.quiz_sessions set current_index = p_index where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

-- Ending the quiz also expires the join code and closes registration.
create or replace function public.end_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; st public.quiz_settings;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status not in ('running', 'paused') then perform public._err('INVALID_STATE', 'The quiz is not running.'); end if;
  st := public._settings(s.id);
  update public.quiz_sessions set status = 'ended', timer_started_at = null, ended_at = now(),
    elapsed_ms = least(st.duration_seconds::bigint * 1000, public._elapsed_ms(s)),
    join_code_active = false, registration_open = false
  where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

-- A new session is a draft copy (title, description, questions, settings); the old code expires.
create or replace function public.new_session() returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; st public.quiz_settings; v_id uuid;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  st := public._settings(s.id);
  update public.quiz_sessions set is_current = false, join_code_active = false, registration_open = false where id = s.id;
  update public.participant_sessions set revoked_at = now(), revoked_reason = 'Quiz session archived'
  where session_id = s.id and revoked_at is null;
  insert into public.quiz_sessions (is_current, name, description, question_ids, self_registration)
  values (true, s.name, s.description, s.question_ids, s.self_registration) returning id into v_id;
  insert into public.quiz_settings (session_id, duration_seconds, marks_correct, marks_incorrect, marks_unanswered, qualify_count, accuracy_tiebreak)
  values (v_id, st.duration_seconds, st.marks_correct, st.marks_incorrect, st.marks_unanswered, st.qualify_count, st.accuracy_tiebreak);
  return v_id;
end $$;

-- Core scoring shared by organizer recording and participant submission.
create or replace function public._apply_answer(
  s public.quiz_sessions, st public.quiz_settings, t public.teams, q public.questions, sel text,
  p_request_id uuid, p_correction boolean, p_reason text, p_source text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ex public.team_answers; has_ex boolean; k text; r record; v_action text; v_id bigint;
begin
  select correct_option into k from public.question_keys where question_id = q.id;
  select * into r from public._evaluate(sel, k, coalesce(q.marks_correct, st.marks_correct), coalesce(q.marks_incorrect, st.marks_incorrect), st.marks_unanswered);
  select * into ex from public.team_answers where session_id = s.id and team_id = t.id and question_id = q.id for update;
  has_ex := found;
  if has_ex then
    if not coalesce(p_correction, false) then perform public._err('ALREADY_RECORDED'); end if;
    if public._clean(p_reason) is null then perform public._err('REASON_REQUIRED', 'A reason is required to correct a recorded answer.'); end if;
    if ex.selected_option is not distinct from sel then perform public._err('NO_CHANGE'); end if;
    update public.team_answers set selected_option = sel, result = r.result, points = r.points, recorded_by = auth.uid(), source = p_source where id = ex.id;
    v_action := 'correction';
  else
    insert into public.team_answers (session_id, team_id, question_id, selected_option, result, points, recorded_by, source)
    values (s.id, t.id, q.id, sel, r.result, r.points, auth.uid(), p_source);
    v_action := 'record';
  end if;
  insert into public.score_events (session_id, request_id, action, team_id, team_number, question_id, question_position,
    prev_selected, prev_result, prev_points, new_selected, new_result, new_points, reason, actor, source)
  values (s.id, p_request_id, v_action, t.id, t.team_number, q.id, q.position,
    case when has_ex then ex.selected_option end, case when has_ex then ex.result end, case when has_ex then ex.points end,
    sel, r.result, r.points, case when has_ex then public._clean(p_reason) end, auth.uid(), p_source)
  returning id into v_id;
  return jsonb_build_object('duplicate_request', false, 'event_id', v_id, 'action', v_action, 'result', r.result, 'points', r.points, 'selected', sel);
end $$;

create or replace function public.record_answer(
  p_request_id uuid, p_team_id uuid, p_question_id uuid, p_selected text,
  p_correction boolean default false, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; st public.quiz_settings; t public.teams; q public.questions; ev public.score_events; sel text;
begin
  perform public._require_organizer();
  if p_request_id is null then perform public._err('VALIDATION', 'request_id is required.'); end if;
  s := public._lock_current_session(); -- serializes all scoring for the session
  select * into ev from public.score_events where request_id = p_request_id;
  if found then
    return jsonb_build_object('duplicate_request', true, 'event_id', ev.id, 'result', ev.new_result, 'points', ev.new_points, 'selected', ev.new_selected);
  end if;
  st := public._settings(s.id);
  perform public._assert_scoring_open(s, st);
  select * into t from public.teams where id = p_team_id;
  if not found then perform public._err('TEAM_NOT_FOUND'); end if;
  select * into q from public.questions where id = p_question_id;
  if not found then perform public._err('QUESTION_NOT_FOUND'); end if;
  if not exists (select 1 from public._session_questions(s) sq where sq.id = q.id) then
    perform public._err('QUESTION_NOT_IN_QUIZ');
  end if;
  sel := public._normalize_option(p_selected);
  return public._apply_answer(s, st, t, q, sel, p_request_id, p_correction, p_reason, 'organizer');
end $$;

-- ===========================================================================
-- Organizer: quiz details, publishing and join codes
-- ===========================================================================
create or replace function public._issue_join_code(p_session uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare c text; tries integer := 0;
begin
  loop
    tries := tries + 1;
    if tries > 60 then perform public._err('CODE_GENERATION_FAILED', 'Could not generate a unique join code. Try again.'); end if;
    c := public._random_join_code();
    -- Never reuse any code a session has ever had, so a stale code can't reach a different quiz.
    continue when exists (select 1 from public.quiz_sessions where join_code = c)
               or exists (select 1 from public.retired_join_codes where code = c);
    begin
      update public.quiz_sessions set join_code = c, join_code_active = true where id = p_session;
      return c;
    exception when unique_violation then
      null; -- a concurrent publisher took this code: try another
    end;
  end loop;
end $$;

create or replace function public._retire_join_code(s public.quiz_sessions) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if s.join_code is not null then
    insert into public.retired_join_codes (code) values (s.join_code) on conflict (code) do nothing;
  end if;
end $$;

create or replace function public.update_quiz_details(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; v_name text; v_desc text; v_ids uuid[]; v_self boolean;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  v_name := coalesce(public._clean(p->>'name'), s.name);
  if char_length(v_name) > 80 then perform public._err('VALIDATION', 'Quiz title must be 80 characters or fewer.'); end if;
  v_desc := case when p ? 'description' then public._clean(p->>'description') else s.description end;
  if v_desc is not null and char_length(v_desc) > 500 then perform public._err('VALIDATION', 'Description must be 500 characters or fewer.'); end if;
  v_self := coalesce((p->>'self_registration')::boolean, s.self_registration);
  if p ? 'question_ids' then
    if s.status <> 'setup' then perform public._err('INVALID_STATE', 'Questions can only be changed before the quiz starts.'); end if;
    if jsonb_typeof(p->'question_ids') = 'null' then
      v_ids := null;
    elsif jsonb_typeof(p->'question_ids') = 'array' then
      v_ids := array(select distinct (jsonb_array_elements_text(p->'question_ids'))::uuid);
      if cardinality(v_ids) = 0 then perform public._err('VALIDATION', 'Select at least one question.'); end if;
      if exists (select 1 from unnest(v_ids) x where not exists (select 1 from public.questions q where q.id = x)) then
        perform public._err('VALIDATION', 'A selected question no longer exists.');
      end if;
    else
      perform public._err('VALIDATION', 'question_ids must be an array or null.');
    end if;
  else
    v_ids := s.question_ids;
  end if;
  update public.quiz_sessions set name = v_name, description = v_desc, question_ids = v_ids,
    self_registration = v_self
  where id = s.id;
  perform public._renumber_questions();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.publish_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; c text;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status in ('ended', 'finalized') then perform public._err('INVALID_STATE', 'An ended quiz cannot be published. Start a new quiz.'); end if;
  if s.join_code_active then return jsonb_build_object('ok', true, 'join_code', s.join_code); end if;
  perform public._assert_quiz_ready(s, not s.self_registration);
  update public.quiz_sessions set published_at = coalesce(published_at, now()) where id = s.id;
  c := public._issue_join_code(s.id);
  update public.quiz_sessions set registration_open = true where id = s.id;
  return jsonb_build_object('ok', true, 'join_code', c);
end $$;

create or replace function public.unpublish_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status <> 'setup' then perform public._err('INVALID_STATE', 'A started quiz cannot be returned to draft.'); end if;
  perform public._retire_join_code(s);
  update public.quiz_sessions set join_code_active = false, registration_open = false, published_at = null where id = s.id;
  update public.participant_sessions set revoked_at = now(), revoked_reason = 'Quiz returned to draft'
  where session_id = s.id and revoked_at is null;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.regenerate_join_code() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; c text;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.published_at is null or s.status in ('ended', 'finalized') then
    perform public._err('INVALID_STATE', 'Only a published quiz that has not ended has a join code.');
  end if;
  perform public._retire_join_code(s);
  update public.quiz_sessions set join_code_active = false, registration_open = false where id = s.id;
  c := public._issue_join_code(s.id);
  update public.quiz_sessions set registration_open = s.registration_open where id = s.id;
  return jsonb_build_object('ok', true, 'join_code', c);
end $$;

create or replace function public.set_registration(p_open boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if not s.join_code_active then perform public._err('INVALID_STATE', 'Publish the quiz (or regenerate its code) first.'); end if;
  update public.quiz_sessions set registration_open = coalesce(p_open, false) where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.revoke_participant(p_team_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; n integer;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  update public.participant_sessions set revoked_at = now(), revoked_reason = 'Disconnected by organizer'
  where session_id = s.id and team_id = p_team_id and revoked_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'revoked', n);
end $$;

create or replace function public.rotate_team_pin(p_team_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_pin text := public._random_pin();
begin
  perform public._require_organizer();
  if not exists (select 1 from public.teams where id = p_team_id) then perform public._err('TEAM_NOT_FOUND'); end if;
  insert into public.team_credentials (team_id, pin, rotated_at) values (p_team_id, v_pin, now())
  on conflict (team_id) do update set pin = excluded.pin, rotated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- ===========================================================================
-- Participant functions (anon). Expected failures RETURN {ok:false,error}
-- (so failed-attempt logging is committed); they never raise internal errors.
-- ===========================================================================
create or replace function public._client_key() returns text
language plpgsql stable set search_path = '' as $$
declare h json; v text;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then h := null;
  end;
  v := coalesce(h->>'cf-connecting-ip', h->>'x-real-ip', split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1));
  return public._sha256_hex(coalesce(nullif(btrim(v), ''), 'unknown'));
end $$;

create or replace function public._join_rate_limited(p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select count(*) from public.join_attempts where client_key = p_key and not ok and created_at > now() - interval '10 minutes') >= 30
      or (select count(*) from public.join_attempts where not ok and created_at > now() - interval '1 minute') >= 600;
$$;

create or replace function public._log_join_attempt(p_key text, p_kind text, p_ok boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.join_attempts (client_key, kind, ok) values (p_key, p_kind, p_ok);
  if random() < 0.02 then delete from public.join_attempts where created_at < now() - interval '1 day'; end if;
end $$;

create or replace function public._quiz_by_code(p_code text) returns public.quiz_sessions
language plpgsql stable security definer set search_path = '' as $$
declare s public.quiz_sessions; c text := regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g');
begin
  if c !~ '^[0-9]{6}$' then return null; end if;
  select * into s from public.quiz_sessions
  where join_code = c and join_code_active and is_current and published_at is not null and status not in ('ended', 'finalized');
  return s;
end $$;

create or replace function public._participant_session(p_token text) returns public.participant_sessions
language plpgsql stable security definer set search_path = '' as $$
declare ps public.participant_sessions;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  select p.* into ps from public.participant_sessions p
  join public.quiz_sessions s on s.id = p.session_id and s.is_current
  where p.token_hash = public._sha256_hex(p_token) and p.revoked_at is null and p.expires_at > now();
  return ps;
end $$;

create or replace function public._team_public(t public.teams) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('team_number', t.team_number, 'team_name', t.team_name,
    'participant_1', t.participant_1, 'participant_2', t.participant_2);
$$;

create or replace function public._open_participant_session(s public.quiz_sessions, t public.teams, p_device text) returns text
language plpgsql security definer set search_path = '' as $$
declare tok text := public._random_bytes_hex(32);
begin
  insert into public.participant_sessions (session_id, team_id, token_hash, device_label, expires_at)
  values (s.id, t.id, public._sha256_hex(tok), left(public._clean(p_device), 80), now() + interval '12 hours');
  return tok;
end $$;

create or replace function public.join_lookup(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text := public._client_key(); s public.quiz_sessions;
begin
  if public._join_rate_limited(k) then return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED'); end if;
  s := public._quiz_by_code(p_code);
  if s.id is null then
    perform public._log_join_attempt(k, 'code', false);
    return jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  end if;
  return jsonb_build_object('ok', true, 'quiz', jsonb_build_object(
    'title', s.name, 'description', s.description, 'status', s.status,
    'registration_open', s.registration_open, 'self_registration', s.self_registration and s.registration_open));
end $$;

create or replace function public.join_team(p_code text, p_team_number integer, p_pin text, p_device_label text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text := public._client_key(); s public.quiz_sessions; t public.teams; v_pin text; ps public.participant_sessions; tok text;
begin
  if public._join_rate_limited(k) then return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED'); end if;
  s := public._quiz_by_code(p_code);
  if s.id is null then
    perform public._log_join_attempt(k, 'code', false);
    return jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  end if;
  perform 1 from public.quiz_sessions where id = s.id for update; -- serialize joins
  select * into t from public.teams where team_number = p_team_number;
  select pin into v_pin from public.team_credentials where team_id = t.id;
  -- Same error for unknown team and wrong PIN (no team enumeration).
  if t.id is null or v_pin is null or v_pin <> upper(btrim(coalesce(p_pin, ''))) then
    perform public._log_join_attempt(k, 'pin', false);
    return jsonb_build_object('ok', false, 'error', 'INVALID_TEAM_OR_PIN');
  end if;
  if not s.registration_open
     and not exists (select 1 from public.participant_sessions where session_id = s.id and team_id = t.id) then
    return jsonb_build_object('ok', false, 'error', 'REGISTRATION_CLOSED');
  end if;
  select * into ps from public.participant_sessions
  where session_id = s.id and team_id = t.id and revoked_at is null for update;
  if found then
    if ps.last_seen_at > now() - interval '45 seconds' and ps.expires_at > now() then
      return jsonb_build_object('ok', false, 'error', 'TEAM_ALREADY_CONNECTED');
    end if;
    update public.participant_sessions set revoked_at = now(), revoked_reason = 'Replaced by a new device sign-in' where id = ps.id;
  end if;
  tok := public._open_participant_session(s, t, p_device_label);
  return jsonb_build_object('ok', true, 'token', tok, 'team', public._team_public(t), 'quiz_title', s.name);
end $$;

create or replace function public.register_team(p_code text, p_team_name text, p_participant_1 text, p_participant_2 text, p_device_label text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k text := public._client_key(); s public.quiz_sessions; t public.teams; tok text; v_num integer;
  v_name text := public._clean(p_team_name); v_p1 text := public._clean(p_participant_1); v_p2 text := public._clean(p_participant_2);
begin
  if public._join_rate_limited(k) then return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED'); end if;
  s := public._quiz_by_code(p_code);
  if s.id is null then
    perform public._log_join_attempt(k, 'code', false);
    return jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  end if;
  perform 1 from public.quiz_sessions where id = s.id for update;
  if not (s.registration_open and s.self_registration) then return jsonb_build_object('ok', false, 'error', 'SELF_REGISTRATION_CLOSED'); end if;
  if v_name is null or char_length(v_name) > 80 or v_p1 is null or v_p2 is null or char_length(v_p1) > 80 or char_length(v_p2) > 80 then
    return jsonb_build_object('ok', false, 'error', 'VALIDATION', 'message', 'Team name and both participant names are required (max 80 characters each).');
  end if;
  if exists (select 1 from public.teams where lower(team_name) = lower(v_name)) then
    perform public._log_join_attempt(k, 'register', false);
    return jsonb_build_object('ok', false, 'error', 'TEAM_NAME_TAKEN');
  end if;
  if (select count(*) from public.teams) >= 50 then return jsonb_build_object('ok', false, 'error', 'TEAM_CAPACITY'); end if;
  select min(n) into v_num from generate_series(1, 999) n where not exists (select 1 from public.teams x where x.team_number = n);
  insert into public.teams (team_number, team_name, participant_1, participant_2, self_registered)
  values (v_num, v_name, v_p1, v_p2, true) returning * into t;
  tok := public._open_participant_session(s, t, p_device_label);
  return jsonb_build_object('ok', true, 'token', tok, 'team', public._team_public(t), 'quiz_title', s.name,
    'pin', (select pin from public.team_credentials where team_id = t.id));
end $$;

create or replace function public.participant_state(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ps public.participant_sessions; s public.quiz_sessions; st public.quiz_settings; t public.teams; q public.questions;
  ans public.team_answers; total integer; res jsonb; expired boolean; r record; revoked public.participant_sessions;
begin
  ps := public._participant_session(p_token);
  if ps.id is null then
    if p_token ~ '^[0-9a-f]{64}$' then
      select * into revoked from public.participant_sessions where token_hash = public._sha256_hex(p_token);
      if revoked.revoked_at is not null then
        return jsonb_build_object('ok', false, 'error', 'SESSION_REVOKED', 'message', revoked.revoked_reason);
      end if;
    end if;
    return jsonb_build_object('ok', false, 'error', 'SESSION_INVALID');
  end if;
  if ps.last_seen_at < now() - interval '10 seconds' then
    update public.participant_sessions set last_seen_at = now() where id = ps.id;
  end if;
  select * into s from public.quiz_sessions where id = ps.session_id;
  select * into t from public.teams where id = ps.team_id;
  st := public._settings(s.id);
  total := public._session_question_count(s);
  expired := s.status in ('running', 'paused') and public._elapsed_ms(s) >= st.duration_seconds::bigint * 1000;
  res := jsonb_build_object(
    'ok', true, 'server_now', now(),
    'team', public._team_public(t),
    'quiz', jsonb_build_object('title', s.name, 'description', s.description, 'status', s.status,
      'registration_open', s.registration_open, 'total_questions', total, 'results_revealed', s.results_revealed, 'time_up', expired),
    'timer', jsonb_build_object('status', s.status, 'elapsed_ms', s.elapsed_ms, 'timer_started_at', s.timer_started_at,
      'duration_seconds', st.duration_seconds));
  if s.status = 'running' and not expired and total > 0 then
    select x.* into q from public.questions x join public._session_questions(s) sq on sq.id = x.id where sq.idx = s.current_index;
    select * into ans from public.team_answers where session_id = s.id and team_id = t.id and question_id = q.id;
    res := res || jsonb_build_object(
      'question', jsonb_build_object('id', q.id, 'number', s.current_index + 1, 'question_text', q.question_text,
        'option_a', q.option_a, 'option_b', q.option_b, 'option_c', q.option_c, 'option_d', q.option_d, 'image_url', q.image_url),
      'question_closed', q.id = any (s.completed_question_ids),
      'my_answer', case when ans.id is null then null
        else jsonb_build_object('selected', ans.selected_option, 'submitted_at', ans.created_at, 'source', ans.source) end);
  end if;
  if s.status = 'finalized' and s.results_revealed then
    select x.rank, x.points into r from public._standings(s.id) x where x.team_id = t.id;
    res := res || jsonb_build_object('result', jsonb_build_object('rank', r.rank, 'points', r.points, 'qualified', t.id = any (s.qualifiers)));
  end if;
  return res;
end $$;

create or replace function public.participant_submit(p_token text, p_request_id uuid, p_question_id uuid, p_option text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ps public.participant_sessions; s public.quiz_sessions; st public.quiz_settings; t public.teams; q public.questions;
  ev public.score_events; ex public.team_answers; v_current uuid; sel text := upper(btrim(coalesce(p_option, '')));
begin
  ps := public._participant_session(p_token);
  if ps.id is null then return jsonb_build_object('ok', false, 'error', 'SESSION_INVALID'); end if;
  if p_request_id is null or p_question_id is null then return jsonb_build_object('ok', false, 'error', 'VALIDATION'); end if;
  select * into s from public.quiz_sessions where id = ps.session_id for update; -- same lock as organizer scoring
  -- Idempotent retry: return the original outcome, only to the team that made it.
  select * into ev from public.score_events where request_id = p_request_id;
  if found then
    if ev.team_id = ps.team_id and ev.source = 'participant' then
      return jsonb_build_object('ok', true, 'duplicate_request', true, 'selected', ev.new_selected, 'question_id', ev.question_id);
    end if;
    return jsonb_build_object('ok', false, 'error', 'VALIDATION');
  end if;
  st := public._settings(s.id);
  if s.status <> 'running' then return jsonb_build_object('ok', false, 'error', 'NOT_ACCEPTING'); end if;
  if public._elapsed_ms(s) >= st.duration_seconds::bigint * 1000 then return jsonb_build_object('ok', false, 'error', 'TIME_EXPIRED'); end if;
  select sq.id into v_current from public._session_questions(s) sq where sq.idx = s.current_index;
  if v_current is null or p_question_id <> v_current then return jsonb_build_object('ok', false, 'error', 'NOT_CURRENT_QUESTION'); end if;
  if v_current = any (s.completed_question_ids) then return jsonb_build_object('ok', false, 'error', 'QUESTION_CLOSED'); end if;
  if sel not in ('A', 'B', 'C', 'D') then return jsonb_build_object('ok', false, 'error', 'INVALID_OPTION'); end if;
  select * into ex from public.team_answers where session_id = s.id and team_id = ps.team_id and question_id = v_current;
  if found then
    return jsonb_build_object('ok', false, 'error', 'ALREADY_SUBMITTED', 'selected', ex.selected_option);
  end if;
  select * into t from public.teams where id = ps.team_id;
  select * into q from public.questions where id = v_current;
  perform public._apply_answer(s, st, t, q, sel, p_request_id, false, null, 'participant');
  -- Deliberately no result/points: correctness is never revealed to participants here.
  return jsonb_build_object('ok', true, 'duplicate_request', false, 'selected', sel, 'question_id', v_current, 'submitted_at', now());
end $$;

create or replace function public.participant_leave(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ps public.participant_sessions;
begin
  ps := public._participant_session(p_token);
  if ps.id is null then return jsonb_build_object('ok', true); end if;
  update public.participant_sessions set revoked_at = now(), revoked_reason = 'Signed out on the device' where id = ps.id;
  return jsonb_build_object('ok', true);
end $$;

-- ===========================================================================
-- Backup restore: new columns, team PINs; restored quizzes are never live/published.
-- ===========================================================================
create or replace function public.restore_backup(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_sid uuid; sess jsonb := p->'session'; v_status text;
begin
  perform public._require_organizer();
  if p->>'app' is distinct from 'brainfreze-cold-start' or (p->>'format_version')::int is distinct from 1 then
    perform public._err('INVALID_BACKUP');
  end if;
  if jsonb_typeof(p->'teams') <> 'array' or jsonb_typeof(p->'questions') <> 'array' or jsonb_typeof(sess) <> 'object' then
    perform public._err('INVALID_BACKUP');
  end if;
  perform pg_advisory_xact_lock(hashtext('brainfreze.session'));
  insert into public.retired_join_codes (code) select join_code from public.quiz_sessions where join_code is not null on conflict do nothing;
  delete from public.quiz_sessions where true;
  delete from public.questions where true;
  delete from public.teams where true;

  insert into public.teams (id, team_number, team_name, participant_1, participant_2, is_demo, self_registered, created_at)
  select x.id, x.team_number, x.team_name, x.participant_1, x.participant_2, coalesce(x.is_demo, false), coalesce(x.self_registered, false), coalesce(x.created_at, now())
  from jsonb_to_recordset(p->'teams') as x(id uuid, team_number int, team_name text, participant_1 text, participant_2 text, is_demo boolean, self_registered boolean, created_at timestamptz);
  -- Keep printed PIN slips valid when the backup has them.
  update public.team_credentials c set pin = x.pin
  from jsonb_to_recordset(coalesce(p->'team_credentials', '[]'::jsonb)) as x(team_id uuid, pin text)
  where c.team_id = x.team_id and x.pin ~ '^[A-HJ-NP-Z2-9]{6}$';

  insert into public.questions (id, position, question_text, option_a, option_b, option_c, option_d, image_url, category, marks_correct, marks_incorrect, is_sample, created_at)
  select x.id, row_number() over (order by x.position), x.question_text, x.option_a, x.option_b, x.option_c, x.option_d, x.image_url, x.category,
         x.marks_correct, x.marks_incorrect, coalesce(x.is_sample, false), coalesce(x.created_at, now())
  from jsonb_to_recordset(p->'questions') as x(id uuid, position int, question_text text, option_a text, option_b text, option_c text, option_d text,
       image_url text, category text, marks_correct numeric, marks_incorrect numeric, is_sample boolean, created_at timestamptz);
  insert into public.question_keys (question_id, correct_option, explanation)
  select x.id, upper(x.correct_option), x.explanation from jsonb_to_recordset(p->'questions') as x(id uuid, correct_option text, explanation text);

  v_status := sess->>'status';
  v_sid := (sess->>'id')::uuid;
  insert into public.quiz_sessions (id, name, description, question_ids, self_registration, is_current, status, current_index, completed_question_ids,
    started_at, timer_started_at, elapsed_ms, ended_at, corrections_enabled, projector_view, results_revealed, qualifiers,
    qualifiers_confirmed_at, qualification_note, created_at)
  values (v_sid, coalesce(sess->>'name', 'COLD START'), sess->>'description',
    case when jsonb_typeof(sess->'question_ids') = 'array'
      then array(select y from (select (jsonb_array_elements_text(sess->'question_ids'))::uuid as y) z where exists (select 1 from public.questions q where q.id = z.y)) end,
    coalesce((sess->>'self_registration')::boolean, false), true,
    case when v_status = 'running' then 'paused' else v_status end,
    coalesce((sess->>'current_index')::int, 0),
    coalesce(array(select (jsonb_array_elements_text(sess->'completed_question_ids'))::uuid), '{}'),
    (sess->>'started_at')::timestamptz, null,
    coalesce((sess->>'elapsed_ms')::numeric::bigint, 0), (sess->>'ended_at')::timestamptz,
    coalesce((sess->>'corrections_enabled')::boolean, false),
    case when coalesce(sess->>'projector_view', 'standby') = 'reveal' and not coalesce((sess->>'results_revealed')::boolean, false) then 'standby' else coalesce(sess->>'projector_view', 'standby') end,
    coalesce((sess->>'results_revealed')::boolean, false),
    case when jsonb_typeof(sess->'qualifiers') = 'array' then array(select (jsonb_array_elements_text(sess->'qualifiers'))::uuid) end,
    (sess->>'qualifiers_confirmed_at')::timestamptz, sess->>'qualification_note', coalesce((sess->>'created_at')::timestamptz, now()));

  insert into public.quiz_settings (session_id, duration_seconds, marks_correct, marks_incorrect, marks_unanswered, qualify_count, accuracy_tiebreak)
  select v_sid, coalesce(x.duration_seconds, 1800), coalesce(x.marks_correct, 1), coalesce(x.marks_incorrect, -0.25),
         coalesce(x.marks_unanswered, 0), coalesce(x.qualify_count, 5), coalesce(x.accuracy_tiebreak, true)
  from jsonb_to_record(coalesce(p->'settings', '{}'::jsonb)) as x(duration_seconds int, marks_correct numeric, marks_incorrect numeric,
       marks_unanswered numeric, qualify_count int, accuracy_tiebreak boolean);

  insert into public.team_answers (session_id, team_id, question_id, selected_option, result, points, source, created_at)
  select v_sid, x.team_id, x.question_id, x.selected_option, x.result, x.points, coalesce(x.source, 'organizer'), coalesce(x.created_at, now())
  from jsonb_to_recordset(coalesce(p->'answers', '[]'::jsonb)) as x(session_id uuid, team_id uuid, question_id uuid, selected_option text, result text, points numeric, source text, created_at timestamptz)
  where x.session_id = v_sid;

  insert into public.tiebreak_results (session_id, team_id, score, note)
  select v_sid, x.team_id, x.score, x.note
  from jsonb_to_recordset(coalesce(p->'tiebreaks', '[]'::jsonb)) as x(session_id uuid, team_id uuid, score numeric, note text)
  where x.session_id = v_sid;

  insert into public.score_events (id, session_id, request_id, action, team_id, team_number, question_id, question_position,
    prev_selected, prev_result, prev_points, new_selected, new_result, new_points, undone, undo_of, reason, actor, source, created_at)
  select x.id, v_sid, x.request_id, x.action,
    case when exists (select 1 from public.teams t where t.id = x.team_id) then x.team_id end, x.team_number,
    case when exists (select 1 from public.questions q where q.id = x.question_id) then x.question_id end, x.question_position,
    x.prev_selected, x.prev_result, x.prev_points, x.new_selected, x.new_result, x.new_points, coalesce(x.undone, false), x.undo_of,
    x.reason, null, coalesce(x.source, 'organizer'), coalesce(x.created_at, now())
  from jsonb_to_recordset(coalesce(p->'events', '[]'::jsonb)) as x(id bigint, session_id uuid, request_id uuid, action text, team_id uuid, team_number int,
       question_id uuid, question_position int, prev_selected text, prev_result text, prev_points numeric, new_selected text, new_result text,
       new_points numeric, undone boolean, undo_of bigint, reason text, source text, created_at timestamptz)
  where x.session_id = v_sid
  order by x.id;
  perform setval(pg_get_serial_sequence('public.score_events', 'id'), greatest(coalesce((select max(id) from public.score_events), 0), 1));

  insert into public.score_events (session_id, action, reason, actor)
  values (v_sid, 'restore', 'Restored backup exported ' || coalesce(p->>'exported_at', 'at unknown time'), auth.uid());
  perform public._renumber_questions();
  return jsonb_build_object('ok', true);
end $$;

-- ===========================================================================
-- Security: RLS, grants, function permissions
-- ===========================================================================
alter table public.team_credentials     enable row level security;
alter table public.participant_sessions enable row level security;
alter table public.join_attempts        enable row level security;
alter table public.retired_join_codes   enable row level security;

revoke all on public.team_credentials, public.participant_sessions, public.join_attempts, public.retired_join_codes
  from anon, authenticated, public;
-- Organizers may read PINs and device status; no other access for anyone.
grant select on public.team_credentials, public.participant_sessions to authenticated;
drop policy if exists team_credentials_organizer_read on public.team_credentials;
create policy team_credentials_organizer_read on public.team_credentials for select to authenticated using ((select public.is_organizer()));
drop policy if exists participant_sessions_organizer_read on public.participant_sessions;
create policy participant_sessions_organizer_read on public.participant_sessions for select to authenticated using ((select public.is_organizer()));
-- join_attempts / retired_join_codes: RLS on, no policies, no grants → only SECURITY DEFINER functions.

-- Re-apply the complete function permission set (Supabase grants EXECUTE on
-- new functions to anon/authenticated by default, so revoke everything first).
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

-- Organizer RPCs (each checks organizer membership internally).
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
  public.set_registration(boolean), public.revoke_participant(uuid), public.rotate_team_pin(uuid)
to authenticated;

-- Participant RPCs: callable without an account; authorized by join code / team PIN / device token.
grant execute on function
  public.join_lookup(text), public.join_team(text, integer, text, text),
  public.register_team(text, text, text, text, text), public.participant_state(text),
  public.participant_submit(text, uuid, uuid, text), public.participant_leave(text)
to anon, authenticated;

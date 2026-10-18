-- BRAINFREZE — COLD START · quiz sets, team attempts, per-team timers (migration 6)
-- Run AFTER migrations 1–5. Re-runnable.
--
-- Model
--   * A QUIZ SET is a row of public.quiz_sessions. Any number of sets may exist
--     per section (UG/PG); `is_current` now means "not archived".
--     Lifecycle: draft (setup, unpublished) → published (setup + code) →
--     live (running/paused) → completed (ended/finalized) → archived.
--   * Organizer RPCs act on the set named by the `x-brainfreze-set` request
--     header (a set id). Without it they fall back to the newest active set of
--     the `x-brainfreze-section` section (UG when absent).
--   * Publishing FREEZES the set: questions, answer keys and resolved marks are
--     copied into public.set_questions (organizer-only); timer and scoring are
--     locked. A published set needs 30–60 questions. Later question-bank edits
--     never change a published set; correct_set_question() is the explicit,
--     audited way to change a published key.
--   * Each team that joins a set gets ONE ATTEMPT (public.quiz_attempts) with a
--     random question order and per-question option order, generated here and
--     stored. The team presses Start: the database records started_at and
--     deadline_at = started_at + duration. Pausing the set freezes all running
--     attempts (deadlines move on resume). Answers after the deadline are
--     refused; expired attempts are finalized as timed out whenever anything
--     reads them (their result never depends on when that happens), and
--     public.finalize_all_expired() can also be scheduled with pg_cron.
--   * One set per team per section: a team with an attempt or answers in one
--     active set of its section cannot join another unless an organizer resets it.
--   * Ranking: points desc → elapsed time asc → organizer tie-break; equal
--     points and time without a tie-break result is flagged for review.
--     Elapsed = final submission − start − paused time for submitted attempts;
--     the full time limit for timed-out, organizer-finalized, unstarted and
--     paper-only teams.
--
-- Data changes: none to existing rows except archived_at for already-archived
-- sessions; existing published sessions (none live before this migration) get
-- their snapshot on their next publish.

-- ===========================================================================
-- Schema
-- ===========================================================================
alter table public.quiz_sessions add column if not exists published_by uuid;
alter table public.quiz_sessions add column if not exists paused_at timestamptz;
alter table public.quiz_sessions add column if not exists archived_at timestamptz;
update public.quiz_sessions set archived_at = coalesce(archived_at, updated_at) where not is_current and archived_at is null;

-- Any number of active sets per section. The index keeps its old name (so
-- re-running migration 1 is a no-op) but no longer restricts anything.
drop index if exists public.quiz_sessions_one_current;
create unique index quiz_sessions_one_current on public.quiz_sessions (id) where is_current;
create index if not exists quiz_sessions_active_section_idx on public.quiz_sessions (section, created_at) where is_current;

-- Frozen copy of a published set's questions (contains keys → organizer-only).
create table if not exists public.set_questions (
  session_id      uuid not null references public.quiz_sessions (id) on delete cascade,
  question_id     uuid not null references public.questions (id) on delete cascade,
  position        integer not null check (position >= 1),
  question_text   text not null,
  option_a        text not null,
  option_b        text not null,
  option_c        text not null,
  option_d        text not null,
  image_url       text,
  category        text,
  correct_option  char(1) not null check (correct_option in ('A', 'B', 'C', 'D')),
  explanation     text,
  marks_correct   numeric(6, 2) not null,
  marks_incorrect numeric(6, 2) not null,
  primary key (session_id, question_id),
  constraint set_questions_position_key unique (session_id, position)
);

-- One attempt per team per set (reset attempts are kept for the audit trail).
create table if not exists public.quiz_attempts (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.quiz_sessions (id) on delete cascade,
  team_id         uuid not null references public.teams (id) on delete cascade,
  status          text not null default 'ready'
                  check (status in ('ready', 'in_progress', 'submitted', 'timed_out', 'organizer_finalized', 'reset')),
  question_order  uuid[] not null,
  option_orders   text[] not null,   -- option_orders[i] = e.g. 'CADB': displayed A shows original C, …
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  deadline_at     timestamptz,
  paused_ms       bigint not null default 0 check (paused_ms >= 0),
  finished_at     timestamptz,       -- server time of final submission / deadline / organizer end
  finalized_by    uuid,
  finalize_reason text check (finalize_reason is null or char_length(finalize_reason) <= 300),
  reset_at        timestamptz,
  reset_by        uuid,
  reset_reason    text check (reset_reason is null or char_length(reset_reason) <= 300),
  constraint quiz_attempts_orders_ck check (cardinality(question_order) = cardinality(option_orders)),
  constraint quiz_attempts_started_ck check ((started_at is null) = (deadline_at is null)),
  constraint quiz_attempts_status_ck check (
    (status = 'ready' and started_at is null and finished_at is null)
    or (status = 'in_progress' and started_at is not null and finished_at is null)
    or (status in ('submitted', 'timed_out') and started_at is not null and finished_at is not null)
    or status in ('organizer_finalized', 'reset'))
);
create unique index if not exists quiz_attempts_one_active on public.quiz_attempts (session_id, team_id) where status <> 'reset';
create index if not exists quiz_attempts_team_idx on public.quiz_attempts (team_id);

alter table public.team_answers add column if not exists attempt_id uuid references public.quiz_attempts (id) on delete set null;
alter table public.team_answers add column if not exists displayed_option char(1);
alter table public.team_answers add column if not exists on_time boolean;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'team_answers_displayed_ck') then
    alter table public.team_answers add constraint team_answers_displayed_ck check (displayed_option is null or displayed_option in ('A', 'B', 'C', 'D'));
  end if;
  -- New audit actions: attempt resets/finalizations and published-key corrections.
  alter table public.score_events drop constraint if exists score_events_action_check;
  alter table public.score_events add constraint score_events_action_check check (action in (
    'record', 'correction', 'undo', 'rescore', 'delete_team', 'delete_question', 'authorize', 'tiebreak', 'qualify',
    'reopen', 'restore', 'attempt_reset', 'attempt_finalize', 'key_change'));
end $$;

-- ===========================================================================
-- Set selection and locking
-- ===========================================================================
create or replace function public._header(p_name text) returns text
language plpgsql stable set search_path = '' as $$
declare h json;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then h := null;
  end;
  return nullif(btrim(coalesce(h->>p_name, '')), '');
end $$;

create or replace function public._current_set_id() returns uuid
language plpgsql stable set search_path = '' as $$
declare v text := public._header('x-brainfreze-set');
begin
  if v is null then return null; end if;
  if v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform public._err('VALIDATION', 'Unknown quiz set.');
  end if;
  return v::uuid;
end $$;

-- The newest active set of a section (created on demand).
create or replace function public._lock_section_session(p_section text) returns public.quiz_sessions
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  select * into s from public.quiz_sessions where is_current and section = p_section order by created_at desc, id limit 1 for update;
  if not found then
    perform pg_advisory_xact_lock(hashtext('brainfreze.session.' || p_section));
    select * into s from public.quiz_sessions where is_current and section = p_section order by created_at desc, id limit 1 for update;
    if not found then
      insert into public.quiz_sessions (is_current, section) values (true, p_section) returning * into s;
      insert into public.quiz_settings (session_id) values (s.id);
    end if;
  end if;
  return s;
end $$;

create or replace function public._lock_current_session() returns public.quiz_sessions
language plpgsql security definer set search_path = '' as $$
declare v uuid := public._current_set_id(); s public.quiz_sessions;
begin
  if v is null then return public._lock_section_session(public._current_section()); end if;
  select * into s from public.quiz_sessions where id = v for update;
  if not found then perform public._err('NO_SESSION', 'That quiz set does not exist.'); end if;
  return s;
end $$;

create or replace function public._lock_all_current() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.quiz_sessions where is_current order by id for update;
end $$;

-- 'draft' | 'published' | 'live' | 'completed' | 'archived'
create or replace function public._set_stage(s public.quiz_sessions) returns text
language sql immutable set search_path = '' as $$
  select case when not s.is_current then 'archived'
              when s.status in ('running', 'paused') then 'live'
              when s.status in ('ended', 'finalized') then 'completed'
              when s.published_at is not null then 'published'
              else 'draft' end;
$$;

-- ===========================================================================
-- Set questions: frozen snapshot once published, the live bank while draft
-- ===========================================================================
create or replace function public._session_questions(s public.quiz_sessions)
returns table (id uuid, idx integer)
language sql stable security definer set search_path = '' as $$
  select x.id, x.idx from (
    select sq.question_id as id, (sq.position - 1)::int as idx
    from public.set_questions sq where s.published_at is not null and sq.session_id = s.id
    union all
    select q.id, (row_number() over (order by q.position) - 1)::int
    from public.questions q
    where s.published_at is null and (s.question_ids is null or q.id = any (s.question_ids))
  ) x order by x.idx;
$$;

-- One question of a set, with its key and resolved marks (snapshot when published).
create or replace function public._set_question(s public.quiz_sessions, p_question uuid)
returns table (id uuid, pos integer, question_text text, option_a text, option_b text, option_c text, option_d text,
               image_url text, correct_option text, explanation text, marks_correct numeric, marks_incorrect numeric)
language sql stable security definer set search_path = '' as $$
  select sq.question_id, sq.position, sq.question_text, sq.option_a, sq.option_b, sq.option_c, sq.option_d, sq.image_url,
         sq.correct_option::text, sq.explanation, sq.marks_correct, sq.marks_incorrect
  from public.set_questions sq where s.published_at is not null and sq.session_id = s.id and sq.question_id = p_question
  union all
  select q.id, q.position, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.image_url,
         k.correct_option::text, k.explanation,
         coalesce(q.marks_correct, st.marks_correct), coalesce(q.marks_incorrect, st.marks_incorrect)
  from public.questions q
  left join public.question_keys k on k.question_id = q.id
  left join public.quiz_settings st on st.session_id = s.id
  where s.published_at is null and q.id = p_question;
$$;

-- Bank edits never touch published sets; re-score only draft sets (which have no answers).
create or replace function public._rescore_question(s public.quiz_sessions, p_question uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare st public.quiz_settings := public._settings(s.id); q record; a public.team_answers; r record; n integer := 0;
begin
  select * into q from public._set_question(s, p_question);
  for a in select * from public.team_answers where session_id = s.id and question_id = p_question for update loop
    if s.status = 'finalized' then perform public._err('RESULTS_FINALIZED'); end if;
    select * into r from public._evaluate(a.selected_option, q.correct_option, q.marks_correct, q.marks_incorrect, st.marks_unanswered);
    if r.result <> a.result or r.points <> a.points then
      update public.team_answers set result = r.result, points = r.points where id = a.id;
      insert into public.score_events (session_id, action, team_id, team_number, question_id, question_position,
        prev_selected, prev_result, prev_points, new_selected, new_result, new_points, reason, actor)
      values (s.id, 'rescore', a.team_id, (select team_number from public.teams where id = a.team_id), q.id, q.pos,
        a.selected_option, a.result, a.points, a.selected_option, r.result, r.points, 'Answer key or marks changed', auth.uid());
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ===========================================================================
-- Attempts
-- ===========================================================================
-- Effective "now" for a set's attempt clocks: frozen at paused_at while paused.
create or replace function public._clock(s public.quiz_sessions) returns timestamptz
language sql stable set search_path = '' as $$
  select case when s.status = 'paused' and s.paused_at is not null then least(s.paused_at, now()) else now() end;
$$;

-- Time out every running attempt of the set whose deadline has passed. The
-- final time is the deadline itself, so it does not matter when this runs.
create or replace function public._finalize_expired(s public.quiz_sessions) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.quiz_attempts set status = 'timed_out', finished_at = deadline_at
  where session_id = s.id and status = 'in_progress' and deadline_at <= public._clock(s);
  get diagnostics n = row_count;
  return n;
end $$;

-- For pg_cron (optional): select public.finalize_all_expired();  — no API grants.
create or replace function public.finalize_all_expired() returns integer
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; n integer := 0;
begin
  for s in select * from public.quiz_sessions where is_current and status in ('running', 'paused') loop
    n := n + public._finalize_expired(s);
  end loop;
  return n;
end $$;

create or replace function public._active_attempt(p_session uuid, p_team uuid) returns public.quiz_attempts
language sql stable security definer set search_path = '' as $$
  select * from public.quiz_attempts where session_id = p_session and team_id = p_team and status <> 'reset' limit 1;
$$;

-- Does the team already take part in ANOTHER active set of its section?
create or replace function public._team_other_set(s public.quiz_sessions, p_team uuid) returns text
language sql stable security definer set search_path = '' as $$
  select x.name from public.quiz_sessions x
  where x.is_current and x.section = s.section and x.id <> s.id
    and (exists (select 1 from public.quiz_attempts a where a.session_id = x.id and a.team_id = p_team and a.status <> 'reset')
         or exists (select 1 from public.team_answers a where a.session_id = x.id and a.team_id = p_team))
  order by x.created_at limit 1;
$$;

-- New attempt: random question order and per-question option order (CSPRNG via gen_random_uuid).
create or replace function public._make_attempt(s public.quiz_sessions, p_team uuid) returns public.quiz_attempts
language plpgsql security definer set search_path = '' as $$
declare a public.quiz_attempts; v_order uuid[]; v_opts text[];
begin
  select array_agg(id order by gen_random_uuid()) into v_order from public._session_questions(s);
  -- correlated with each question so every question gets its own random option order
  select array_agg((select string_agg(l, '' order by gen_random_uuid()) from unnest(array['A', 'B', 'C', 'D']) l where o.qid is not null) order by o.i)
    into v_opts
  from unnest(v_order) with ordinality as o(qid, i);
  insert into public.quiz_attempts (session_id, team_id, question_order, option_orders)
  values (s.id, p_team, coalesce(v_order, '{}'), coalesce(v_opts, '{}')) returning * into a;
  return a;
end $$;

-- Teams counted in a set's results: the section's teams, except those taking part in another active set.
create or replace function public._roster(p_session uuid) returns table (team_id uuid)
language sql stable security definer set search_path = '' as $$
  select t.id from public.teams t join public.quiz_sessions s on s.id = p_session and s.section = t.section
  where public._team_other_set(s, t.id) is null;
$$;

-- ===========================================================================
-- Standings: points → elapsed time → organizer tie-break (mirrors src/lib/scoring.js)
-- ===========================================================================
-- Full per-team results (new function, so earlier migrations stay re-runnable).
create or replace function public._set_standings(p_session uuid)
returns table (team_id uuid, team_number integer, team_name text, is_demo boolean, points numeric,
               correct integer, incorrect integer, unanswered integer, recorded integer, tiebreak numeric, rank integer,
               elapsed_ms bigint, attempt_status text, started_at timestamptz, finished_at timestamptz, tie_review boolean)
language sql stable security definer set search_path = '' as $$
  with ses as (select * from public.quiz_sessions x where x.id = p_session),
  -- defaults if a set somehow has no settings row
  st as (select coalesce(y.marks_unanswered, 0) as marks_unanswered, coalesce(y.duration_seconds, 1800) as duration_seconds
         from (select 1) d left join public.quiz_settings y on y.session_id = p_session),
  qn as (select public._session_question_count(x) as n from ses x),
  agg as (
    select t.id, t.team_number, t.team_name, t.is_demo,
      coalesce(sum(a.points), 0) as rec_points,
      count(a.id) filter (where a.result = 'correct')::int as correct,
      count(a.id) filter (where a.result = 'incorrect')::int as incorrect,
      count(a.id)::int as recorded
    from public.teams t
    join public._roster(p_session) r on r.team_id = t.id
    left join public.team_answers a on a.team_id = t.id and a.session_id = p_session
    group by t.id
  ),
  att as (
    select a.team_id, a.started_at, a.paused_ms, a.deadline_at,
      -- an in-progress attempt past its (effective) deadline counts as timed out
      case when a.status = 'in_progress' and a.deadline_at <= public._clock(x) then 'timed_out' else a.status end as status,
      case when a.status = 'in_progress' and a.deadline_at <= public._clock(x) then a.deadline_at else a.finished_at end as finished_at
    from public.quiz_attempts a cross join ses x
    where a.session_id = p_session and a.status <> 'reset'
  ),
  calc as (
    select agg.*,
      round(agg.rec_points + greatest(0, qn.n - agg.recorded) * st.marks_unanswered, 2) as pts,
      greatest(0, qn.n - agg.correct - agg.incorrect) as unans,
      att.status as a_status, att.started_at as a_start, att.finished_at as a_end,
      case when att.status = 'submitted'
           then least(st.duration_seconds::bigint * 1000,
                      greatest(0, floor(extract(epoch from (att.finished_at - att.started_at)) * 1000)::bigint - att.paused_ms))
           else st.duration_seconds::bigint * 1000 end as el,
      tb.score as tb
    from agg cross join qn cross join st
    left join att on att.team_id = agg.id
    left join public.tiebreak_results tb on tb.session_id = p_session and tb.team_id = agg.id
  ),
  grp as (
    select calc.*,
      case when count(*) over w > 1 and bool_and(calc.tb is not null) over w then calc.tb end as eff_tb,
      count(*) over w as group_size
    from calc
    window w as (partition by calc.pts, calc.el)
  )
  select g.id, g.team_number, g.team_name, g.is_demo, g.pts, g.correct, g.incorrect, g.unans, g.recorded, g.tb,
    (rank() over (order by g.pts desc, g.el asc, g.eff_tb desc nulls last))::int,
    g.el, g.a_status, g.a_start, g.a_end,
    (count(*) over (partition by g.pts, g.el, g.eff_tb) > 1)
  from grp g
  order by 11, g.team_number;
$$;

-- Same shape as before (used by qualification, projector and older callers), new ranking.
create or replace function public._standings(p_session uuid)
returns table (team_id uuid, team_number integer, team_name text, is_demo boolean, points numeric,
               correct integer, incorrect integer, unanswered integer, recorded integer, tiebreak numeric, rank integer)
language sql stable security definer set search_path = '' as $$
  select team_id, team_number, team_name, is_demo, points, correct, incorrect, unanswered, recorded, tiebreak, rank
  from public._set_standings(p_session);
$$;

create or replace function public._selected_set_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(public._current_set_id(),
    (select y.id from public.quiz_sessions y where y.is_current and y.section = public._current_section() order by y.created_at desc, y.id limit 1));
$$;

create or replace function public.get_standings()
returns table (team_id uuid, team_number integer, team_name text, is_demo boolean, points numeric,
               correct integer, incorrect integer, unanswered integer, recorded integer, tiebreak numeric, rank integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_organizer();
  return query select * from public._standings(public._selected_set_id());
end $$;

-- Organizer results for the selected set: everything in get_standings plus times and status.
create or replace function public.get_set_results()
returns table (team_id uuid, team_number integer, team_name text, is_demo boolean, points numeric,
               correct integer, incorrect integer, unanswered integer, recorded integer, tiebreak numeric, rank integer,
               elapsed_ms bigint, attempt_status text, started_at timestamptz, finished_at timestamptz, tie_review boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_organizer();
  return query select * from public._set_standings(public._selected_set_id());
end $$;

-- ===========================================================================
-- Scoring core (organizer paper entry and team devices)
-- ===========================================================================
create or replace function public._record(
  s public.quiz_sessions, st public.quiz_settings, t public.teams, p_question uuid, sel text,
  p_request_id uuid, p_correction boolean, p_reason text, p_source text,
  p_attempt uuid, p_displayed text, p_on_time boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ex public.team_answers; has_ex boolean; q record; r record; v_action text; v_id bigint;
begin
  select * into q from public._set_question(s, p_question);
  if q.id is null then perform public._err('QUESTION_NOT_IN_QUIZ'); end if;
  select * into r from public._evaluate(sel, q.correct_option, q.marks_correct, q.marks_incorrect, st.marks_unanswered);
  select * into ex from public.team_answers where session_id = s.id and team_id = t.id and question_id = q.id for update;
  has_ex := found;
  if has_ex then
    if not coalesce(p_correction, false) then perform public._err('ALREADY_RECORDED'); end if;
    if public._clean(p_reason) is null then perform public._err('REASON_REQUIRED', 'A reason is required to correct a recorded answer.'); end if;
    if ex.selected_option is not distinct from sel then perform public._err('NO_CHANGE'); end if;
    update public.team_answers set selected_option = sel, result = r.result, points = r.points, recorded_by = auth.uid(), source = p_source
    where id = ex.id;
    v_action := 'correction';
  else
    insert into public.team_answers (session_id, team_id, question_id, selected_option, result, points, recorded_by, source,
      attempt_id, displayed_option, on_time)
    values (s.id, t.id, q.id, sel, r.result, r.points, auth.uid(), p_source, p_attempt, p_displayed, p_on_time);
    v_action := 'record';
  end if;
  insert into public.score_events (session_id, request_id, action, team_id, team_number, question_id, question_position,
    prev_selected, prev_result, prev_points, new_selected, new_result, new_points, reason, actor, source)
  values (s.id, p_request_id, v_action, t.id, t.team_number, q.id, q.pos,
    case when has_ex then ex.selected_option end, case when has_ex then ex.result end, case when has_ex then ex.points end,
    sel, r.result, r.points, case when has_ex then public._clean(p_reason) end, auth.uid(), p_source)
  returning id into v_id;
  return jsonb_build_object('duplicate_request', false, 'event_id', v_id, 'action', v_action, 'result', r.result, 'points', r.points, 'selected', sel);
end $$;

create or replace function public.record_answer(
  p_request_id uuid, p_team_id uuid, p_question_id uuid, p_selected text,
  p_correction boolean default false, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; st public.quiz_settings; t public.teams; ev public.score_events; a public.quiz_attempts;
begin
  perform public._require_organizer();
  if p_request_id is null then perform public._err('VALIDATION', 'request_id is required.'); end if;
  s := public._lock_current_session();
  select * into ev from public.score_events where request_id = p_request_id;
  if found then
    return jsonb_build_object('duplicate_request', true, 'event_id', ev.id, 'result', ev.new_result, 'points', ev.new_points, 'selected', ev.new_selected);
  end if;
  st := public._settings(s.id);
  perform public._assert_scoring_open(s, st);
  select * into t from public.teams where id = p_team_id and section = s.section;
  if not found then perform public._err('TEAM_NOT_FOUND', 'That team is not in this set''s section.'); end if;
  if public._team_other_set(s, t.id) is not null then
    perform public._err('TEAM_IN_OTHER_SET', format('Team %s takes part in "%s".', t.team_number, public._team_other_set(s, t.id)));
  end if;
  if not exists (select 1 from public._session_questions(s) sq where sq.id = p_question_id) then perform public._err('QUESTION_NOT_IN_QUIZ'); end if;
  a := public._active_attempt(s.id, t.id);
  return public._record(s, st, t, p_question_id, public._normalize_option(p_selected), p_request_id, p_correction, p_reason, 'organizer',
    a.id, null, s.status = 'running' and public._elapsed_ms(s) < st.duration_seconds::bigint * 1000);
end $$;

create or replace function public.undo_last_action(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.quiz_sessions; st public.quiz_settings; ev public.score_events; tgt public.score_events;
  ex public.team_answers; q record; r record; v_id bigint; v_sel text; v_res text; v_pts numeric;
begin
  perform public._require_organizer();
  if p_request_id is null then perform public._err('VALIDATION', 'request_id is required.'); end if;
  s := public._lock_current_session();
  select * into ev from public.score_events where request_id = p_request_id;
  if found then return jsonb_build_object('duplicate_request', true, 'event_id', ev.id, 'undo_of', ev.undo_of); end if;
  st := public._settings(s.id);
  perform public._assert_scoring_open(s, st);
  select * into tgt from public.score_events
  where session_id = s.id and action in ('record', 'correction') and not undone
  order by id desc limit 1 for update;
  if not found then perform public._err('NOTHING_TO_UNDO'); end if;
  select * into ex from public.team_answers
  where session_id = s.id and team_id = tgt.team_id and question_id = tgt.question_id for update;
  if not found or ex.selected_option is distinct from tgt.new_selected then perform public._err('UNDO_CONFLICT'); end if;
  select * into q from public._set_question(s, tgt.question_id);
  if tgt.action = 'record' then
    delete from public.team_answers where id = ex.id;
  else
    select * into r from public._evaluate(tgt.prev_selected, q.correct_option, q.marks_correct, q.marks_incorrect, st.marks_unanswered);
    update public.team_answers set selected_option = tgt.prev_selected, result = r.result, points = r.points, recorded_by = auth.uid() where id = ex.id;
    v_sel := tgt.prev_selected; v_res := r.result; v_pts := r.points;
  end if;
  update public.score_events set undone = true where id = tgt.id;
  insert into public.score_events (session_id, request_id, action, undo_of, team_id, team_number, question_id, question_position,
    prev_selected, prev_result, prev_points, new_selected, new_result, new_points, reason, actor)
  values (s.id, p_request_id, 'undo', tgt.id, tgt.team_id, tgt.team_number, tgt.question_id, coalesce(q.pos, tgt.question_position),
    ex.selected_option, ex.result, ex.points, v_sel, v_res, v_pts, 'Undo of #' || tgt.id, auth.uid())
  returning id into v_id;
  return jsonb_build_object('duplicate_request', false, 'event_id', v_id, 'undo_of', tgt.id);
end $$;

-- ===========================================================================
-- Organizer: quiz set management
-- ===========================================================================
create or replace function public.create_set(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_section text := upper(btrim(coalesce(p->>'section', ''))); v_name text := public._clean(p->>'name');
begin
  perform public._require_organizer();
  if v_section not in ('UG', 'PG') then perform public._err('VALIDATION', 'Choose the section (UG or PG).'); end if;
  if v_name is null or char_length(v_name) > 80 then perform public._err('VALIDATION', 'Quiz set name is required (max 80 characters).'); end if;
  insert into public.quiz_sessions (is_current, section, name, description, self_paced)
  values (true, v_section, v_name, public._clean(p->>'description'), true) returning id into v_id;
  insert into public.quiz_settings (session_id) values (v_id);
  return v_id;
end $$;

-- Copy a set's name, questions and settings into a new draft (any stage).
create or replace function public.duplicate_set(p_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; st public.quiz_settings; v_id uuid;
begin
  perform public._require_organizer();
  select * into s from public.quiz_sessions where id = p_id;
  if not found then perform public._err('NO_SESSION', 'That quiz set does not exist.'); end if;
  st := public._settings(s.id);
  insert into public.quiz_sessions (is_current, section, name, description, self_paced, self_registration, question_ids)
  values (true, s.section, left(s.name || ' (copy)', 80), s.description, true, s.self_registration,
    array(select sq.id from public._session_questions(s) sq where exists (select 1 from public.questions q where q.id = sq.id) order by sq.idx))
  returning id into v_id;
  insert into public.quiz_settings (session_id, duration_seconds, marks_correct, marks_incorrect, marks_unanswered, qualify_count, accuracy_tiebreak)
  values (v_id, st.duration_seconds, st.marks_correct, st.marks_incorrect, st.marks_unanswered, st.qualify_count, st.accuracy_tiebreak);
  return v_id;
end $$;

-- Drafts only (never published, so no attempts, answers or codes).
create or replace function public.delete_set(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  select * into s from public.quiz_sessions where id = p_id for update;
  if not found then perform public._err('NO_SESSION', 'That quiz set does not exist.'); end if;
  if public._set_stage(s) <> 'draft' or s.join_code is not null
     or exists (select 1 from public.score_events where session_id = s.id) then
    perform public._err('INVALID_STATE', 'Only an unpublished draft can be deleted. Archive other sets instead.');
  end if;
  delete from public.quiz_sessions where id = s.id;
  return jsonb_build_object('deleted', true);
end $$;

-- Archive (hide) a set that is not live. Its code is retired; devices are signed out; results are kept.
create or replace function public.archive_set(p_id uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  select * into s from public.quiz_sessions where id = p_id for update;
  if not found then perform public._err('NO_SESSION', 'That quiz set does not exist.'); end if;
  if s.status in ('running', 'paused') then perform public._err('QUIZ_IN_PROGRESS', 'End the set before archiving it.'); end if;
  perform public._retire_join_code(s);
  update public.quiz_sessions set is_current = false, archived_at = now(), join_code_active = false, registration_open = false where id = s.id;
  update public.participant_sessions set revoked_at = now(), revoked_reason = 'Quiz set archived' where session_id = s.id and revoked_at is null;
  insert into public.score_events (session_id, action, reason, actor)
  values (s.id, 'authorize', 'Set archived' || coalesce(': ' || public._clean(p_reason), ''), auth.uid());
  return jsonb_build_object('ok', true);
end $$;

-- Name and description always; section, questions and self-registration only while a draft.
create or replace function public.update_quiz_details(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; v_name text; v_desc text; v_ids uuid[]; v_self boolean; v_section text;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  v_name := coalesce(public._clean(p->>'name'), s.name);
  if char_length(v_name) > 80 then perform public._err('VALIDATION', 'Quiz set name must be 80 characters or fewer.'); end if;
  v_desc := case when p ? 'description' then public._clean(p->>'description') else s.description end;
  if v_desc is not null and char_length(v_desc) > 500 then perform public._err('VALIDATION', 'Description must be 500 characters or fewer.'); end if;
  v_self := coalesce((p->>'self_registration')::boolean, s.self_registration);
  v_section := upper(coalesce(p->>'section', s.section));
  if v_section not in ('UG', 'PG') then perform public._err('VALIDATION', 'Section must be UG or PG.'); end if;
  if (v_section <> s.section or (p ? 'question_ids')) and s.published_at is not null then
    perform public._err('SET_FROZEN', 'A published set''s section and questions are frozen.');
  end if;
  if p ? 'question_ids' then
    if jsonb_typeof(p->'question_ids') = 'null' then
      v_ids := null;
    elsif jsonb_typeof(p->'question_ids') = 'array' then
      if (select count(*) from jsonb_array_elements_text(p->'question_ids')) <> (select count(distinct x) from jsonb_array_elements_text(p->'question_ids') x) then
        perform public._err('VALIDATION', 'A question can be selected only once.');
      end if;
      v_ids := array(select (jsonb_array_elements_text(p->'question_ids'))::uuid);
      if cardinality(v_ids) = 0 then perform public._err('VALIDATION', 'Select at least one question.'); end if;
      if cardinality(v_ids) > 60 then perform public._err('QUESTION_COUNT', 'A set can have at most 60 questions.'); end if;
      if exists (select 1 from unnest(v_ids) x where not exists (select 1 from public.questions q where q.id = x)) then
        perform public._err('VALIDATION', 'A selected question no longer exists.');
      end if;
    else
      perform public._err('VALIDATION', 'question_ids must be an array or null.');
    end if;
  else
    v_ids := s.question_ids;
  end if;
  update public.quiz_sessions set name = v_name, description = v_desc, question_ids = v_ids, self_registration = v_self,
    section = v_section, self_paced = true
  where id = s.id;
  perform public._renumber_questions();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.update_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; v_dur numeric := (p->>'duration_seconds')::numeric;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.published_at is not null or s.status <> 'setup' then
    perform public._err('SET_FROZEN', 'Timer and scoring are frozen once the set is published.');
  end if;
  if v_dur is not null and (v_dur < 300 or v_dur > 7200) then
    perform public._err('VALIDATION', 'The time limit must be between 5 and 120 minutes.');
  end if;
  perform public._settings(s.id);
  update public.quiz_settings set
    duration_seconds  = coalesce((p->>'duration_seconds')::numeric::int, duration_seconds),
    marks_correct     = coalesce((p->>'marks_correct')::numeric, marks_correct),
    marks_incorrect   = coalesce((p->>'marks_incorrect')::numeric, marks_incorrect),
    marks_unanswered  = coalesce((p->>'marks_unanswered')::numeric, marks_unanswered),
    qualify_count     = coalesce((p->>'qualify_count')::numeric::int, qualify_count),
    accuracy_tiebreak = coalesce((p->>'accuracy_tiebreak')::boolean, accuracy_tiebreak)
  where session_id = s.id;
  return jsonb_build_object('ok', true);
end $$;

-- Validate, freeze (snapshot) and open for joining — one transaction.
create or replace function public.publish_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; st public.quiz_settings; c text; n integer;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if not s.is_current then perform public._err('INVALID_STATE', 'An archived set cannot be published.'); end if;
  if s.status in ('ended', 'finalized') then perform public._err('INVALID_STATE', 'A completed set cannot be published again. Duplicate it instead.'); end if;
  if s.join_code_active then return jsonb_build_object('ok', true, 'join_code', s.join_code); end if;
  if s.published_at is not null then
    perform public._err('INVALID_STATE', 'This set''s code was revoked. Use "New code" to issue a fresh one.');
  end if;
  st := public._settings(s.id);
  n := public._session_question_count(s);
  if n < 30 or n > 60 then
    perform public._err('QUESTION_COUNT', format('A set must have 30 to 60 questions to be published (it has %s).', n));
  end if;
  perform public._assert_quiz_ready(s, false);
  if st.duration_seconds < 300 or st.duration_seconds > 7200 then
    perform public._err('VALIDATION', 'The time limit must be between 5 and 120 minutes.');
  end if;
  if exists (select 1 from public._session_questions(s) sq join public.questions q on q.id = sq.id
             where coalesce(q.marks_correct, st.marks_correct) < 0 or coalesce(q.marks_incorrect, st.marks_incorrect) > 0) then
    perform public._err('VALIDATION', 'Every question needs valid marks (correct ≥ 0, incorrect ≤ 0).');
  end if;
  delete from public.set_questions where session_id = s.id;
  insert into public.set_questions (session_id, question_id, position, question_text, option_a, option_b, option_c, option_d,
    image_url, category, correct_option, explanation, marks_correct, marks_incorrect)
  select s.id, q.id, sq.idx + 1, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.image_url, q.category,
         k.correct_option, k.explanation, coalesce(q.marks_correct, st.marks_correct), coalesce(q.marks_incorrect, st.marks_incorrect)
  from public._session_questions(s) sq join public.questions q on q.id = sq.id join public.question_keys k on k.question_id = q.id;
  update public.quiz_sessions set published_at = now(), published_by = auth.uid(), self_paced = true,
    question_ids = (select array_agg(question_id order by position) from public.set_questions where session_id = s.id)
  where id = s.id;
  c := public._issue_join_code(s.id);
  update public.quiz_sessions set registration_open = true where id = s.id;
  return jsonb_build_object('ok', true, 'join_code', c);
end $$;

-- Back to draft: only before going live and before any team has joined.
create or replace function public.unpublish_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status <> 'setup' then perform public._err('INVALID_STATE', 'A started set cannot be returned to draft.'); end if;
  if exists (select 1 from public.quiz_attempts where session_id = s.id) then
    perform public._err('INVALID_STATE', 'Teams have already joined this set. Revoke its code or archive it instead.');
  end if;
  perform public._retire_join_code(s);
  update public.quiz_sessions set join_code_active = false, registration_open = false, published_at = null, published_by = null where id = s.id;
  delete from public.set_questions where session_id = s.id;
  update public.participant_sessions set revoked_at = now(), revoked_reason = 'Quiz returned to draft'
  where session_id = s.id and revoked_at is null;
  return jsonb_build_object('ok', true);
end $$;

-- Stop the code working (never reused). Joined teams keep their access.
create or replace function public.revoke_join_code() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if not s.join_code_active then perform public._err('INVALID_STATE', 'This set has no active code.'); end if;
  perform public._retire_join_code(s);
  update public.quiz_sessions set join_code_active = false, registration_open = false where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

-- "Go live": teams may now press Start. Requires a published (frozen) set.
create or replace function public.start_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status <> 'setup' then perform public._err('INVALID_STATE', 'The set is already live or completed.'); end if;
  if s.published_at is null then perform public._err('NOT_PUBLISHED', 'Publish the set before going live.'); end if;
  perform public._settings(s.id);
  update public.quiz_sessions set status = 'running', started_at = now(), timer_started_at = now(), elapsed_ms = 0,
    current_index = 0, projector_view = 'question', paused_at = null
  where id = s.id;
  return jsonb_build_object('ok', true, 'server_now', now());
end $$;

-- Pause freezes every running team timer.
create or replace function public.pause_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; st public.quiz_settings;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status <> 'running' then perform public._err('INVALID_STATE', 'The set is not running.'); end if;
  perform public._finalize_expired(s);
  st := public._settings(s.id);
  update public.quiz_sessions set status = 'paused', timer_started_at = null, paused_at = now(),
    elapsed_ms = least(st.duration_seconds::bigint * 1000, public._elapsed_ms(s))
  where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

-- Resume: every attempt that was running when paused gets its deadline moved by the paused time.
create or replace function public.resume_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; v_ms bigint;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status <> 'paused' then perform public._err('INVALID_STATE', 'The set is not paused.'); end if;
  perform public._finalize_expired(s); -- deadlines before the pause are final
  v_ms := greatest(0, floor(extract(epoch from (now() - coalesce(s.paused_at, now()))) * 1000))::bigint;
  update public.quiz_attempts set deadline_at = deadline_at + make_interval(secs => v_ms / 1000.0), paused_ms = paused_ms + v_ms
  where session_id = s.id and status = 'in_progress';
  update public.quiz_sessions set status = 'running', timer_started_at = now(), paused_at = null where id = s.id;
  return jsonb_build_object('ok', true, 'paused_ms', v_ms);
end $$;

-- End the set: expired attempts time out at their deadline; still-running ones are organizer-finalized now.
create or replace function public.end_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; st public.quiz_settings; n integer;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status not in ('running', 'paused') then perform public._err('INVALID_STATE', 'The set is not live.'); end if;
  perform public._finalize_expired(s);
  update public.quiz_attempts set status = 'organizer_finalized', finished_at = public._clock(s), finalized_by = auth.uid(),
    finalize_reason = 'Set ended by the organizer'
  where session_id = s.id and status = 'in_progress';
  get diagnostics n = row_count;
  st := public._settings(s.id);
  update public.quiz_sessions set status = 'ended', timer_started_at = null, ended_at = now(), paused_at = null,
    elapsed_ms = least(st.duration_seconds::bigint * 1000, public._elapsed_ms(s)),
    join_code_active = false, registration_open = false
  where id = s.id;
  if n > 0 then
    insert into public.score_events (session_id, action, reason, actor)
    values (s.id, 'attempt_finalize', format('Set ended: %s running attempt(s) finalized by the organizer', n), auth.uid());
  end if;
  return jsonb_build_object('ok', true, 'finalized', n);
end $$;

create or replace function public.finalize_expired_attempts() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  return jsonb_build_object('ok', true, 'finalized', public._finalize_expired(s));
end $$;

-- Organizer: finish one team's running attempt now (audited).
create or replace function public.finalize_attempt(p_team_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; a public.quiz_attempts; t public.teams;
begin
  perform public._require_organizer();
  if public._clean(p_reason) is null then perform public._err('REASON_REQUIRED'); end if;
  s := public._lock_current_session();
  perform public._finalize_expired(s);
  select * into a from public.quiz_attempts where session_id = s.id and team_id = p_team_id and status <> 'reset' for update;
  if not found or a.status <> 'in_progress' then perform public._err('INVALID_STATE', 'That team has no running attempt.'); end if;
  update public.quiz_attempts set status = 'organizer_finalized', finished_at = public._clock(s), finalized_by = auth.uid(),
    finalize_reason = public._clean(p_reason) where id = a.id;
  select * into t from public.teams where id = p_team_id;
  insert into public.score_events (session_id, action, team_id, team_number, reason, actor)
  values (s.id, 'attempt_finalize', t.id, t.team_number, public._clean(p_reason), auth.uid());
  return jsonb_build_object('ok', true);
end $$;

-- Organizer-authorized retake: the attempt is kept as 'reset', its answers are removed (audited),
-- and the team's device receives a fresh attempt with a new order.
create or replace function public.reset_attempt(p_team_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; a public.quiz_attempts; t public.teams; n integer; pts numeric;
begin
  perform public._require_organizer();
  if public._clean(p_reason) is null then perform public._err('REASON_REQUIRED'); end if;
  s := public._lock_current_session();
  if s.status = 'finalized' then perform public._err('RESULTS_FINALIZED'); end if;
  select * into t from public.teams where id = p_team_id;
  if not found then perform public._err('TEAM_NOT_FOUND'); end if;
  select * into a from public.quiz_attempts where session_id = s.id and team_id = p_team_id and status <> 'reset' for update;
  if not found then perform public._err('INVALID_STATE', 'That team has no attempt in this set.'); end if;
  select count(*), coalesce(sum(points), 0) into n, pts from public.team_answers where session_id = s.id and team_id = p_team_id;
  update public.quiz_attempts set status = 'reset', reset_at = now(), reset_by = auth.uid(), reset_reason = public._clean(p_reason) where id = a.id;
  delete from public.team_answers where session_id = s.id and team_id = p_team_id;
  delete from public.tiebreak_results where session_id = s.id and team_id = p_team_id;
  insert into public.score_events (session_id, action, team_id, team_number, prev_points, reason, actor)
  values (s.id, 'attempt_reset', t.id, t.team_number, pts,
    format('Attempt reset (%s answer(s) removed): %s', n, public._clean(p_reason)), auth.uid());
  return jsonb_build_object('ok', true, 'removed_answers', n);
end $$;

-- Explicit, audited change to a PUBLISHED set's key or marks; re-scores that set only.
create or replace function public.correct_set_question(p_question_id uuid, p jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; old public.set_questions; v_key text; v_mc numeric; v_mi numeric; n integer;
begin
  perform public._require_organizer();
  if public._clean(p_reason) is null then perform public._err('REASON_REQUIRED'); end if;
  s := public._lock_current_session();
  if s.published_at is null then perform public._err('INVALID_STATE', 'Edit draft questions in the question bank.'); end if;
  if s.status = 'finalized' then perform public._err('RESULTS_FINALIZED'); end if;
  select * into old from public.set_questions where session_id = s.id and question_id = p_question_id for update;
  if not found then perform public._err('QUESTION_NOT_IN_QUIZ'); end if;
  v_key := upper(btrim(coalesce(p->>'correct_option', old.correct_option)));
  v_mc := coalesce(nullif(p->>'marks_correct', '')::numeric, old.marks_correct);
  v_mi := coalesce(nullif(p->>'marks_incorrect', '')::numeric, old.marks_incorrect);
  if v_key not in ('A', 'B', 'C', 'D') or v_mc < 0 or v_mc > 100 or v_mi > 0 or v_mi < -100 then
    perform public._err('VALIDATION', 'Key must be A–D; correct marks 0–100; incorrect marks −100–0.');
  end if;
  if v_key = old.correct_option and v_mc = old.marks_correct and v_mi = old.marks_incorrect then perform public._err('NO_CHANGE'); end if;
  update public.set_questions set correct_option = v_key, marks_correct = v_mc, marks_incorrect = v_mi
  where session_id = s.id and question_id = p_question_id;
  insert into public.score_events (session_id, action, question_id, question_position, reason, actor)
  values (s.id, 'key_change', p_question_id, old.position,
    format('Q%s key %s→%s, marks %s/%s→%s/%s: %s', old.position, old.correct_option, v_key, old.marks_correct, old.marks_incorrect, v_mc, v_mi, public._clean(p_reason)),
    auth.uid());
  n := public._rescore_question(s, p_question_id);
  return jsonb_build_object('ok', true, 'rescored', n);
end $$;

-- A new draft copy of the selected set; the old one is archived.
create or replace function public.new_session() returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; v_id uuid;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status in ('running', 'paused') then perform public._err('QUIZ_IN_PROGRESS', 'End the set first.'); end if;
  v_id := public.duplicate_set(s.id);
  update public.quiz_sessions set name = s.name where id = v_id;
  perform public.archive_set(s.id, 'Replaced by a new draft');
  return v_id;
end $$;

create or replace function public.set_tiebreak(p_team_id uuid, p_score numeric, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; t public.teams;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status = 'finalized' then perform public._err('RESULTS_FINALIZED'); end if;
  if s.status <> 'ended' then perform public._err('INVALID_STATE', 'Tie-break results can be entered after the set ends.'); end if;
  select * into t from public.teams where id = p_team_id and section = s.section;
  if not found or not exists (select 1 from public._roster(s.id) r where r.team_id = t.id) then perform public._err('TEAM_NOT_FOUND'); end if;
  if p_score is null then
    delete from public.tiebreak_results where session_id = s.id and team_id = p_team_id;
  else
    insert into public.tiebreak_results (session_id, team_id, score, note) values (s.id, p_team_id, round(p_score, 2), public._clean(p_note))
    on conflict (session_id, team_id) do update set score = excluded.score, note = excluded.note, recorded_at = now();
  end if;
  insert into public.score_events (session_id, action, team_id, team_number, reason, actor)
  values (s.id, 'tiebreak', t.id, t.team_number,
    case when p_score is null then 'Cleared tie-break result'
         else 'Tie-break result ' || round(p_score, 2) || coalesce(' — ' || public._clean(p_note), '') end, auth.uid());
  return jsonb_build_object('ok', true);
end $$;

-- ===========================================================================
-- Question bank: published sets are frozen, so bank edits never change them
-- ===========================================================================
create or replace function public._assert_bank_editable() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  null; -- kept for compatibility: live sets use their frozen snapshot
end $$;

create or replace function public._assert_not_in_published(p_question uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  select s.name into v from public.set_questions sq join public.quiz_sessions s on s.id = sq.session_id
  where s.is_current and (p_question is null or sq.question_id = p_question) order by s.created_at limit 1;
  if v is not null then
    perform public._err('QUESTION_IN_PUBLISHED_SET', format('Used by the published set "%s". Archive that set first.', v));
  end if;
end $$;

create or replace function public.save_question(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_text text := public._clean(p->>'question_text');
  v_a text := public._clean(p->>'option_a');
  v_b text := public._clean(p->>'option_b');
  v_c text := public._clean(p->>'option_c');
  v_d text := public._clean(p->>'option_d');
  v_key text := upper(btrim(coalesce(p->>'correct_option', '')));
  v_expl text := public._clean(p->>'explanation');
  v_img text := nullif(btrim(coalesce(p->>'image_url', '')), '');
  v_cat text := public._clean(p->>'category');
  v_mc numeric := nullif(btrim(coalesce(p->>'marks_correct', '')), '')::numeric;
  v_mi numeric := nullif(btrim(coalesce(p->>'marks_incorrect', '')), '')::numeric;
  v_sample boolean := coalesce((p->>'is_sample')::boolean, false);
  v_pos integer; n integer;
begin
  perform public._require_organizer();
  if v_text is null then perform public._err('VALIDATION', 'Question text is required.'); end if;
  if v_a is null or v_b is null or v_c is null or v_d is null then perform public._err('VALIDATION', 'All four options (A–D) are required.'); end if;
  if (select count(distinct lower(x)) from unnest(array[v_a, v_b, v_c, v_d]) x) <> 4 then perform public._err('VALIDATION', 'Options must all be different.'); end if;
  if v_key not in ('A', 'B', 'C', 'D') then perform public._err('VALIDATION', 'Choose exactly one correct answer (A–D).'); end if;
  if v_mc is not null and (v_mc < 0 or v_mc > 100) then perform public._err('VALIDATION', 'Marks for a correct answer must be between 0 and 100.'); end if;
  if v_mi is not null and (v_mi < -100 or v_mi > 0) then perform public._err('VALIDATION', 'Marks for an incorrect answer must be between -100 and 0.'); end if;
  if v_id is not null then
    perform 1 from public.questions where id = v_id for update;
    if not found then perform public._err('QUESTION_NOT_FOUND'); end if;
    update public.questions set question_text = v_text, option_a = v_a, option_b = v_b, option_c = v_c, option_d = v_d,
      image_url = v_img, category = v_cat, marks_correct = v_mc, marks_incorrect = v_mi, is_sample = v_sample
    where id = v_id;
    insert into public.question_keys (question_id, correct_option, explanation) values (v_id, v_key, v_expl)
    on conflict (question_id) do update set correct_option = excluded.correct_option, explanation = excluded.explanation;
  else
    perform pg_advisory_xact_lock(hashtext('brainfreze.questions.order'));
    select count(*) into n from public.questions;
    v_pos := nullif(p->>'position', '')::int;
    if v_pos is null or v_pos < 1 or v_pos > n + 1 then v_pos := n + 1; end if;
    update public.questions set position = position + 1 where position >= v_pos;
    insert into public.questions (position, question_text, option_a, option_b, option_c, option_d, image_url, category, marks_correct, marks_incorrect, is_sample)
    values (v_pos, v_text, v_a, v_b, v_c, v_d, v_img, v_cat, v_mc, v_mi, v_sample)
    returning id into v_id;
    insert into public.question_keys (question_id, correct_option, explanation) values (v_id, v_key, v_expl);
  end if;
  -- Published sets keep their snapshot; only the bank (and drafts) change.
  return jsonb_build_object('id', v_id, 'rescored', 0);
end $$;

create or replace function public.delete_question(p_id uuid, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q public.questions; n integer;
begin
  perform public._require_organizer();
  perform public._lock_all_current();
  select * into q from public.questions where id = p_id for update;
  if not found then perform public._err('QUESTION_NOT_FOUND'); end if;
  perform public._assert_not_in_published(p_id);
  -- Archived sets that used it lose this question's answers (audited).
  select count(*) into n from public.team_answers where question_id = p_id;
  if n > 0 and not coalesce(p_confirm, false) then
    perform public._err('QUESTION_HAS_ANSWERS', format('Q%s has %s recorded answer(s) in archived sets. Confirm to delete them too.', q.position, n));
  end if;
  insert into public.score_events (session_id, action, question_position, reason, actor)
  select a.session_id, 'delete_question', q.position, format('Deleted bank Q%s with %s recorded answer(s)', q.position, count(*)), auth.uid()
  from public.team_answers a where a.question_id = p_id group by a.session_id;
  delete from public.questions where id = p_id;
  perform public._renumber_questions();
  return jsonb_build_object('deleted', true);
end $$;

create or replace function public.reorder_questions(p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_organizer();
  perform public._lock_all_current();
  if coalesce(cardinality(p_ids), 0) <> (select count(*) from public.questions)
     or (select count(distinct x) from unnest(p_ids) x) <> cardinality(p_ids)
     or exists (select 1 from unnest(p_ids) x where not exists (select 1 from public.questions q where q.id = x)) then
    perform public._err('VALIDATION', 'Reorder list must contain every question exactly once.');
  end if;
  update public.questions q set position = o.ord from unnest(p_ids) with ordinality as o(id, ord) where q.id = o.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.import_questions(p_items jsonb, p_replace boolean default false, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n_ans integer; item jsonb; i bigint; cnt integer := 0; code text;
begin
  perform public._require_organizer();
  perform public._lock_all_current();
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then perform public._err('VALIDATION', 'No questions to import.'); end if;
  if p_replace then
    perform public._assert_not_in_published(null);
    select count(*) into n_ans from public.team_answers;
    if n_ans > 0 and not coalesce(p_confirm, false) then perform public._err('QUESTION_HAS_ANSWERS', 'Existing questions have recorded answers. Confirm to replace them.'); end if;
    insert into public.score_events (session_id, action, reason, actor)
    select a.session_id, 'delete_question', format('Replaced question bank by import (%s recorded answer(s) removed)', count(*)), auth.uid()
    from public.team_answers a group by a.session_id;
    delete from public.questions where true;
    perform public._renumber_questions();
  end if;
  for item, i in select e, o from jsonb_array_elements(p_items) with ordinality as x(e, o) loop
    begin
      perform public.save_question(((item - 'id') - 'position') - '__line');
    exception when others then
      code := coalesce(substring(sqlerrm from '^([A-Z_]{3,40}):'), 'VALIDATION');
      raise exception using errcode = 'P0001',
        message = code || ': Question ' || coalesce('on line ' || (item->>'__line'), i::text) || ': ' || regexp_replace(sqlerrm, '^[A-Z_]{3,40}:\s*', '');
    end;
    cnt := cnt + 1;
  end loop;
  return jsonb_build_object('imported', cnt);
end $$;

create or replace function public.remove_demo_data(p_teams boolean default true, p_questions boolean default true, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; n_t integer := 0; n_q integer := 0; a_t integer := 0; a_q integer := 0;
begin
  perform public._require_organizer();
  perform public._lock_all_current();
  s := public._lock_current_session();
  if p_teams then
    select count(*) into n_t from public.teams where is_demo and section = s.section;
    select count(*) into a_t from public.team_answers a join public.teams t on t.id = a.team_id where t.is_demo and t.section = s.section;
    if a_t > 0 and not coalesce(p_confirm, false) then perform public._err('TEAM_HAS_ANSWERS', format('Demo teams have %s recorded answer(s). Confirm to delete them too.', a_t)); end if;
    if exists (select 1 from public.team_answers a join public.teams t on t.id = a.team_id join public.quiz_sessions x on x.id = a.session_id
               where t.is_demo and t.section = s.section and x.status = 'finalized') then
      perform public._err('RESULTS_FINALIZED');
    end if;
  end if;
  if p_questions then
    select count(*) into n_q from public.questions where is_sample;
    if exists (select 1 from public.set_questions sq join public.quiz_sessions x on x.id = sq.session_id join public.questions q on q.id = sq.question_id
               where x.is_current and q.is_sample) then
      perform public._err('QUESTION_IN_PUBLISHED_SET', 'Sample questions are used by a published set. Archive it first.');
    end if;
    select count(*) into a_q from public.team_answers a join public.questions q on q.id = a.question_id where q.is_sample;
    if a_q > 0 and not coalesce(p_confirm, false) then perform public._err('QUESTION_HAS_ANSWERS', format('Sample questions have %s recorded answer(s). Confirm to delete them too.', a_q)); end if;
  end if;
  insert into public.score_events (session_id, action, reason, actor)
  select a.session_id, 'delete_team', format('Removed %s demo teams (%s recorded answer(s))', s.section, count(*)), auth.uid()
  from public.team_answers a join public.teams t on t.id = a.team_id where p_teams and t.is_demo and t.section = s.section group by a.session_id;
  insert into public.score_events (session_id, action, reason, actor)
  select a.session_id, 'delete_question', format('Removed sample questions (%s recorded answer(s))', count(*)), auth.uid()
  from public.team_answers a join public.questions q on q.id = a.question_id where p_questions and q.is_sample group by a.session_id;
  if p_teams then delete from public.teams where is_demo and section = s.section; end if;
  if p_questions then delete from public.questions where is_sample; perform public._renumber_questions(); end if;
  return jsonb_build_object('removedTeams', n_t, 'removedQuestions', n_q);
end $$;

-- Deleting a team removes its answers in every set (audited per set).
create or replace function public.delete_team(p_id uuid, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.teams; n integer; pts numeric;
begin
  perform public._require_organizer();
  perform public._lock_all_current();
  select * into t from public.teams where id = p_id for update;
  if not found then perform public._err('TEAM_NOT_FOUND'); end if;
  if exists (select 1 from public.quiz_sessions s where s.status = 'finalized' and p_id = any (s.qualifiers)) then
    perform public._err('RESULTS_FINALIZED');
  end if;
  select count(*), coalesce(sum(points), 0) into n, pts from public.team_answers where team_id = p_id;
  if n > 0 and not coalesce(p_confirm, false) then
    perform public._err('TEAM_HAS_ANSWERS', format('Team %s has %s recorded answer(s). Confirm to delete them too.', t.team_number, n));
  end if;
  if exists (select 1 from public.team_answers a join public.quiz_sessions s on s.id = a.session_id where a.team_id = p_id and s.status = 'finalized') then
    perform public._err('RESULTS_FINALIZED');
  end if;
  insert into public.score_events (session_id, action, team_number, prev_points, reason, actor)
  select a.session_id, 'delete_team', t.team_number, sum(a.points), format('Deleted %s team "%s" with %s recorded answer(s)', t.section, t.team_name, count(*)), auth.uid()
  from public.team_answers a where a.team_id = p_id group by a.session_id;
  delete from public.teams where id = p_id;
  return jsonb_build_object('deleted', true);
end $$;

-- ===========================================================================
-- Participants
-- ===========================================================================
create or replace function public.join_lookup(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text := public._client_key(); s public.quiz_sessions; st public.quiz_settings;
begin
  if public._join_rate_limited(k) then return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED'); end if;
  s := public._quiz_by_code(p_code);
  if s.id is null then
    perform public._log_join_attempt(k, 'code', false);
    return jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  end if;
  st := public._settings(s.id);
  return jsonb_build_object('ok', true, 'quiz', jsonb_build_object(
    'title', s.name, 'description', s.description, 'status', s.status, 'section', s.section,
    'duration_seconds', st.duration_seconds, 'total_questions', public._session_question_count(s),
    'registration_open', s.registration_open, 'self_registration', s.self_registration and s.registration_open));
end $$;

create or replace function public.join_team(p_code text, p_team_number integer, p_pin text, p_device_label text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text := public._client_key(); s public.quiz_sessions; t public.teams; v_pin text; ps public.participant_sessions; tok text; v_other text;
begin
  if public._join_rate_limited(k) then return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED'); end if;
  s := public._quiz_by_code(p_code);
  if s.id is null then
    perform public._log_join_attempt(k, 'code', false);
    return jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  end if;
  perform 1 from public.quiz_sessions where id = s.id for update; -- serialize joins
  select * into t from public.teams where team_number = p_team_number and section = s.section;
  select pin into v_pin from public.team_credentials where team_id = t.id;
  if t.id is null or v_pin is null or v_pin <> upper(btrim(coalesce(p_pin, ''))) then
    perform public._log_join_attempt(k, 'pin', false);
    return jsonb_build_object('ok', false, 'error', 'INVALID_TEAM_OR_PIN');
  end if;
  v_other := public._team_other_set(s, t.id);
  if v_other is not null then return jsonb_build_object('ok', false, 'error', 'TEAM_IN_OTHER_SET'); end if;
  if not s.registration_open and public._active_attempt(s.id, t.id) is null then
    return jsonb_build_object('ok', false, 'error', 'REGISTRATION_CLOSED');
  end if;
  select * into ps from public.participant_sessions where session_id = s.id and team_id = t.id and revoked_at is null for update;
  if found then
    if ps.last_seen_at > now() - interval '45 seconds' and ps.expires_at > now() then
      return jsonb_build_object('ok', false, 'error', 'TEAM_ALREADY_CONNECTED');
    end if;
    update public.participant_sessions set revoked_at = now(), revoked_reason = 'Replaced by a new device sign-in' where id = ps.id;
  end if;
  -- Create the team's attempt once; a reconnecting team resumes the same attempt.
  if (public._active_attempt(s.id, t.id)).id is null then perform public._make_attempt(s, t.id); end if;
  tok := public._open_participant_session(s, t, p_device_label);
  return jsonb_build_object('ok', true, 'token', tok, 'team', public._team_public(t), 'quiz_title', s.name, 'section', s.section);
end $$;

create or replace function public.register_team(p_code text, p_team_name text, p_participant_1 text, p_participant_2 text,
  p_college_name text, p_device_label text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k text := public._client_key(); s public.quiz_sessions; t public.teams; tok text; v_num integer;
  v_name text := public._clean(p_team_name); v_p1 text := public._clean(p_participant_1); v_p2 text := public._clean(p_participant_2);
  v_college text := public._clean(p_college_name);
begin
  if public._join_rate_limited(k) then return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED'); end if;
  s := public._quiz_by_code(p_code);
  if s.id is null then
    perform public._log_join_attempt(k, 'code', false);
    return jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  end if;
  perform 1 from public.quiz_sessions where id = s.id for update;
  if not (s.registration_open and s.self_registration) then return jsonb_build_object('ok', false, 'error', 'SELF_REGISTRATION_CLOSED'); end if;
  if v_name is null or char_length(v_name) > 80 or v_p1 is null or v_p2 is null or char_length(v_p1) > 80 or char_length(v_p2) > 80
     or v_college is null or char_length(v_college) > 120 then
    return jsonb_build_object('ok', false, 'error', 'VALIDATION', 'message', 'Team name, both participant names and the college name are required.');
  end if;
  if exists (select 1 from public.teams where section = s.section and lower(team_name) = lower(v_name)) then
    perform public._log_join_attempt(k, 'register', false);
    return jsonb_build_object('ok', false, 'error', 'TEAM_NAME_TAKEN');
  end if;
  if (select count(*) from public.teams where section = s.section) >= 50 then return jsonb_build_object('ok', false, 'error', 'TEAM_CAPACITY'); end if;
  select min(n) into v_num from generate_series(1, 999) n
  where not exists (select 1 from public.teams x where x.section = s.section and x.team_number = n);
  insert into public.teams (section, team_number, team_name, participant_1, participant_2, college_name, self_registered)
  values (s.section, v_num, v_name, v_p1, v_p2, v_college, true) returning * into t;
  insert into public.registration_events (team_id, section, team_number, action, actor_role)
  values (t.id, s.section, v_num, 'create', 'registration');
  perform public._make_attempt(s, t.id);
  tok := public._open_participant_session(s, t, p_device_label);
  return jsonb_build_object('ok', true, 'token', tok, 'team', public._team_public(t), 'quiz_title', s.name, 'section', s.section,
    'pin', (select pin from public.team_credentials where team_id = t.id));
end $$;

-- The team's attempt: status, server times, and (while running) one question in
-- the team's own order with options in the team's own order. Never keys or points.
create or replace function public.participant_state(p_token text, p_position integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ps public.participant_sessions; s public.quiz_sessions; st public.quiz_settings; t public.teams; a public.quiz_attempts;
  q record; ans public.team_answers; total integer; res jsonb; r record; revoked public.participant_sessions;
  v_pos integer; v_progress jsonb; v_perm text; v_clock timestamptz; v_shown text;
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
  perform public._finalize_expired(s);
  a := public._active_attempt(s.id, t.id);
  -- After an organizer reset the team gets a fresh attempt (new order) on its next check-in.
  if a.id is null and s.status in ('setup', 'running', 'paused') then a := public._make_attempt(s, t.id); end if;
  st := public._settings(s.id);
  total := public._session_question_count(s);
  v_clock := public._clock(s);
  res := jsonb_build_object(
    'ok', true, 'server_now', now(),
    'team', public._team_public(t),
    'quiz', jsonb_build_object('title', s.name, 'description', s.description, 'status', s.status, 'section', s.section,
      'self_paced', true, 'registration_open', s.registration_open, 'total_questions', total,
      'duration_seconds', st.duration_seconds, 'results_revealed', s.results_revealed,
      'marks', jsonb_build_object('correct', st.marks_correct, 'incorrect', st.marks_incorrect, 'unanswered', st.marks_unanswered)),
    'attempt', jsonb_build_object('status', coalesce(a.status, 'none'), 'started_at', a.started_at, 'deadline_at', a.deadline_at,
      'finished_at', a.finished_at, 'paused', s.status = 'paused',
      'remaining_ms', case when a.status = 'in_progress' then greatest(0, floor(extract(epoch from (a.deadline_at - v_clock)) * 1000))::bigint end),
    -- legacy timer shape used by older clients
    'timer', jsonb_build_object('status', s.status, 'elapsed_ms', s.elapsed_ms, 'timer_started_at', s.timer_started_at,
      'duration_seconds', st.duration_seconds));
  if a.status = 'in_progress' and s.status = 'running' and total > 0 then
    select coalesce(jsonb_agg(exists (select 1 from public.team_answers x
             where x.session_id = s.id and x.team_id = t.id and x.question_id = o.qid) order by o.i), '[]'::jsonb)
      into v_progress from unnest(a.question_order) with ordinality as o(qid, i);
    v_pos := p_position;
    if v_pos is null or v_pos < 0 or v_pos >= cardinality(a.question_order) then
      select coalesce(min(i - 1), 0) into v_pos from jsonb_array_elements(v_progress) with ordinality as x(v, i) where x.v = 'false'::jsonb;
    end if;
    v_perm := a.option_orders[v_pos + 1];
    select * into q from public._set_question(s, a.question_order[v_pos + 1]);
    select * into ans from public.team_answers where session_id = s.id and team_id = t.id and question_id = q.id;
    v_shown := case when ans.selected_option is null then null
                    else coalesce(ans.displayed_option, chr(64 + position(ans.selected_option in v_perm))) end;
    res := res || jsonb_build_object(
      'question', jsonb_build_object('id', q.id, 'number', v_pos + 1, 'question_text', q.question_text,
        'option_a', case substr(v_perm, 1, 1) when 'A' then q.option_a when 'B' then q.option_b when 'C' then q.option_c else q.option_d end,
        'option_b', case substr(v_perm, 2, 1) when 'A' then q.option_a when 'B' then q.option_b when 'C' then q.option_c else q.option_d end,
        'option_c', case substr(v_perm, 3, 1) when 'A' then q.option_a when 'B' then q.option_b when 'C' then q.option_c else q.option_d end,
        'option_d', case substr(v_perm, 4, 1) when 'A' then q.option_a when 'B' then q.option_b when 'C' then q.option_c else q.option_d end,
        'image_url', q.image_url),
      'position', v_pos, 'progress', v_progress, 'question_closed', false,
      'my_answer', case when ans.id is null then null
        else jsonb_build_object('selected', v_shown, 'submitted_at', ans.created_at, 'source', ans.source) end);
  end if;
  if s.status = 'finalized' and s.results_revealed then
    select x.rank, x.points into r from public._standings(s.id) x where x.team_id = t.id;
    res := res || jsonb_build_object('result', jsonb_build_object('rank', r.rank, 'points', r.points, 'qualified', t.id = any (s.qualifiers)));
  end if;
  return res;
end $$;

-- The team presses Start: the database records the start and the deadline (idempotent).
create or replace function public.participant_start(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ps public.participant_sessions; s public.quiz_sessions; st public.quiz_settings; a public.quiz_attempts;
begin
  ps := public._participant_session(p_token);
  if ps.id is null then return jsonb_build_object('ok', false, 'error', 'SESSION_INVALID'); end if;
  select * into s from public.quiz_sessions where id = ps.session_id for update;
  if s.status <> 'running' then return jsonb_build_object('ok', false, 'error', 'NOT_STARTED_YET'); end if;
  select * into a from public.quiz_attempts where session_id = s.id and team_id = ps.team_id and status <> 'reset' for update;
  if not found then a := public._make_attempt(s, ps.team_id); end if;
  if a.status = 'ready' then
    st := public._settings(s.id);
    update public.quiz_attempts set status = 'in_progress', started_at = now(),
      deadline_at = now() + make_interval(secs => st.duration_seconds)
    where id = a.id returning * into a;
  end if;
  return jsonb_build_object('ok', true, 'status', a.status, 'started_at', a.started_at, 'deadline_at', a.deadline_at, 'server_now', now());
end $$;

-- p_option is the letter the team SAW; it is mapped back to the original option for scoring.
create or replace function public.participant_submit(p_token text, p_request_id uuid, p_question_id uuid, p_option text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ps public.participant_sessions; s public.quiz_sessions; st public.quiz_settings; t public.teams; a public.quiz_attempts;
  ev public.score_events; ex public.team_answers; v_i integer; v_shown text := upper(btrim(coalesce(p_option, ''))); v_orig text;
begin
  ps := public._participant_session(p_token);
  if ps.id is null then return jsonb_build_object('ok', false, 'error', 'SESSION_INVALID'); end if;
  if p_request_id is null or p_question_id is null then return jsonb_build_object('ok', false, 'error', 'VALIDATION'); end if;
  select * into s from public.quiz_sessions where id = ps.session_id for update; -- same lock as organizer scoring
  -- Idempotent retry: the original outcome, only for the team that made it.
  select * into ev from public.score_events where request_id = p_request_id;
  if found then
    if ev.team_id = ps.team_id and ev.source = 'participant' then
      select * into ex from public.team_answers where session_id = s.id and team_id = ps.team_id and question_id = ev.question_id;
      return jsonb_build_object('ok', true, 'duplicate_request', true, 'selected', coalesce(ex.displayed_option, ev.new_selected), 'question_id', ev.question_id);
    end if;
    return jsonb_build_object('ok', false, 'error', 'VALIDATION');
  end if;
  perform public._finalize_expired(s);
  select * into a from public.quiz_attempts where session_id = s.id and team_id = ps.team_id and status <> 'reset' for update;
  if not found or a.status = 'ready' then return jsonb_build_object('ok', false, 'error', 'NOT_STARTED_YET'); end if;
  if a.status = 'timed_out' then return jsonb_build_object('ok', false, 'error', 'TIME_EXPIRED'); end if;
  if a.status <> 'in_progress' then return jsonb_build_object('ok', false, 'error', 'ATTEMPT_FINISHED'); end if;
  if s.status <> 'running' then return jsonb_build_object('ok', false, 'error', 'NOT_ACCEPTING'); end if;
  if now() >= a.deadline_at then return jsonb_build_object('ok', false, 'error', 'TIME_EXPIRED'); end if;
  v_i := array_position(a.question_order, p_question_id);
  if v_i is null then return jsonb_build_object('ok', false, 'error', 'QUESTION_NOT_IN_QUIZ'); end if;
  if v_shown not in ('A', 'B', 'C', 'D') then return jsonb_build_object('ok', false, 'error', 'INVALID_OPTION'); end if;
  v_orig := substr(a.option_orders[v_i], ascii(v_shown) - 64, 1);
  select * into ex from public.team_answers where session_id = s.id and team_id = ps.team_id and question_id = p_question_id;
  if found then
    return jsonb_build_object('ok', false, 'error', 'ALREADY_SUBMITTED', 'selected',
      coalesce(ex.displayed_option, chr(64 + position(ex.selected_option in a.option_orders[v_i]))));
  end if;
  st := public._settings(s.id);
  select * into t from public.teams where id = ps.team_id;
  perform public._record(s, st, t, p_question_id, v_orig, p_request_id, false, null, 'participant', a.id, v_shown, true);
  -- Deliberately no result/points: correctness is never revealed here.
  return jsonb_build_object('ok', true, 'duplicate_request', false, 'selected', v_shown, 'question_id', p_question_id, 'submitted_at', now());
end $$;

-- The team submits the whole quiz early: the server records the final time (idempotent).
create or replace function public.participant_finish(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ps public.participant_sessions; s public.quiz_sessions; a public.quiz_attempts;
begin
  ps := public._participant_session(p_token);
  if ps.id is null then return jsonb_build_object('ok', false, 'error', 'SESSION_INVALID'); end if;
  select * into s from public.quiz_sessions where id = ps.session_id for update;
  perform public._finalize_expired(s);
  select * into a from public.quiz_attempts where session_id = s.id and team_id = ps.team_id and status <> 'reset' for update;
  if not found or a.status = 'ready' then return jsonb_build_object('ok', false, 'error', 'NOT_STARTED_YET'); end if;
  if a.status = 'in_progress' then
    if s.status <> 'running' then return jsonb_build_object('ok', false, 'error', 'NOT_ACCEPTING'); end if;
    update public.quiz_attempts set status = 'submitted', finished_at = now() where id = a.id returning * into a;
  end if;
  return jsonb_build_object('ok', true, 'status', a.status, 'finished_at', a.finished_at);
end $$;

-- ===========================================================================
-- Registration desk: a team locks once it has started a quiz; new teams can always be added
-- ===========================================================================
create or replace function public._team_started(p_team uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.quiz_attempts a join public.quiz_sessions s on s.id = a.session_id
                 where a.team_id = p_team and s.is_current and a.status not in ('reset', 'ready'))
      or exists (select 1 from public.team_answers a join public.quiz_sessions s on s.id = a.session_id
                 where a.team_id = p_team and s.is_current);
$$;

create or replace function public.reg_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_registrar();
  return jsonb_build_object(
    'server_now', now(),
    'capacity', 50,
    'sections', (
      select jsonb_agg(jsonb_build_object('section', sec, 'team_count', (select count(*) from public.teams t where t.section = sec),
        'live_sets', (select count(*) from public.quiz_sessions x where x.is_current and x.section = sec and x.status in ('running', 'paused')),
        'locked', false) order by sec)
      from unnest(array['PG', 'UG']) sec),
    'teams', (
      select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'section', t.section, 'team_number', t.team_number,
        'team_name', t.team_name, 'participant_1', t.participant_1, 'participant_2', t.participant_2,
        'college_name', t.college_name, 'pin', c.pin, 'self_registered', t.self_registered, 'is_demo', t.is_demo,
        'locked', public._team_started(t.id), 'updated_at', t.updated_at) order by t.section, t.team_number), '[]'::jsonb)
      from public.teams t left join public.team_credentials c on c.team_id = t.id));
end $$;

create or replace function public.reg_save_team(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p->>'id', '')::uuid; old public.teams; v_new text; res jsonb;
begin
  perform public._require_registrar();
  if v_id is not null then
    select * into old from public.teams where id = v_id for update;
    if not found then perform public._err('TEAM_NOT_FOUND'); end if;
    if public._team_started(v_id) then
      perform public._err('REGISTRATION_LOCKED', format('%s team %s has started a quiz, so its registration is locked. Ask an organizer.', old.section, old.team_number));
    end if;
  end if;
  v_new := upper(btrim(coalesce(p->>'section', old.section, '')));
  if v_new not in ('UG', 'PG') then perform public._err('VALIDATION', 'Choose the section (UG or PG).'); end if;
  res := public._upsert_team((p - 'is_demo') || jsonb_build_object('section', v_new),
    case when public.is_organizer() then 'organizer' else 'registration' end, v_new);
  return res || jsonb_build_object('pin', (select pin from public.team_credentials where team_id = (res->>'id')::uuid));
end $$;

-- ===========================================================================
-- Backup restore: format 3 (any number of sets, frozen questions, attempts);
-- formats 1–2 still restore.
-- ===========================================================================
create or replace function public.restore_backup(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ver integer; v_sessions jsonb; item jsonb; sess jsonb; v_sid uuid; v_status text; v_section text; v_ids uuid[] := '{}';
  v_frozen timestamptz; v_shift bigint;
begin
  perform public._require_organizer();
  v_ver := case when (p->>'format_version') ~ '^[0-9]+$' then (p->>'format_version')::int end;
  if p->>'app' is distinct from 'brainfreze-cold-start' or v_ver is null or v_ver not in (1, 2, 3) then
    perform public._err('INVALID_BACKUP');
  end if;
  if jsonb_typeof(p->'teams') <> 'array' or jsonb_typeof(p->'questions') <> 'array' then perform public._err('INVALID_BACKUP'); end if;
  if v_ver = 1 then
    if jsonb_typeof(p->'session') <> 'object' then perform public._err('INVALID_BACKUP'); end if;
    v_sessions := jsonb_build_array(jsonb_build_object('session', (p->'session') || '{"section": "UG"}'::jsonb, 'settings', coalesce(p->'settings', '{}'::jsonb)));
  else
    v_sessions := p->'sessions';
    if jsonb_typeof(v_sessions) <> 'array' or jsonb_array_length(v_sessions) = 0 then perform public._err('INVALID_BACKUP'); end if;
  end if;
  perform pg_advisory_xact_lock(hashtext('brainfreze.session'));
  insert into public.retired_join_codes (code) select join_code from public.quiz_sessions where join_code is not null on conflict do nothing;
  delete from public.quiz_sessions where true;
  delete from public.questions where true;
  delete from public.teams where true;

  insert into public.teams (id, section, team_number, team_name, participant_1, participant_2, college_name, is_demo, self_registered, created_at)
  select x.id, upper(coalesce(x.section, 'UG')), x.team_number, x.team_name, x.participant_1, x.participant_2, x.college_name,
         coalesce(x.is_demo, false), coalesce(x.self_registered, false), coalesce(x.created_at, now())
  from jsonb_to_recordset(p->'teams') as x(id uuid, section text, team_number int, team_name text, participant_1 text, participant_2 text,
       college_name text, is_demo boolean, self_registered boolean, created_at timestamptz);
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

  for item in select e from jsonb_array_elements(v_sessions) as x(e) loop
    sess := item->'session';
    if jsonb_typeof(sess) <> 'object' then perform public._err('INVALID_BACKUP'); end if;
    v_section := upper(coalesce(sess->>'section', 'UG'));
    if v_section not in ('UG', 'PG') then perform public._err('INVALID_BACKUP', 'Unknown section.'); end if;
    v_status := sess->>'status';
    v_sid := (sess->>'id')::uuid;
    insert into public.quiz_sessions (id, section, self_paced, name, description, question_ids, self_registration, is_current, archived_at, status, current_index,
      completed_question_ids, started_at, timer_started_at, elapsed_ms, ended_at, corrections_enabled, projector_view, results_revealed,
      qualifiers, qualifiers_confirmed_at, qualification_note, published_at, published_by, created_at)
    values (v_sid, v_section, true, coalesce(sess->>'name', 'COLD START'), sess->>'description',
      case when jsonb_typeof(sess->'question_ids') = 'array'
        then array(select y from (select (jsonb_array_elements_text(sess->'question_ids'))::uuid as y) z where exists (select 1 from public.questions q where q.id = z.y)) end,
      coalesce((sess->>'self_registration')::boolean, false),
      coalesce((sess->>'is_current')::boolean, true), (sess->>'archived_at')::timestamptz,
      case when v_status in ('running', 'paused') then 'paused' else v_status end,
      coalesce((sess->>'current_index')::int, 0),
      coalesce(array(select (jsonb_array_elements_text(sess->'completed_question_ids'))::uuid), '{}'),
      (sess->>'started_at')::timestamptz, null,
      coalesce((sess->>'elapsed_ms')::numeric::bigint, 0), (sess->>'ended_at')::timestamptz,
      coalesce((sess->>'corrections_enabled')::boolean, false),
      case when coalesce(sess->>'projector_view', 'standby') = 'reveal' and not coalesce((sess->>'results_revealed')::boolean, false) then 'standby' else coalesce(sess->>'projector_view', 'standby') end,
      coalesce((sess->>'results_revealed')::boolean, false),
      case when jsonb_typeof(sess->'qualifiers') = 'array' then array(select (jsonb_array_elements_text(sess->'qualifiers'))::uuid) end,
      (sess->>'qualifiers_confirmed_at')::timestamptz, sess->>'qualification_note',
      -- a restored set keeps its frozen snapshot (so stays "published") but never an active code
      case when jsonb_typeof(item->'set_questions') = 'array' and jsonb_array_length(item->'set_questions') > 0 then coalesce((sess->>'published_at')::timestamptz, now()) end,
      (sess->>'published_by')::uuid,
      coalesce((sess->>'created_at')::timestamptz, now()));
    update public.quiz_sessions set paused_at = case when status = 'paused' then now() end where id = v_sid;
    insert into public.quiz_settings (session_id, duration_seconds, marks_correct, marks_incorrect, marks_unanswered, qualify_count, accuracy_tiebreak)
    select v_sid, coalesce(x.duration_seconds, 1800), coalesce(x.marks_correct, 1), coalesce(x.marks_incorrect, -0.25),
           coalesce(x.marks_unanswered, 0), coalesce(x.qualify_count, 5), coalesce(x.accuracy_tiebreak, true)
    from jsonb_to_record(coalesce(item->'settings', '{}'::jsonb)) as x(duration_seconds int, marks_correct numeric, marks_incorrect numeric,
         marks_unanswered numeric, qualify_count int, accuracy_tiebreak boolean);
    insert into public.set_questions (session_id, question_id, position, question_text, option_a, option_b, option_c, option_d,
      image_url, category, correct_option, explanation, marks_correct, marks_incorrect)
    select v_sid, x.question_id, x.position, x.question_text, x.option_a, x.option_b, x.option_c, x.option_d, x.image_url, x.category,
           upper(x.correct_option), x.explanation, x.marks_correct, x.marks_incorrect
    from jsonb_to_recordset(coalesce(item->'set_questions', '[]'::jsonb)) as x(question_id uuid, position int, question_text text,
         option_a text, option_b text, option_c text, option_d text, image_url text, category text, correct_option text, explanation text,
         marks_correct numeric, marks_incorrect numeric)
    where exists (select 1 from public.questions q where q.id = x.question_id);
    -- Restored running attempts stay running (their deadlines are extended on resume, as for a pause).
    insert into public.quiz_attempts (id, session_id, team_id, status, question_order, option_orders, created_at, started_at, deadline_at,
      paused_ms, finished_at, finalized_by, finalize_reason, reset_at, reset_by, reset_reason)
    select x.id, v_sid, x.team_id, x.status, x.question_order, x.option_orders, coalesce(x.created_at, now()), x.started_at, x.deadline_at,
           coalesce(x.paused_ms, 0), x.finished_at, x.finalized_by, x.finalize_reason, x.reset_at, x.reset_by, x.reset_reason
    from jsonb_to_recordset(coalesce(item->'attempts', '[]'::jsonb)) as x(id uuid, team_id uuid, status text, question_order uuid[], option_orders text[],
         created_at timestamptz, started_at timestamptz, deadline_at timestamptz, paused_ms bigint, finished_at timestamptz, finalized_by uuid,
         finalize_reason text, reset_at timestamptz, reset_by uuid, reset_reason text)
    where exists (select 1 from public.teams t where t.id = x.team_id);
    -- The time since a restored live set's clocks last ran (its pause, else the export) counts as paused time.
    if v_status in ('running', 'paused') then
      v_frozen := case when v_status = 'paused' then coalesce((sess->>'paused_at')::timestamptz, (p->>'exported_at')::timestamptz)
                       else (p->>'exported_at')::timestamptz end;
      v_shift := greatest(0, floor(extract(epoch from (now() - coalesce(v_frozen, now()))) * 1000))::bigint;
      update public.quiz_attempts set deadline_at = deadline_at + make_interval(secs => v_shift / 1000.0), paused_ms = paused_ms + v_shift
      where session_id = v_sid and status = 'in_progress';
    end if;
    v_ids := v_ids || v_sid;
  end loop;

  insert into public.team_answers (session_id, team_id, question_id, selected_option, result, points, source, attempt_id, displayed_option, on_time, created_at)
  select x.session_id, x.team_id, x.question_id, x.selected_option, x.result, x.points, coalesce(x.source, 'organizer'),
         case when exists (select 1 from public.quiz_attempts a where a.id = x.attempt_id) then x.attempt_id end,
         x.displayed_option, x.on_time, coalesce(x.created_at, now())
  from jsonb_to_recordset(coalesce(p->'answers', '[]'::jsonb)) as x(session_id uuid, team_id uuid, question_id uuid, selected_option text, result text,
       points numeric, source text, attempt_id uuid, displayed_option text, on_time boolean, created_at timestamptz)
  where x.session_id = any (v_ids);

  insert into public.tiebreak_results (session_id, team_id, score, note)
  select x.session_id, x.team_id, x.score, x.note
  from jsonb_to_recordset(coalesce(p->'tiebreaks', '[]'::jsonb)) as x(session_id uuid, team_id uuid, score numeric, note text)
  where x.session_id = any (v_ids);

  insert into public.score_events (id, session_id, request_id, action, team_id, team_number, question_id, question_position,
    prev_selected, prev_result, prev_points, new_selected, new_result, new_points, undone, undo_of, reason, actor, source, created_at)
  select x.id, x.session_id, x.request_id, x.action,
    case when exists (select 1 from public.teams t where t.id = x.team_id) then x.team_id end, x.team_number,
    case when exists (select 1 from public.questions q where q.id = x.question_id) then x.question_id end, x.question_position,
    x.prev_selected, x.prev_result, x.prev_points, x.new_selected, x.new_result, x.new_points, coalesce(x.undone, false), x.undo_of,
    x.reason, null, coalesce(x.source, 'organizer'), coalesce(x.created_at, now())
  from jsonb_to_recordset(coalesce(p->'events', '[]'::jsonb)) as x(id bigint, session_id uuid, request_id uuid, action text, team_id uuid, team_number int,
       question_id uuid, question_position int, prev_selected text, prev_result text, prev_points numeric, new_selected text, new_result text,
       new_points numeric, undone boolean, undo_of bigint, reason text, source text, created_at timestamptz)
  where x.session_id = any (v_ids)
  order by x.id;
  perform setval(pg_get_serial_sequence('public.score_events', 'id'), greatest(coalesce((select max(id) from public.score_events), 0), 1));

  insert into public.score_events (session_id, action, reason, actor)
  select x, 'restore', 'Restored backup exported ' || coalesce(p->>'exported_at', 'at unknown time'), auth.uid() from unnest(v_ids) x;
  perform public._lock_section_session('UG');
  perform public._lock_section_session('PG');
  perform public._renumber_questions();
  return jsonb_build_object('ok', true);
end $$;

-- ===========================================================================
-- Security: RLS, grants, function permissions
-- ===========================================================================
alter table public.set_questions enable row level security;
alter table public.quiz_attempts enable row level security;
revoke all on public.set_questions, public.quiz_attempts from anon, authenticated, public;
grant select on public.set_questions, public.quiz_attempts to authenticated;
drop policy if exists set_questions_organizer_read on public.set_questions;
create policy set_questions_organizer_read on public.set_questions for select to authenticated using ((select public.is_organizer()));
drop policy if exists quiz_attempts_organizer_read on public.quiz_attempts;
create policy quiz_attempts_organizer_read on public.quiz_attempts for select to authenticated using ((select public.is_organizer()));

do $$
begin
  -- Organizers see attempt changes live; set_questions (keys) is deliberately not published.
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'quiz_attempts') then
    alter publication supabase_realtime add table public.quiz_attempts;
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
  public.set_registration(boolean), public.revoke_participant(uuid), public.rotate_team_pin(uuid),
  public.create_set(jsonb), public.duplicate_set(uuid), public.delete_set(uuid), public.archive_set(uuid, text),
  public.revoke_join_code(), public.finalize_expired_attempts(), public.finalize_attempt(uuid, text),
  public.reset_attempt(uuid, text), public.correct_set_question(uuid, jsonb, text), public.get_set_results()
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

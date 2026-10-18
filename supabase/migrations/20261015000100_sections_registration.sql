-- BRAINFREZE — COLD START · UG/PG sections, registration desk, per-team shuffling
-- (migration 5). Run AFTER the four earlier migrations. Re-runnable.
--
-- Adds
--   * Sections: every team and every quiz session belongs to UG or PG. Each
--     section has its own current quiz session (and so its own six-digit join
--     code). Team numbers are unique within a section; 50 teams per section.
--   * Organizer RPCs keep their signatures. They act on the section named by
--     the `x-brainfreze-section` request header (UG when absent). Participant
--     RPCs ignore the header: their section comes from the join code / token.
--   * Teams gain a required college name (existing rows keep NULL until edited).
--   * Registration staff (public.registration_staff): a separate role that can
--     create, view and edit teams while that section's quiz is still in setup.
--     Staff cannot read any table and cannot call any organizer RPC.
--   * public.registration_events: append-only log of every team create/edit.
--   * Self-paced mode (default for new and existing sessions): each team gets
--     its own stable shuffled question order and answers at its own pace within
--     the shared timer. Organizer-paced mode (one shared current question) is
--     still available via update_quiz_details({self_paced: false}).
--
-- Data changes made by this migration: existing teams/sessions get section
-- 'UG' (column default); existing sessions become self-paced; a PG session is
-- created. No rows are deleted.

-- ===========================================================================
-- Schema
-- ===========================================================================
alter table public.quiz_sessions add column if not exists section text not null default 'UG';
alter table public.quiz_sessions add column if not exists self_paced boolean not null default true;
alter table public.teams add column if not exists section text not null default 'UG';
alter table public.teams add column if not exists college_name text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'quiz_sessions_section_ck') then
    alter table public.quiz_sessions add constraint quiz_sessions_section_ck check (section in ('UG', 'PG'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'teams_section_ck') then
    alter table public.teams add constraint teams_section_ck check (section in ('UG', 'PG'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'teams_college_ck') then
    alter table public.teams add constraint teams_college_ck
      check (college_name is null or char_length(btrim(college_name)) between 1 and 120);
  end if;
  -- Team numbers: unique per section instead of globally.
  if exists (select 1 from pg_constraint where conname = 'teams_team_number_key') then
    alter table public.teams drop constraint teams_team_number_key;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'teams_section_number_key') then
    alter table public.teams add constraint teams_section_number_key unique (section, team_number);
  end if;
end $$;

-- One current session PER SECTION (was: one current session overall). Same index
-- name, so re-running migration 1 (create ... if not exists) leaves it alone.
-- (Skipped once migration 6 — quiz sets, any number per section — has run.)
do $$
begin
  if to_regclass('public.quiz_attempts') is null then
    drop index if exists public.quiz_sessions_one_current;
    create unique index quiz_sessions_one_current on public.quiz_sessions (section) where is_current;
  end if;
end $$;

insert into public.quiz_sessions (is_current, section)
select true, 'PG' where not exists (select 1 from public.quiz_sessions where is_current and section = 'PG');
insert into public.quiz_sessions (is_current, section)
select true, 'UG' where not exists (select 1 from public.quiz_sessions where is_current and section = 'UG');
insert into public.quiz_settings (session_id)
select s.id from public.quiz_sessions s
where s.is_current and not exists (select 1 from public.quiz_settings x where x.session_id = s.id);

-- 50 teams per section (advisory lock serializes concurrent inserts/moves).
create or replace function public.tg_teams_capacity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.section = old.section then return new; end if;
  perform pg_advisory_xact_lock(hashtext('brainfreze.teams.capacity.' || new.section));
  if (select count(*) from public.teams where section = new.section) >= 50 then
    raise exception using errcode = 'P0001', message = 'TEAM_CAPACITY: The 50-team capacity for the ' || new.section || ' section has been reached.';
  end if;
  return new;
end $$;
drop trigger if exists teams_capacity on public.teams;
create trigger teams_capacity before insert or update of section on public.teams
  for each row execute function public.tg_teams_capacity();

-- Registration staff: may manage team registrations only.
-- Add one with:  insert into public.registration_staff (user_id, display_name)
--                select id, 'Registration desk' from auth.users where email = 'desk@example.com';
create table if not exists public.registration_staff (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 80),
  created_at   timestamptz not null default now()
);

-- Append-only history of registration changes (who created/edited which team).
create table if not exists public.registration_events (
  id          bigint generated always as identity primary key,
  team_id     uuid references public.teams (id) on delete set null,
  section     text not null check (section in ('UG', 'PG')),
  team_number integer,
  action      text not null check (action in ('create', 'update')),
  changes     jsonb not null default '{}'::jsonb,
  actor       uuid,
  actor_role  text not null check (actor_role in ('organizer', 'registration')),
  created_at  timestamptz not null default now()
);
create index if not exists registration_events_team_idx on public.registration_events (team_id);

create or replace function public.tg_registration_events_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'AUDIT_IMMUTABLE: Registration history cannot be deleted.';
  end if;
  -- Only ON DELETE SET NULL of team_id is allowed.
  if new.id <> old.id or new.section <> old.section or new.team_number is distinct from old.team_number
     or new.action <> old.action or new.changes <> old.changes or new.actor is distinct from old.actor
     or new.actor_role <> old.actor_role or new.created_at <> old.created_at
     or (new.team_id is not null and new.team_id is distinct from old.team_id) then
    raise exception using errcode = 'P0001', message = 'AUDIT_IMMUTABLE: Registration history is append-only.';
  end if;
  return new;
end $$;
drop trigger if exists registration_events_append_only on public.registration_events;
create trigger registration_events_append_only before update or delete on public.registration_events
  for each row execute function public.tg_registration_events_append_only();

-- ===========================================================================
-- Section selection and locking
-- ===========================================================================
-- The organizer's selected section, from the x-brainfreze-section request header.
create or replace function public._current_section() returns text
language plpgsql stable set search_path = '' as $$
declare h json; v text;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then h := null;
  end;
  v := upper(btrim(coalesce(h->>'x-brainfreze-section', '')));
  if v = '' then return 'UG'; end if;
  if v not in ('UG', 'PG') then perform public._err('VALIDATION', 'Unknown quiz section.'); end if;
  return v;
end $$;

create or replace function public._lock_section_session(p_section text) returns public.quiz_sessions
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  select * into s from public.quiz_sessions where is_current and section = p_section for update;
  if not found then
    perform pg_advisory_xact_lock(hashtext('brainfreze.session.' || p_section));
    select * into s from public.quiz_sessions where is_current and section = p_section for update;
    if not found then
      insert into public.quiz_sessions (is_current, section) values (true, p_section) returning * into s;
      insert into public.quiz_settings (session_id) values (s.id);
    end if;
  end if;
  return s;
end $$;

create or replace function public._lock_current_session() returns public.quiz_sessions
language plpgsql security definer set search_path = '' as $$
begin
  return public._lock_section_session(public._current_section());
end $$;

-- Question-bank changes affect both sections. Lock every current session in a
-- fixed order (UG, PG) BEFORE any single-section lock, so locks never deadlock.
create or replace function public._lock_all_current() returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.quiz_sessions where is_current order by section for update;
end $$;

create or replace function public._assert_bank_editable() returns void
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  select section into v from public.quiz_sessions where is_current and status in ('running', 'paused') order by section limit 1;
  if v is not null then perform public._err('QUIZ_IN_PROGRESS', format('The %s quiz is in progress.', v)); end if;
end $$;

create or replace function public.ensure_session() returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_organizer();
  return (public._lock_current_session()).id;
end $$;

-- ===========================================================================
-- Session-scoped question helpers
-- ===========================================================================
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
  for s in select * from public.quiz_sessions where is_current loop
    update public.quiz_sessions set current_index = greatest(0, least(current_index, public._session_question_count(s) - 1)) where id = s.id;
  end loop;
end $$;

-- A team's question order. Self-paced: a stable per-team shuffle (hash of
-- session, team and question ids — survives refreshes, differs per team).
-- Organizer-paced: the shared projector order.
create or replace function public._team_questions(s public.quiz_sessions, p_team uuid)
returns table (id uuid, idx integer)
language sql stable security definer set search_path = '' as $$
  select x.id, (row_number() over (order by x.k, x.idx) - 1)::int
  from (
    select sq.id, sq.idx,
      case when s.self_paced then public._sha256_hex(s.id::text || ':' || p_team::text || ':' || sq.id::text) end as k
    from public._session_questions(s) sq
  ) x
  order by 2;
$$;

-- Standings: only the session's section's teams.
create or replace function public._standings(p_session uuid)
returns table (team_id uuid, team_number integer, team_name text, is_demo boolean, points numeric,
               correct integer, incorrect integer, unanswered integer, recorded integer, tiebreak numeric, rank integer)
language sql stable security definer set search_path = '' as $$
  with ses as (select * from public.quiz_sessions x where x.id = p_session),
  st as (select * from public.quiz_settings where session_id = p_session),
  qn as (select public._session_question_count(x) as n from public.quiz_sessions x where x.id = p_session),
  agg as (
    select t.id, t.team_number, t.team_name, t.is_demo,
      coalesce(sum(a.points), 0) as rec_points,
      count(a.id) filter (where a.result = 'correct')::int as correct,
      count(a.id) filter (where a.result = 'incorrect')::int as incorrect,
      count(a.id)::int as recorded
    from public.teams t
    join ses on ses.section = t.section
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

create or replace function public._assert_quiz_ready(s public.quiz_sessions, p_need_teams boolean) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_need_teams and not exists (select 1 from public.teams where section = s.section) then
    perform public._err('QUIZ_NOT_READY', format('Add at least one %s team.', s.section));
  end if;
  if public._session_question_count(s) = 0 then perform public._err('QUIZ_NOT_READY', 'Select at least one question for this quiz.'); end if;
  if exists (select 1 from public._session_questions(s) sq where not exists (select 1 from public.question_keys k where k.question_id = sq.id)) then
    perform public._err('QUIZ_NOT_READY', 'Every question needs an answer key.');
  end if;
end $$;

-- ===========================================================================
-- Teams (shared by organizer and registration desk)
-- ===========================================================================
create or replace function public._upsert_team(p jsonb, p_role text, p_default_section text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_num_txt text := btrim(coalesce(p->>'team_number', ''));
  v_num integer; v_name text; v_p1 text; v_p2 text; v_college text; v_section text; v_demo boolean;
  old public.teams; v_changes jsonb := '{}'::jsonb; k text;
begin
  if v_id is not null then
    select * into old from public.teams where id = v_id for update;
    if not found then perform public._err('TEAM_NOT_FOUND'); end if;
  end if;
  v_section := upper(btrim(coalesce(p->>'section', old.section, p_default_section, '')));
  if v_section not in ('UG', 'PG') then perform public._err('VALIDATION', 'Section must be UG or PG.'); end if;
  if v_num_txt !~ '^[0-9]{1,3}$' or v_num_txt::int < 1 then
    perform public._err('VALIDATION', 'Team number must be a whole number from 1 to 999.');
  end if;
  v_num := v_num_txt::int;
  v_name := public._clean(p->>'team_name');
  v_p1 := public._clean(p->>'participant_1');
  v_p2 := public._clean(p->>'participant_2');
  v_college := public._clean(p->>'college_name');
  if v_name is null or char_length(v_name) > 80 then perform public._err('VALIDATION', 'Team name is required (max 80 characters).'); end if;
  if v_p1 is null or v_p2 is null then perform public._err('VALIDATION', 'Both participants are required (teams have exactly two members).'); end if;
  if char_length(v_p1) > 80 or char_length(v_p2) > 80 then perform public._err('VALIDATION', 'Participant names must be 80 characters or fewer.'); end if;
  if v_college is null or char_length(v_college) > 120 then perform public._err('VALIDATION', 'College name is required (max 120 characters).'); end if;
  if old.id is not null and old.section <> v_section
     and (exists (select 1 from public.team_answers where team_id = v_id)
          or exists (select 1 from public.participant_sessions where team_id = v_id and revoked_at is null)) then
    perform public._err('INVALID_STATE', 'A team that has joined or answered cannot change section.');
  end if;
  if exists (select 1 from public.teams where section = v_section and team_number = v_num and id is distinct from v_id) then
    perform public._err('DUPLICATE_TEAM_NUMBER', format('Team number %s is already in use in the %s section.', v_num, v_section));
  end if;
  -- Registration staff can never set the demo flag.
  v_demo := case when p_role = 'organizer' then coalesce((p->>'is_demo')::boolean, old.is_demo, false) else coalesce(old.is_demo, false) end;
  begin
    if v_id is null then
      insert into public.teams (section, team_number, team_name, participant_1, participant_2, college_name, is_demo)
      values (v_section, v_num, v_name, v_p1, v_p2, v_college, v_demo)
      returning id into v_id;
    else
      update public.teams set section = v_section, team_number = v_num, team_name = v_name, participant_1 = v_p1,
        participant_2 = v_p2, college_name = v_college, is_demo = v_demo
      where id = v_id;
    end if;
  exception when unique_violation then
    perform public._err('DUPLICATE_TEAM_NUMBER', format('Team number %s is already in use in the %s section.', v_num, v_section));
  end;
  if old.id is not null then
    foreach k in array array['section', 'team_number', 'team_name', 'participant_1', 'participant_2', 'college_name'] loop
      if (to_jsonb(old)->k) is distinct from (jsonb_build_object('section', v_section, 'team_number', v_num, 'team_name', v_name,
            'participant_1', v_p1, 'participant_2', v_p2, 'college_name', v_college)->k) then
        v_changes := v_changes || jsonb_build_object(k, jsonb_build_array(to_jsonb(old)->k,
          jsonb_build_object('section', v_section, 'team_number', v_num, 'team_name', v_name,
            'participant_1', v_p1, 'participant_2', v_p2, 'college_name', v_college)->k));
      end if;
    end loop;
  end if;
  if old.id is null or v_changes <> '{}'::jsonb then
    insert into public.registration_events (team_id, section, team_number, action, changes, actor, actor_role)
    values (v_id, v_section, v_num, case when old.id is null then 'create' else 'update' end, v_changes, auth.uid(), p_role);
  end if;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.save_team(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_organizer();
  return public._upsert_team(p, 'organizer', public._current_section());
end $$;

-- The team's own section's session holds the audit entry.
create or replace function public.delete_team(p_id uuid, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; t public.teams; n integer; pts numeric;
begin
  perform public._require_organizer();
  select * into t from public.teams where id = p_id;
  if not found then perform public._err('TEAM_NOT_FOUND'); end if;
  s := public._lock_section_session(t.section);
  select * into t from public.teams where id = p_id for update;
  if not found then perform public._err('TEAM_NOT_FOUND'); end if;
  if s.status = 'finalized' and p_id = any (s.qualifiers) then perform public._err('RESULTS_FINALIZED'); end if;
  select count(*), coalesce(sum(points), 0) into n, pts from public.team_answers where session_id = s.id and team_id = p_id;
  if n > 0 and not coalesce(p_confirm, false) then
    perform public._err('TEAM_HAS_ANSWERS', format('Team %s has %s recorded answer(s). Confirm to delete them too.', t.team_number, n));
  end if;
  if n > 0 then
    if s.status = 'finalized' then perform public._err('RESULTS_FINALIZED'); end if;
    insert into public.score_events (session_id, action, team_number, prev_points, reason, actor)
    values (s.id, 'delete_team', t.team_number, pts, format('Deleted %s team "%s" with %s recorded answer(s)', t.section, t.team_name, n), auth.uid());
  end if;
  delete from public.teams where id = p_id;
  return jsonb_build_object('deleted', true);
end $$;

-- Imports go into the selected section (a row's own section must match it).
create or replace function public.import_teams(p_rows jsonb, p_replace boolean default false, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.quiz_sessions; n_ans integer; existing integer; v_row jsonb; i bigint; cnt integer := 0; code text; v_sec text;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then perform public._err('VALIDATION', 'No team rows to import.'); end if;
  for v_row, i in select e, o from jsonb_array_elements(p_rows) with ordinality as x(e, o) loop
    v_sec := upper(btrim(coalesce(v_row->>'section', '')));
    if v_sec <> '' and v_sec <> s.section then
      perform public._err('VALIDATION', format('Row %s: section %s does not match the selected section %s.', coalesce(v_row->>'__line', i::text), v_sec, s.section));
    end if;
  end loop;
  if p_replace then
    select count(*) into n_ans from public.team_answers a join public.teams t on t.id = a.team_id
    where a.session_id = s.id and t.section = s.section;
    if n_ans > 0 and not coalesce(p_confirm, false) then perform public._err('TEAM_HAS_ANSWERS', 'Existing teams have recorded answers. Confirm to replace them.'); end if;
    if n_ans > 0 and s.status = 'finalized' then perform public._err('RESULTS_FINALIZED'); end if;
    if n_ans > 0 then
      insert into public.score_events (session_id, action, reason, actor)
      values (s.id, 'delete_team', format('Replaced all %s teams by import (%s recorded answer(s) removed)', s.section, n_ans), auth.uid());
    end if;
    delete from public.teams where section = s.section;
  end if;
  select count(*) into existing from public.teams where section = s.section;
  if existing + jsonb_array_length(p_rows) > 50 then
    perform public._err('TEAM_CAPACITY', format('Import would exceed 50 %s teams (%s existing + %s new).', s.section, existing, jsonb_array_length(p_rows)));
  end if;
  for v_row, i in select e, o from jsonb_array_elements(p_rows) with ordinality as x(e, o) loop
    begin
      perform public._upsert_team(((v_row - 'id') - '__line') || jsonb_build_object('section', s.section), 'organizer', s.section);
    exception when others then
      code := coalesce(substring(sqlerrm from '^([A-Z_]{3,40}):'), case when sqlstate = '23505' then 'DUPLICATE_TEAM_NUMBER' else 'VALIDATION' end);
      raise exception using errcode = 'P0001',
        message = code || ': Row ' || coalesce(v_row->>'__line', i::text) || ': ' || regexp_replace(sqlerrm, '^[A-Z_]{3,40}:\s*', '');
    end;
    cnt := cnt + 1;
  end loop;
  return jsonb_build_object('imported', cnt);
end $$;

-- ===========================================================================
-- Question bank (shared by both sections)
-- ===========================================================================
create or replace function public._audit_bank_answers(p_question uuid, p_sample_only boolean, p_reason text) returns integer
language plpgsql security definer set search_path = '' as $$
declare cs public.quiz_sessions; n integer; total integer := 0;
begin
  for cs in select * from public.quiz_sessions where is_current order by section loop
    select count(*) into n from public.team_answers a join public.questions q on q.id = a.question_id
    where a.session_id = cs.id and (p_question is null or a.question_id = p_question) and (not p_sample_only or q.is_sample);
    if n > 0 then
      if cs.status = 'finalized' then perform public._err('RESULTS_FINALIZED', format('The %s results are finalized.', cs.section)); end if;
      if p_reason is not null then
        insert into public.score_events (session_id, action, question_position, reason, actor)
        values (cs.id, 'delete_question', (select position from public.questions where id = p_question), format(p_reason, n), auth.uid());
      end if;
      total := total + n;
    end if;
  end loop;
  return total;
end $$;

create or replace function public._bank_answer_count(p_question uuid, p_sample_only boolean) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.team_answers a
  join public.quiz_sessions s on s.id = a.session_id and s.is_current
  join public.questions q on q.id = a.question_id
  where (p_question is null or a.question_id = p_question) and (not p_sample_only or q.is_sample);
$$;

create or replace function public.save_question(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  cs public.quiz_sessions;
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
  v_pos integer; n integer; old_q public.questions; old_k text; v_rescored integer := 0;
begin
  perform public._require_organizer();
  perform public._lock_all_current();
  if v_text is null then perform public._err('VALIDATION', 'Question text is required.'); end if;
  if v_a is null or v_b is null or v_c is null or v_d is null then perform public._err('VALIDATION', 'All four options (A–D) are required.'); end if;
  if (select count(distinct lower(x)) from unnest(array[v_a, v_b, v_c, v_d]) x) <> 4 then perform public._err('VALIDATION', 'Options must all be different.'); end if;
  if v_key not in ('A', 'B', 'C', 'D') then perform public._err('VALIDATION', 'Choose exactly one correct answer (A–D).'); end if;
  if v_mc is not null and (v_mc < 0 or v_mc > 100) then perform public._err('VALIDATION', 'Marks for a correct answer must be between 0 and 100.'); end if;
  if v_mi is not null and (v_mi < -100 or v_mi > 0) then perform public._err('VALIDATION', 'Marks for an incorrect answer must be between -100 and 0.'); end if;

  if v_id is not null then
    select * into old_q from public.questions where id = v_id for update;
    if not found then perform public._err('QUESTION_NOT_FOUND'); end if;
    select correct_option into old_k from public.question_keys where question_id = v_id;
    update public.questions set question_text = v_text, option_a = v_a, option_b = v_b, option_c = v_c, option_d = v_d,
      image_url = v_img, category = v_cat, marks_correct = v_mc, marks_incorrect = v_mi, is_sample = v_sample
    where id = v_id;
    insert into public.question_keys (question_id, correct_option, explanation) values (v_id, v_key, v_expl)
    on conflict (question_id) do update set correct_option = excluded.correct_option, explanation = excluded.explanation;
    if old_k is distinct from v_key or old_q.marks_correct is distinct from v_mc or old_q.marks_incorrect is distinct from v_mi then
      -- Both sections' recorded answers are re-scored.
      for cs in select * from public.quiz_sessions where is_current order by section loop
        v_rescored := v_rescored + public._rescore_question(cs, v_id);
      end loop;
    end if;
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
  return jsonb_build_object('id', v_id, 'rescored', v_rescored);
end $$;

create or replace function public.delete_question(p_id uuid, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare q public.questions; n integer;
begin
  perform public._require_organizer();
  perform public._lock_all_current();
  select * into q from public.questions where id = p_id for update;
  if not found then perform public._err('QUESTION_NOT_FOUND'); end if;
  perform public._assert_bank_editable();
  n := public._bank_answer_count(p_id, false);
  if n > 0 and not coalesce(p_confirm, false) then
    perform public._err('QUESTION_HAS_ANSWERS', format('Q%s has %s recorded answer(s). Confirm to delete them too.', q.position, n));
  end if;
  if n > 0 then perform public._audit_bank_answers(p_id, false, 'Deleted Q' || q.position || ' with %s recorded answer(s)'); end if;
  delete from public.questions where id = p_id;
  perform public._renumber_questions();
  return jsonb_build_object('deleted', true);
end $$;

create or replace function public.reorder_questions(p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform public._require_organizer();
  perform public._lock_all_current();
  perform public._assert_bank_editable();
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
    perform public._assert_bank_editable();
    n_ans := public._bank_answer_count(null, false);
    if n_ans > 0 and not coalesce(p_confirm, false) then perform public._err('QUESTION_HAS_ANSWERS', 'Existing questions have recorded answers. Confirm to replace them.'); end if;
    if n_ans > 0 then
      perform public._audit_bank_answers(null, false, 'Replaced question bank by import (%s recorded answer(s) removed)');
    end if;
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

-- Demo teams of the selected section; sample questions (shared bank).
create or replace function public.remove_demo_data(p_teams boolean default true, p_questions boolean default true, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; n_t integer := 0; n_q integer := 0; a_t integer := 0; a_q integer := 0;
begin
  perform public._require_organizer();
  perform public._lock_all_current();
  s := public._lock_current_session();
  if p_teams then
    select count(*) into n_t from public.teams where is_demo and section = s.section;
    select count(*) into a_t from public.team_answers a join public.teams t on t.id = a.team_id where a.session_id = s.id and t.is_demo and t.section = s.section;
    if a_t > 0 and not coalesce(p_confirm, false) then perform public._err('TEAM_HAS_ANSWERS', format('Demo teams have %s recorded answer(s). Confirm to delete them too.', a_t)); end if;
    if a_t > 0 and s.status = 'finalized' then perform public._err('RESULTS_FINALIZED'); end if;
  end if;
  if p_questions then
    select count(*) into n_q from public.questions where is_sample;
    if n_q > 0 then perform public._assert_bank_editable(); end if;
    a_q := public._bank_answer_count(null, true);
    if a_q > 0 and not coalesce(p_confirm, false) then perform public._err('QUESTION_HAS_ANSWERS', format('Sample questions have %s recorded answer(s). Confirm to delete them too.', a_q)); end if;
  end if;
  if a_t > 0 then
    insert into public.score_events (session_id, action, reason, actor)
    values (s.id, 'delete_team', format('Removed %s demo teams (%s recorded answer(s))', a_t, s.section), auth.uid());
  end if;
  if a_q > 0 then perform public._audit_bank_answers(null, true, 'Removed sample questions (%s recorded answer(s))'); end if;
  if p_teams then delete from public.teams where is_demo and section = s.section; end if;
  if p_questions then delete from public.questions where is_sample; perform public._renumber_questions(); end if;
  return jsonb_build_object('removedTeams', n_t, 'removedQuestions', n_q);
end $$;

-- ===========================================================================
-- Session control (selected section)
-- ===========================================================================
create or replace function public.start_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status <> 'setup' then perform public._err('INVALID_STATE', 'The quiz has already started.'); end if;
  perform public._assert_quiz_ready(s, true);
  perform public._settings(s.id);
  update public.quiz_sessions set status = 'running', started_at = now(), timer_started_at = now(), elapsed_ms = 0,
    current_index = 0, projector_view = 'question'
  where id = s.id;
  return jsonb_build_object('ok', true, 'server_now', now());
end $$;

create or replace function public.update_quiz_details(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; v_name text; v_desc text; v_ids uuid[]; v_self boolean; v_paced boolean;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  v_name := coalesce(public._clean(p->>'name'), s.name);
  if char_length(v_name) > 80 then perform public._err('VALIDATION', 'Quiz title must be 80 characters or fewer.'); end if;
  v_desc := case when p ? 'description' then public._clean(p->>'description') else s.description end;
  if v_desc is not null and char_length(v_desc) > 500 then perform public._err('VALIDATION', 'Description must be 500 characters or fewer.'); end if;
  v_self := coalesce((p->>'self_registration')::boolean, s.self_registration);
  v_paced := coalesce((p->>'self_paced')::boolean, s.self_paced);
  if v_paced <> s.self_paced and s.status <> 'setup' then
    perform public._err('INVALID_STATE', 'Pacing can only be changed before the quiz starts.');
  end if;
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
    self_registration = v_self, self_paced = v_paced
  where id = s.id;
  perform public._renumber_questions();
  return jsonb_build_object('ok', true);
end $$;

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
  insert into public.quiz_sessions (is_current, section, name, description, question_ids, self_registration, self_paced)
  values (true, s.section, s.name, s.description, s.question_ids, s.self_registration, s.self_paced) returning id into v_id;
  insert into public.quiz_settings (session_id, duration_seconds, marks_correct, marks_incorrect, marks_unanswered, qualify_count, accuracy_tiebreak)
  values (v_id, st.duration_seconds, st.marks_correct, st.marks_incorrect, st.marks_unanswered, st.qualify_count, st.accuracy_tiebreak);
  return v_id;
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
  select * into t from public.teams where id = p_team_id and section = s.section;
  if not found then perform public._err('TEAM_NOT_FOUND', 'That team is not in this section.'); end if;
  select * into q from public.questions where id = p_question_id;
  if not found then perform public._err('QUESTION_NOT_FOUND'); end if;
  if not exists (select 1 from public._session_questions(s) sq where sq.id = q.id) then
    perform public._err('QUESTION_NOT_IN_QUIZ');
  end if;
  sel := public._normalize_option(p_selected);
  return public._apply_answer(s, st, t, q, sel, p_request_id, p_correction, p_reason, 'organizer');
end $$;

create or replace function public.get_standings()
returns table (team_id uuid, team_number integer, team_name text, is_demo boolean, points numeric,
               correct integer, incorrect integer, unanswered integer, recorded integer, tiebreak numeric, rank integer)
language plpgsql stable security definer set search_path = '' as $$
declare v_sid uuid;
begin
  perform public._require_organizer();
  select id into v_sid from public.quiz_sessions where is_current and section = public._current_section();
  return query select * from public._standings(v_sid);
end $$;

create or replace function public.set_tiebreak(p_team_id uuid, p_score numeric, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; t public.teams;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status = 'finalized' then perform public._err('RESULTS_FINALIZED'); end if;
  if s.status <> 'ended' then perform public._err('INVALID_STATE', 'Tie-break results can be entered after the quiz ends.'); end if;
  select * into t from public.teams where id = p_team_id and section = s.section;
  if not found then perform public._err('TEAM_NOT_FOUND'); end if;
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
-- Participants: section comes from the join code / device token
-- ===========================================================================
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
    'title', s.name, 'description', s.description, 'status', s.status, 'section', s.section,
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
  -- Only teams of this code's section; same error for unknown team and wrong PIN.
  select * into t from public.teams where team_number = p_team_number and section = s.section;
  select pin into v_pin from public.team_credentials where team_id = t.id;
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
  return jsonb_build_object('ok', true, 'token', tok, 'team', public._team_public(t), 'quiz_title', s.name, 'section', s.section);
end $$;

drop function if exists public.register_team(text, text, text, text, text);
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
  tok := public._open_participant_session(s, t, p_device_label);
  return jsonb_build_object('ok', true, 'token', tok, 'team', public._team_public(t), 'quiz_title', s.name, 'section', s.section,
    'pin', (select pin from public.team_credentials where team_id = t.id));
end $$;

-- p_position: 0-based position in THIS team's question order (self-paced only;
-- NULL = first unanswered). Never returns keys, explanations, results or points.
drop function if exists public.participant_state(text);
create or replace function public.participant_state(p_token text, p_position integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ps public.participant_sessions; s public.quiz_sessions; st public.quiz_settings; t public.teams; q public.questions;
  ans public.team_answers; total integer; res jsonb; expired boolean; r record; revoked public.participant_sessions;
  v_pos integer; v_progress jsonb;
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
    'quiz', jsonb_build_object('title', s.name, 'description', s.description, 'status', s.status, 'section', s.section,
      'self_paced', s.self_paced, 'registration_open', s.registration_open, 'total_questions', total,
      'results_revealed', s.results_revealed, 'time_up', expired),
    'timer', jsonb_build_object('status', s.status, 'elapsed_ms', s.elapsed_ms, 'timer_started_at', s.timer_started_at,
      'duration_seconds', st.duration_seconds));
  if s.status = 'running' and not expired and total > 0 then
    if s.self_paced then
      select coalesce(jsonb_agg(exists (select 1 from public.team_answers a
               where a.session_id = s.id and a.team_id = t.id and a.question_id = tq.id) order by tq.idx), '[]'::jsonb)
        into v_progress from public._team_questions(s, t.id) tq;
      v_pos := p_position;
      if v_pos is null or v_pos < 0 or v_pos >= total then
        select coalesce(min(i - 1), 0) into v_pos from jsonb_array_elements(v_progress) with ordinality as x(v, i) where x.v = 'false'::jsonb;
      end if;
      select x.* into q from public.questions x join public._team_questions(s, t.id) tq on tq.id = x.id where tq.idx = v_pos;
      select * into ans from public.team_answers where session_id = s.id and team_id = t.id and question_id = q.id;
      res := res || jsonb_build_object(
        'question', jsonb_build_object('id', q.id, 'number', v_pos + 1, 'question_text', q.question_text,
          'option_a', q.option_a, 'option_b', q.option_b, 'option_c', q.option_c, 'option_d', q.option_d, 'image_url', q.image_url),
        'position', v_pos, 'progress', v_progress, 'question_closed', false,
        'my_answer', case when ans.id is null then null
          else jsonb_build_object('selected', ans.selected_option, 'submitted_at', ans.created_at, 'source', ans.source) end);
    else
      select x.* into q from public.questions x join public._session_questions(s) sq on sq.id = x.id where sq.idx = s.current_index;
      select * into ans from public.team_answers where session_id = s.id and team_id = t.id and question_id = q.id;
      res := res || jsonb_build_object(
        'question', jsonb_build_object('id', q.id, 'number', s.current_index + 1, 'question_text', q.question_text,
          'option_a', q.option_a, 'option_b', q.option_b, 'option_c', q.option_c, 'option_d', q.option_d, 'image_url', q.image_url),
        'question_closed', q.id = any (s.completed_question_ids),
        'my_answer', case when ans.id is null then null
          else jsonb_build_object('selected', ans.selected_option, 'submitted_at', ans.created_at, 'source', ans.source) end);
    end if;
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
  ev public.score_events; ex public.team_answers; v_qid uuid; sel text := upper(btrim(coalesce(p_option, '')));
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
  if s.self_paced then
    -- Any question of this quiz, in any order.
    select sq.id into v_qid from public._session_questions(s) sq where sq.id = p_question_id;
    if v_qid is null then return jsonb_build_object('ok', false, 'error', 'QUESTION_NOT_IN_QUIZ'); end if;
  else
    select sq.id into v_qid from public._session_questions(s) sq where sq.idx = s.current_index;
    if v_qid is null or p_question_id <> v_qid then return jsonb_build_object('ok', false, 'error', 'NOT_CURRENT_QUESTION'); end if;
    if v_qid = any (s.completed_question_ids) then return jsonb_build_object('ok', false, 'error', 'QUESTION_CLOSED'); end if;
  end if;
  if sel not in ('A', 'B', 'C', 'D') then return jsonb_build_object('ok', false, 'error', 'INVALID_OPTION'); end if;
  select * into ex from public.team_answers where session_id = s.id and team_id = ps.team_id and question_id = v_qid;
  if found then
    return jsonb_build_object('ok', false, 'error', 'ALREADY_SUBMITTED', 'selected', ex.selected_option);
  end if;
  select * into t from public.teams where id = ps.team_id;
  select * into q from public.questions where id = v_qid;
  perform public._apply_answer(s, st, t, q, sel, p_request_id, false, null, 'participant');
  -- Deliberately no result/points: correctness is never revealed to participants here.
  return jsonb_build_object('ok', true, 'duplicate_request', false, 'selected', sel, 'question_id', v_qid, 'submitted_at', now());
end $$;

-- ===========================================================================
-- Registration desk (registration staff OR organizers)
-- ===========================================================================
create or replace function public.is_registration_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.registration_staff r where r.user_id = auth.uid());
$$;

create or replace function public._require_registrar() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not (public.is_registration_staff() or public.is_organizer()) then
    raise exception using errcode = '42501', message = 'NOT_AUTHORIZED: This account is not authorized for the registration desk.';
  end if;
end $$;

-- Which consoles the signed-in account may open.
create or replace function public.registration_access() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('staff', public.is_registration_staff(), 'organizer', public.is_organizer());
$$;

-- Everything the registration desk shows. No answers, scores, questions or keys.
create or replace function public.reg_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_registrar();
  return jsonb_build_object(
    'server_now', now(),
    'capacity', 50,
    'sections', (
      select coalesce(jsonb_agg(jsonb_build_object('section', x.section, 'status', x.status, 'locked', x.status <> 'setup',
        'quiz_title', x.name, 'team_count', (select count(*) from public.teams t where t.section = x.section)) order by x.section), '[]'::jsonb)
      from public.quiz_sessions x where x.is_current),
    'teams', (
      select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'section', t.section, 'team_number', t.team_number,
        'team_name', t.team_name, 'participant_1', t.participant_1, 'participant_2', t.participant_2,
        'college_name', t.college_name, 'pin', c.pin, 'self_registered', t.self_registered, 'is_demo', t.is_demo,
        'updated_at', t.updated_at) order by t.section, t.team_number), '[]'::jsonb)
      from public.teams t left join public.team_credentials c on c.team_id = t.id));
end $$;

-- Create or edit a team while its section's quiz (old and new section) is still in setup.
create or replace function public.reg_save_team(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid; old public.teams; v_new text; locked text; res jsonb;
begin
  perform public._require_registrar();
  if v_id is not null then
    select * into old from public.teams where id = v_id;
    if not found then perform public._err('TEAM_NOT_FOUND'); end if;
  end if;
  v_new := upper(btrim(coalesce(p->>'section', old.section, '')));
  if v_new not in ('UG', 'PG') then perform public._err('VALIDATION', 'Choose the section (UG or PG).'); end if;
  perform public._lock_section_session(x) from unnest(array(select distinct y from unnest(array[old.section, v_new]) y where y is not null order by 1)) x;
  select section into locked from public.quiz_sessions
  where is_current and section in (old.section, v_new) and status <> 'setup' order by section limit 1;
  if locked is not null then
    perform public._err('REGISTRATION_LOCKED', format('The %s quiz has started, so its registrations are locked. Ask an organizer.', locked));
  end if;
  res := public._upsert_team((p - 'is_demo') || jsonb_build_object('section', v_new),
    case when public.is_organizer() then 'organizer' else 'registration' end, v_new);
  return res || jsonb_build_object('pin', (select pin from public.team_credentials where team_id = (res->>'id')::uuid));
end $$;

-- ===========================================================================
-- Backup restore: format 2 (both sections); format 1 restores into UG.
-- ===========================================================================
create or replace function public.restore_backup(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ver integer; v_sessions jsonb; item jsonb; sess jsonb; v_sid uuid; v_status text; v_section text; v_ids uuid[] := '{}';
begin
  perform public._require_organizer();
  v_ver := case when (p->>'format_version') ~ '^[0-9]+$' then (p->>'format_version')::int end;
  if p->>'app' is distinct from 'brainfreze-cold-start' or v_ver is null or v_ver not in (1, 2) then
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

  for item in select e from jsonb_array_elements(v_sessions) as x(e) loop
    sess := item->'session';
    if jsonb_typeof(sess) <> 'object' then perform public._err('INVALID_BACKUP'); end if;
    v_section := upper(coalesce(sess->>'section', 'UG'));
    if v_section not in ('UG', 'PG') or exists (select 1 from public.quiz_sessions where is_current and section = v_section) then
      perform public._err('INVALID_BACKUP', 'Each section may appear only once.');
    end if;
    v_status := sess->>'status';
    v_sid := (sess->>'id')::uuid;
    insert into public.quiz_sessions (id, section, self_paced, name, description, question_ids, self_registration, is_current, status, current_index,
      completed_question_ids, started_at, timer_started_at, elapsed_ms, ended_at, corrections_enabled, projector_view, results_revealed,
      qualifiers, qualifiers_confirmed_at, qualification_note, created_at)
    values (v_sid, v_section, coalesce((sess->>'self_paced')::boolean, true), coalesce(sess->>'name', 'COLD START'), sess->>'description',
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
    from jsonb_to_record(coalesce(item->'settings', '{}'::jsonb)) as x(duration_seconds int, marks_correct numeric, marks_incorrect numeric,
         marks_unanswered numeric, qualify_count int, accuracy_tiebreak boolean);
    v_ids := v_ids || v_sid;
  end loop;

  insert into public.team_answers (session_id, team_id, question_id, selected_option, result, points, source, created_at)
  select x.session_id, x.team_id, x.question_id, x.selected_option, x.result, x.points, coalesce(x.source, 'organizer'), coalesce(x.created_at, now())
  from jsonb_to_recordset(coalesce(p->'answers', '[]'::jsonb)) as x(session_id uuid, team_id uuid, question_id uuid, selected_option text, result text, points numeric, source text, created_at timestamptz)
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
  -- A section missing from the backup gets a fresh draft session.
  perform public._lock_section_session('UG');
  perform public._lock_section_session('PG');
  perform public._renumber_questions();
  return jsonb_build_object('ok', true);
end $$;

-- ===========================================================================
-- Security: RLS, grants, function permissions
-- ===========================================================================
alter table public.registration_staff  enable row level security;
alter table public.registration_events enable row level security;
revoke all on public.registration_staff, public.registration_events from anon, authenticated, public;
grant select on public.registration_staff, public.registration_events to authenticated;
drop policy if exists registration_staff_self_read on public.registration_staff;
create policy registration_staff_self_read on public.registration_staff for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists registration_events_organizer_read on public.registration_events;
create policy registration_events_organizer_read on public.registration_events for select to authenticated
  using ((select public.is_organizer()));

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

-- Registration desk RPCs (each checks registration staff OR organizer internally).
grant execute on function
  public.registration_access(), public.is_registration_staff(), public.reg_overview(), public.reg_save_team(jsonb)
to authenticated;

-- Participant RPCs: callable without an account; authorized by join code / team PIN / device token.
grant execute on function
  public.join_lookup(text), public.join_team(text, integer, text, text),
  public.register_team(text, text, text, text, text, text), public.participant_state(text, integer),
  public.participant_submit(text, uuid, uuid, text), public.participant_leave(text)
to anon, authenticated;

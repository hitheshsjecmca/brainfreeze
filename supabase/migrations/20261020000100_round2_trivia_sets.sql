-- Migration 10 — Round 2 "MIND MELTDOWN": trivia sets, published versions, join codes and live sessions.
--
-- Replaces the single global board of migration 7 (whose tables and functions are kept, unchanged and
-- unused by the app) with:
--   r2_sets            any number of trivia sets: title, section compatibility (UG / PG / BOTH),
--                      question timer (default 18 s) and wrong-answer penalty (default 50 % of the value)
--   r2_set_topics      the editable DRAFT: any number of topics per set …
--   r2_set_questions   … any number of point-valued questions per topic …
--   r2_set_answers     … and their answers, in their own table (no table grants; organizer RPCs only)
--   r2_versions        an immutable snapshot taken by Publish (version 1, 2, …). A set keeps ONE six-digit
--   r2_version_questions  code from its first publication; the code always opens the latest version.
--   r2_version_answers    Editing the draft never changes a published version.
--   r2_sessions        a live game, created only by "Start Round 2" for one version, one section and
--                      the teams the host selected. Each session has its own board state; starting a
--                      session never touches another session (even of the same set).
--   r2_session_teams   the teams of a session (validated: registered, in the session's section)
--   r2_session_results one row per scored/closed question per session (unique), with an audit snapshot.
--
-- Scores are computed in the database from the snapshot's point value and penalty; the client never
-- sends a score. The question text reaches the board only after Reveal Question and the answer only
-- after Answer. An expired timer never scores anything.
-- Data: if the migration-7 board has topics, they are COPIED (not moved) into a draft set
-- "Round 2 board (imported)" so prepared questions are not lost. Nothing else is changed or deleted.
-- Rollback: drop the r2s_* functions and the tables above (nothing else depends on them).

-- ===========================================================================
-- Tables
-- ===========================================================================
create table if not exists public.r2_sets (
  id                    uuid primary key default gen_random_uuid(),
  title                 text not null check (char_length(title) between 1 and 80),
  section               text not null default 'BOTH' check (section in ('UG', 'PG', 'BOTH')),
  timer_seconds         integer not null default 18 check (timer_seconds between 5 and 120),
  wrong_penalty_percent numeric(5,2) not null default 50 check (wrong_penalty_percent between 0 and 100),
  join_code             text unique check (join_code ~ '^[0-9]{6}$'),
  published_version     integer not null default 0,
  published_at          timestamptz,
  draft_updated_at      timestamptz not null default now(),
  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists public.r2_set_topics (
  id         uuid primary key default gen_random_uuid(),
  set_id     uuid not null references public.r2_sets(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  position   integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists r2_set_topics_name_key on public.r2_set_topics (set_id, lower(name));

create table if not exists public.r2_set_questions (
  id            uuid primary key default gen_random_uuid(),
  set_id        uuid not null references public.r2_sets(id) on delete cascade,
  topic_id      uuid not null references public.r2_set_topics(id) on delete cascade,
  points        numeric(10,2) not null check (points > 0 and points <= 10000),
  question_text text not null check (char_length(question_text) between 1 and 1000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists r2_set_questions_topic_idx on public.r2_set_questions (topic_id);

create table if not exists public.r2_set_answers (
  question_id uuid primary key references public.r2_set_questions(id) on delete cascade,
  answer_text text not null check (char_length(answer_text) between 1 and 500)
);

create table if not exists public.r2_versions (
  id                    uuid primary key default gen_random_uuid(),
  set_id                uuid not null references public.r2_sets(id) on delete restrict,
  version               integer not null,
  title                 text not null,
  section               text not null,
  timer_seconds         integer not null,
  wrong_penalty_percent numeric(5,2) not null,
  published_at          timestamptz not null default now(),
  published_by          uuid,
  unique (set_id, version)
);

create table if not exists public.r2_version_questions (
  id             uuid primary key default gen_random_uuid(),
  version_id     uuid not null references public.r2_versions(id) on delete cascade,
  topic_name     text not null,
  topic_position integer not null,
  points         numeric(10,2) not null,
  question_text  text not null,
  sort_index     integer not null
);
create index if not exists r2_version_questions_version_idx on public.r2_version_questions (version_id);

create table if not exists public.r2_version_answers (
  question_id uuid primary key references public.r2_version_questions(id) on delete cascade,
  answer_text text not null
);

create table if not exists public.r2_sessions (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null unique,
  set_id          uuid not null references public.r2_sets(id) on delete restrict,
  version_id      uuid not null references public.r2_versions(id) on delete restrict,
  section         text not null check (section in ('UG', 'PG')),
  status          text not null default 'live' check (status in ('live', 'ended')),
  phase           text not null default 'idle' check (phase in ('idle', 'selected', 'revealed')),
  question_id     uuid references public.r2_version_questions(id) on delete set null,
  revealed_at     timestamptz,
  answer_revealed boolean not null default false,
  last_result_id  bigint,
  started_at      timestamptz not null default now(),
  started_by      uuid,
  ended_at        timestamptz,
  updated_at      timestamptz not null default now()
);

create table if not exists public.r2_session_teams (
  session_id uuid not null references public.r2_sessions(id) on delete cascade,
  team_id    uuid not null references public.teams(id) on delete cascade,
  primary key (session_id, team_id)
);

create table if not exists public.r2_session_results (
  id              bigint generated always as identity primary key,
  request_id      uuid not null unique,
  session_id      uuid not null references public.r2_sessions(id) on delete cascade,
  question_id     uuid references public.r2_version_questions(id) on delete set null,
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
  created_at      timestamptz not null default now()
);
-- Each question is scored (or closed) at most once per session.
create unique index if not exists r2_session_results_once on public.r2_session_results (session_id, question_id);
create index if not exists r2_session_results_team_idx on public.r2_session_results (team_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'r2_sessions_last_result_fk') then
    alter table public.r2_sessions add constraint r2_sessions_last_result_fk
      foreign key (last_result_id) references public.r2_session_results(id) on delete set null;
  end if;
end $$;

-- ===========================================================================
-- Helpers
-- ===========================================================================
create or replace function public._r2s_touch(p_set uuid) returns void
language sql security definer set search_path = '' as $$
  update public.r2_sets set draft_updated_at = now(), updated_at = now() where id = p_set;
$$;

-- An editable (not archived) set, locked for the rest of the transaction.
create or replace function public._r2s_lock_set(p_set uuid) returns public.r2_sets
language plpgsql security definer set search_path = '' as $$
declare s public.r2_sets;
begin
  select * into s from public.r2_sets where id = p_set for update;
  if not found then perform public._err('TRIVIA_NOT_FOUND', 'Trivia set not found.'); end if;
  if s.archived_at is not null then perform public._err('TRIVIA_SET_ARCHIVED', 'This trivia set is archived.'); end if;
  return s;
end $$;

-- A live session, locked (serializes every gameplay write of that session only).
create or replace function public._r2s_lock_session(p_session uuid) returns public.r2_sessions
language plpgsql security definer set search_path = '' as $$
declare g public.r2_sessions;
begin
  select * into g from public.r2_sessions where id = p_session for update;
  if not found then perform public._err('TRIVIA_SESSION_NOT_FOUND', 'Round 2 session not found.'); end if;
  if g.status <> 'live' then perform public._err('TRIVIA_SESSION_ENDED', 'This Round 2 session has ended.'); end if;
  return g;
end $$;

-- The published set a code opens (latest version); null when the code is unknown or the set archived.
create or replace function public._r2s_by_code(p_code text) returns public.r2_sets
language plpgsql stable security definer set search_path = '' as $$
declare s public.r2_sets; c text := regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g');
begin
  if c !~ '^[0-9]{6}$' then return null; end if;
  select * into s from public.r2_sets where join_code = c and archived_at is null and published_version > 0;
  return s;
end $$;

-- Unique six-digit code: never used by another trivia set nor by any Round 1 quiz set (current or retired).
create or replace function public._r2s_new_code() returns text
language plpgsql security definer set search_path = '' as $$
declare c text; tries integer := 0;
begin
  loop
    tries := tries + 1;
    if tries > 60 then perform public._err('CODE_GENERATION_FAILED', 'Could not generate a unique code. Try again.'); end if;
    c := lpad((('x' || public._random_bytes_hex(4))::bit(32)::bigint % 1000000)::text, 6, '0');
    exit when not exists (select 1 from public.r2_sets where join_code = c)
          and not exists (select 1 from public.quiz_sessions where join_code = c)
          and not exists (select 1 from public.retired_join_codes where code = c);
  end loop;
  return c;
end $$;

-- Problems that block publishing (also shown by the editor).
create or replace function public._r2s_publish_issues(p_set uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select array_remove(array[
    case when not exists (select 1 from public.r2_set_topics where set_id = p_set) then 'Add at least one topic.' end,
    case when not exists (select 1 from public.r2_set_questions where set_id = p_set) then 'Add at least one question.' end,
    (select 'Topic "' || t.name || '" has no questions — add one or delete the topic.' from public.r2_set_topics t
      where t.set_id = p_set and not exists (select 1 from public.r2_set_questions q where q.topic_id = t.id)
      order by t.position limit 1),
    case when exists (select 1 from public.r2_set_questions q where q.set_id = p_set
                      and not exists (select 1 from public.r2_set_answers a where a.question_id = q.id)) then 'Every question needs an answer.' end
  ], null);
$$;

-- Topics → point tiles of a version, with "used" for a session (null session = nothing used).
create or replace function public._r2s_board_topics(p_version uuid, p_session uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', 'v' || t.topic_position, 'name', t.topic_name, 'questions', t.questions) order by t.topic_position), '[]'::jsonb)
  from (
    select q.topic_position, q.topic_name,
      jsonb_agg(jsonb_build_object('id', q.id, 'points', q.points,
        'used', exists (select 1 from public.r2_session_results r where r.session_id = p_session and r.question_id = q.id))
        order by q.points, q.sort_index) as questions
    from public.r2_version_questions q where q.version_id = p_version
    group by q.topic_position, q.topic_name
  ) t;
$$;

create or replace function public._r2s_scores(p_session uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by (x->>'score')::numeric desc, x->>'section', (x->>'team_number')::int), '[]'::jsonb)
  from (
    select jsonb_build_object('team_id', tm.id, 'team_number', tm.team_number, 'team_name', tm.team_name, 'section', tm.section,
      'score', coalesce((select sum(r.points) from public.r2_session_results r where r.session_id = p_session and r.team_id = tm.id), 0)) as x
    from public.r2_session_teams st join public.teams tm on tm.id = st.team_id where st.session_id = p_session
  ) s;
$$;

create or replace function public._r2s_idle(p_session uuid, p_last bigint) returns void
language sql security definer set search_path = '' as $$
  update public.r2_sessions set phase = 'idle', question_id = null, revealed_at = null, answer_revealed = false,
    last_result_id = p_last, updated_at = now() where id = p_session;
$$;

-- ===========================================================================
-- Organizer: trivia sets (draft editing)
-- ===========================================================================
create or replace function public.r2s_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_organizer();
  return jsonb_build_object(
    'server_now', now(),
    'sets', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'title', s.title, 'section', s.section, 'timer_seconds', s.timer_seconds, 'wrong_penalty_percent', s.wrong_penalty_percent,
        'join_code', s.join_code, 'published_version', s.published_version, 'published_at', s.published_at, 'archived_at', s.archived_at,
        'draft_updated_at', s.draft_updated_at, 'created_at', s.created_at,
        'unpublished_changes', s.published_version > 0 and s.draft_updated_at > s.published_at,
        'topic_count', (select count(*) from public.r2_set_topics t where t.set_id = s.id),
        'question_count', (select count(*) from public.r2_set_questions q where q.set_id = s.id),
        'live_sessions', (select count(*) from public.r2_sessions g where g.set_id = s.id and g.status = 'live'))
      order by s.archived_at nulls first, s.created_at desc) from public.r2_sets s), '[]'::jsonb),
    'sessions', coalesce((select jsonb_agg(jsonb_build_object(
        'id', g.id, 'set_id', g.set_id, 'title', v.title, 'version', v.version, 'section', g.section, 'status', g.status,
        'started_at', g.started_at, 'ended_at', g.ended_at, 'join_code', s.join_code,
        'team_count', (select count(*) from public.r2_session_teams x where x.session_id = g.id),
        'played', (select count(*) from public.r2_session_results r where r.session_id = g.id),
        'question_count', (select count(*) from public.r2_version_questions q where q.version_id = g.version_id))
      order by g.status = 'live' desc, g.started_at desc)
      from public.r2_sessions g join public.r2_versions v on v.id = g.version_id join public.r2_sets s on s.id = g.set_id), '[]'::jsonb));
end $$;

-- The draft of one set, answers included (organizers only).
create or replace function public.r2s_set_detail(p_set_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.r2_sets;
begin
  perform public._require_organizer();
  select * into s from public.r2_sets where id = p_set_id;
  if not found then perform public._err('TRIVIA_NOT_FOUND', 'Trivia set not found.'); end if;
  return jsonb_build_object(
    'set', to_jsonb(s) || jsonb_build_object('unpublished_changes', s.published_version > 0 and s.draft_updated_at > s.published_at),
    'topics', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'position', t.position, 'created_at', t.created_at)
      order by t.position, t.created_at) from public.r2_set_topics t where t.set_id = s.id), '[]'::jsonb),
    'questions', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'topic_id', q.topic_id, 'points', q.points,
      'question_text', q.question_text, 'answer_text', a.answer_text, 'created_at', q.created_at) order by q.points, q.created_at)
      from public.r2_set_questions q left join public.r2_set_answers a on a.question_id = q.id where q.set_id = s.id), '[]'::jsonb),
    'issues', to_jsonb(public._r2s_publish_issues(s.id)),
    'live_sessions', (select count(*) from public.r2_sessions g where g.set_id = s.id and g.status = 'live'));
end $$;

create or replace function public.r2s_save_set(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid; v_title text := public._clean(p->>'title');
  v_section text := upper(coalesce(nullif(btrim(p->>'section'), ''), 'BOTH'));
  v_timer text := btrim(coalesce(p->>'timer_seconds', '')); v_pct text := btrim(coalesce(p->>'wrong_penalty_percent', ''));
  s public.r2_sets;
begin
  perform public._require_organizer();
  if v_title is null or char_length(v_title) > 80 then perform public._err('VALIDATION', 'The trivia set title is required (max 80 characters).'); end if;
  if v_section not in ('UG', 'PG', 'BOTH') then perform public._err('VALIDATION', 'Section must be UG, PG or both.'); end if;
  if v_timer <> '' and (v_timer !~ '^[0-9]+$' or v_timer::int not between 5 and 120) then
    perform public._err('VALIDATION', 'The question timer must be 5–120 whole seconds.');
  end if;
  if v_pct <> '' and (v_pct !~ '^[0-9]+(\.[0-9]{1,2})?$' or v_pct::numeric > 100) then
    perform public._err('VALIDATION', 'The wrong-answer penalty must be 0–100 % of the question value.');
  end if;
  if v_id is null then
    insert into public.r2_sets (title, section, timer_seconds, wrong_penalty_percent)
    values (v_title, v_section, coalesce(nullif(v_timer, '')::int, 18), coalesce(nullif(v_pct, '')::numeric, 50)) returning id into v_id;
  else
    s := public._r2s_lock_set(v_id);
    update public.r2_sets set title = v_title, section = v_section,
      timer_seconds = coalesce(nullif(v_timer, '')::int, timer_seconds),
      wrong_penalty_percent = coalesce(nullif(v_pct, '')::numeric, wrong_penalty_percent)
    where id = v_id;
    perform public._r2s_touch(v_id);
  end if;
  return v_id;
end $$;

-- Only a never-published set can be deleted; a published one is archived (its sessions and results stay).
create or replace function public.r2s_delete_set(p_set_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.r2_sets;
begin
  perform public._require_organizer();
  select * into s from public.r2_sets where id = p_set_id for update;
  if not found then perform public._err('TRIVIA_NOT_FOUND', 'Trivia set not found.'); end if;
  if s.published_version > 0 then perform public._err('TRIVIA_SET_PUBLISHED', 'A published trivia set cannot be deleted. Archive it instead.'); end if;
  delete from public.r2_sets where id = s.id;
  return jsonb_build_object('deleted', true);
end $$;

create or replace function public.r2s_archive_set(p_set_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.r2_sets;
begin
  perform public._require_organizer();
  s := public._r2s_lock_set(p_set_id);
  if exists (select 1 from public.r2_sessions where set_id = s.id and status = 'live') then
    perform public._err('TRIVIA_SESSION_LIVE', 'End the live Round 2 session of this set first.');
  end if;
  update public.r2_sets set archived_at = now(), updated_at = now() where id = s.id;
  return jsonb_build_object('archived', true);
end $$;

create or replace function public.r2s_save_topic(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p->>'id', '')::uuid; v_set uuid := nullif(p->>'set_id', '')::uuid; v_name text := public._clean(p->>'name'); v_pos integer;
begin
  perform public._require_organizer();
  if v_id is not null then select set_id into v_set from public.r2_set_topics where id = v_id; end if;
  if v_set is null then perform public._err('TRIVIA_NOT_FOUND', 'Topic not found.'); end if;
  perform public._r2s_lock_set(v_set);
  if v_name is null or char_length(v_name) > 60 then perform public._err('VALIDATION', 'Topic name is required (max 60 characters).'); end if;
  if exists (select 1 from public.r2_set_topics where set_id = v_set and lower(name) = lower(v_name) and id is distinct from v_id) then
    perform public._err('VALIDATION', 'A topic with that name already exists in this set.');
  end if;
  if v_id is null then
    select coalesce(max(position), 0) + 1 into v_pos from public.r2_set_topics where set_id = v_set;
    insert into public.r2_set_topics (set_id, name, position) values (v_set, v_name, v_pos) returning id into v_id;
  else
    update public.r2_set_topics set name = v_name where id = v_id;
  end if;
  perform public._r2s_touch(v_set);
  return v_id;
end $$;

create or replace function public.r2s_delete_topic(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_set uuid;
begin
  perform public._require_organizer();
  select set_id into v_set from public.r2_set_topics where id = p_id;
  if v_set is null then perform public._err('TRIVIA_NOT_FOUND', 'Topic not found.'); end if;
  perform public._r2s_lock_set(v_set);
  delete from public.r2_set_topics where id = p_id; -- its draft questions go with it; published versions are separate copies
  perform public._r2s_touch(v_set);
  return jsonb_build_object('deleted', true);
end $$;

create or replace function public.r2s_save_question(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_topic uuid := nullif(p->>'topic_id', '')::uuid;
  v_points_raw text := btrim(coalesce(p->>'points', ''));
  v_points numeric;
  v_text text := public._clean(p->>'question_text');
  v_answer text := public._clean(p->>'answer_text');
  v_set uuid;
begin
  perform public._require_organizer();
  select set_id into v_set from public.r2_set_topics where id = v_topic;
  if v_set is null then perform public._err('VALIDATION', 'Choose a topic.'); end if;
  perform public._r2s_lock_set(v_set);
  if v_points_raw !~ '^[0-9]+(\.[0-9]{1,2})?$' then perform public._err('VALIDATION', 'Points must be a positive number (up to 2 decimals).'); end if;
  v_points := v_points_raw::numeric;
  if v_points <= 0 or v_points > 10000 then perform public._err('VALIDATION', 'Points must be between 0.01 and 10000.'); end if;
  if v_text is null or char_length(v_text) > 1000 then perform public._err('VALIDATION', 'Question text is required (max 1000 characters).'); end if;
  if v_answer is null or char_length(v_answer) > 500 then perform public._err('VALIDATION', 'The answer is required (max 500 characters).'); end if;
  if v_id is null then
    insert into public.r2_set_questions (set_id, topic_id, points, question_text) values (v_set, v_topic, v_points, v_text) returning id into v_id;
    insert into public.r2_set_answers (question_id, answer_text) values (v_id, v_answer);
  else
    if not exists (select 1 from public.r2_set_questions where id = v_id and set_id = v_set) then
      perform public._err('TRIVIA_NOT_FOUND', 'Question not found.');
    end if;
    update public.r2_set_questions set topic_id = v_topic, points = v_points, question_text = v_text, updated_at = now() where id = v_id;
    insert into public.r2_set_answers (question_id, answer_text) values (v_id, v_answer)
    on conflict (question_id) do update set answer_text = excluded.answer_text;
  end if;
  perform public._r2s_touch(v_set);
  return v_id;
end $$;

create or replace function public.r2s_delete_question(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_set uuid;
begin
  perform public._require_organizer();
  select set_id into v_set from public.r2_set_questions where id = p_id;
  if v_set is null then perform public._err('TRIVIA_NOT_FOUND', 'Question not found.'); end if;
  perform public._r2s_lock_set(v_set);
  delete from public.r2_set_questions where id = p_id;
  perform public._r2s_touch(v_set);
  return jsonb_build_object('deleted', true);
end $$;

-- Validate and freeze the draft as a new version. The set keeps its code (issued on the first publication).
create or replace function public.r2s_publish_set(p_set_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.r2_sets; v_issues text[]; v_ver public.r2_versions; v_code text; q record; v_qid uuid;
begin
  perform public._require_organizer();
  s := public._r2s_lock_set(p_set_id);
  v_issues := public._r2s_publish_issues(s.id);
  if cardinality(v_issues) > 0 then perform public._err('VALIDATION', array_to_string(v_issues, ' ')); end if;
  v_code := coalesce(s.join_code, public._r2s_new_code());
  insert into public.r2_versions (set_id, version, title, section, timer_seconds, wrong_penalty_percent, published_by)
  values (s.id, s.published_version + 1, s.title, s.section, s.timer_seconds, s.wrong_penalty_percent, auth.uid())
  returning * into v_ver;
  for q in
    select x.id, x.points, x.question_text, t.name as topic_name, dense_rank() over (order by t.position, t.created_at, t.id)::int as topic_position,
           (row_number() over (order by x.points, x.created_at, x.id))::int as sort_index, a.answer_text
    from public.r2_set_questions x join public.r2_set_topics t on t.id = x.topic_id join public.r2_set_answers a on a.question_id = x.id
    where x.set_id = s.id
  loop
    insert into public.r2_version_questions (version_id, topic_name, topic_position, points, question_text, sort_index)
    values (v_ver.id, q.topic_name, q.topic_position, q.points, q.question_text, q.sort_index) returning id into v_qid;
    insert into public.r2_version_answers (question_id, answer_text) values (v_qid, q.answer_text);
  end loop;
  update public.r2_sets set join_code = v_code, published_version = v_ver.version, published_at = v_ver.published_at,
    draft_updated_at = least(draft_updated_at, v_ver.published_at), updated_at = now()
  where id = s.id;
  return jsonb_build_object('ok', true, 'join_code', v_code, 'version', v_ver.version, 'version_id', v_ver.id);
end $$;

-- ===========================================================================
-- Organizer: Join Round 2 (code → set → section → teams → Start)
-- ===========================================================================
create or replace function public.r2s_lookup(p_code text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.r2_sets; v public.r2_versions;
begin
  perform public._require_organizer();
  s := public._r2s_by_code(p_code);
  if s.id is null then perform public._err('TRIVIA_CODE_INVALID', 'No published trivia set has that code.'); end if;
  select * into v from public.r2_versions where set_id = s.id and version = s.published_version;
  return jsonb_build_object('set_id', s.id, 'join_code', s.join_code, 'version_id', v.id, 'version', v.version, 'title', v.title,
    'section', v.section, 'timer_seconds', v.timer_seconds, 'wrong_penalty_percent', v.wrong_penalty_percent, 'published_at', v.published_at,
    'question_count', (select count(*) from public.r2_version_questions where version_id = v.id),
    'topics', public._r2s_board_topics(v.id, null));
end $$;

-- Registered teams of a section that may play the set (Round 1 qualifiers of that section are flagged).
create or replace function public.r2s_eligible_teams(p_code text, p_section text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.r2_sets; v_section text := upper(btrim(coalesce(p_section, '')));
begin
  perform public._require_organizer();
  s := public._r2s_by_code(p_code);
  if s.id is null then perform public._err('TRIVIA_CODE_INVALID', 'No published trivia set has that code.'); end if;
  if v_section not in ('UG', 'PG') then perform public._err('VALIDATION', 'Choose UG or PG.'); end if;
  if (select section from public.r2_versions where set_id = s.id and version = s.published_version) not in ('BOTH', v_section) then
    perform public._err('TRIVIA_SECTION_MISMATCH', 'This trivia set is not for the ' || v_section || ' section.');
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'team_number', t.team_number, 'team_name', t.team_name,
      'participant_1', t.participant_1, 'participant_2', t.participant_2,
      'qualified', exists (select 1 from public.quiz_sessions q where q.is_current and q.section = t.section and t.id = any (q.qualifiers)))
      order by t.team_number)
    from public.teams t where t.section = v_section), '[]'::jsonb);
end $$;

-- Start a live game. Idempotent by request id; never touches another session.
create or replace function public.r2s_start_session(p_request_id uuid, p_code text, p_section text, p_team_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.r2_sets; v public.r2_versions; g public.r2_sessions; v_section text := upper(btrim(coalesce(p_section, ''))); v_ids uuid[] := coalesce(p_team_ids, '{}');
begin
  perform public._require_organizer();
  if p_request_id is null then perform public._err('VALIDATION', 'A request id is required.'); end if;
  select * into g from public.r2_sessions where request_id = p_request_id;
  if found then return jsonb_build_object('session_id', g.id, 'duplicate_request', true); end if;
  s := public._r2s_by_code(p_code);
  if s.id is null then perform public._err('TRIVIA_CODE_INVALID', 'No published trivia set has that code.'); end if;
  perform 1 from public.r2_sets where id = s.id for update;
  select * into v from public.r2_versions where set_id = s.id and version = s.published_version;
  if v_section not in ('UG', 'PG') then perform public._err('VALIDATION', 'Choose UG or PG.'); end if;
  if v.section not in ('BOTH', v_section) then perform public._err('TRIVIA_SECTION_MISMATCH', 'This trivia set is not for the ' || v_section || ' section.'); end if;
  if cardinality(v_ids) = 0 then perform public._err('VALIDATION', 'Select at least one team.'); end if;
  if cardinality(v_ids) <> (select count(distinct x) from unnest(v_ids) x) then perform public._err('VALIDATION', 'A team is selected more than once.'); end if;
  if exists (select 1 from unnest(v_ids) x where not exists (select 1 from public.teams t where t.id = x and t.section = v_section)) then
    perform public._err('TRIVIA_TEAM_NOT_ELIGIBLE', 'Every selected team must be a registered ' || v_section || ' team.');
  end if;
  insert into public.r2_sessions (request_id, set_id, version_id, section, started_by)
  values (p_request_id, s.id, v.id, v_section, auth.uid()) returning * into g;
  insert into public.r2_session_teams (session_id, team_id) select g.id, x from unnest(v_ids) x;
  return jsonb_build_object('session_id', g.id, 'duplicate_request', false, 'version', v.version);
end $$;

create or replace function public.r2s_end_session(p_session_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r2_sessions;
begin
  perform public._require_organizer();
  select * into g from public.r2_sessions where id = p_session_id for update;
  if not found then perform public._err('TRIVIA_SESSION_NOT_FOUND', 'Round 2 session not found.'); end if;
  if g.status = 'live' then
    update public.r2_sessions set status = 'ended', ended_at = now(), phase = 'idle', question_id = null, revealed_at = null,
      answer_revealed = false, updated_at = now() where id = g.id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ===========================================================================
-- Organizer: gameplay (per session)
-- ===========================================================================
-- Choosing a tile only opens the control panel; the question stays hidden.
create or replace function public.r2s_select(p_session_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r2_sessions;
begin
  perform public._require_organizer();
  g := public._r2s_lock_session(p_session_id);
  if g.phase <> 'idle' then
    if g.phase = 'selected' and g.question_id = p_question_id then return jsonb_build_object('ok', true, 'phase', g.phase); end if;
    perform public._err('TRIVIA_QUESTION_ACTIVE', 'Another question is open. Finish or cancel it first.');
  end if;
  if not exists (select 1 from public.r2_version_questions where id = p_question_id and version_id = g.version_id) then
    perform public._err('TRIVIA_NOT_FOUND', 'That question is not on this board.');
  end if;
  if exists (select 1 from public.r2_session_results where session_id = g.id and question_id = p_question_id) then
    perform public._err('TRIVIA_QUESTION_USED', 'This question has already been played.');
  end if;
  update public.r2_sessions set phase = 'selected', question_id = p_question_id, revealed_at = null, answer_revealed = false,
    last_result_id = null, updated_at = now() where id = g.id;
  return jsonb_build_object('ok', true, 'phase', 'selected');
end $$;

create or replace function public.r2s_cancel(p_session_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r2_sessions;
begin
  perform public._require_organizer();
  g := public._r2s_lock_session(p_session_id);
  if g.phase = 'revealed' then perform public._err('TRIVIA_ALREADY_REVEALED', 'The question is already on screen. Score it, or close it without points.'); end if;
  if g.phase = 'selected' then perform public._r2s_idle(g.id, null); end if;
  return jsonb_build_object('ok', true);
end $$;

-- Shows the question and starts the timer (server time). Repeating it never restarts the timer.
create or replace function public.r2s_reveal_question(p_session_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r2_sessions;
begin
  perform public._require_organizer();
  g := public._r2s_lock_session(p_session_id);
  if g.phase = 'idle' or g.question_id is distinct from p_question_id then
    perform public._err('TRIVIA_NOT_SELECTED', 'That question is not the one open on the board.');
  end if;
  if g.phase = 'selected' then
    update public.r2_sessions set phase = 'revealed', revealed_at = now(), updated_at = now() where id = g.id returning * into g;
  end if;
  return jsonb_build_object('ok', true, 'revealed_at', g.revealed_at);
end $$;

-- Shows the stored answer. Never changes a score.
create or replace function public.r2s_reveal_answer(p_session_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r2_sessions;
begin
  perform public._require_organizer();
  g := public._r2s_lock_session(p_session_id);
  if g.phase <> 'revealed' or g.question_id is distinct from p_question_id then
    perform public._err('TRIVIA_NOT_REVEALED', 'Reveal the question before its answer.');
  end if;
  update public.r2_sessions set answer_revealed = true, updated_at = now() where id = g.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public._r2s_record(g public.r2_sessions, p_request_id uuid, p_question_id uuid, t public.teams, p_result text, p_points numeric) returns bigint
language plpgsql security definer set search_path = '' as $$
declare q public.r2_version_questions; v_id bigint;
begin
  select * into q from public.r2_version_questions where id = p_question_id;
  insert into public.r2_session_results (request_id, session_id, question_id, topic_name, question_text, team_id, team_number, team_name,
    team_section, result, point_value, points, answer_revealed, revealed_at, actor)
  values (p_request_id, g.id, q.id, q.topic_name, q.question_text, t.id, t.team_number, t.team_name, t.section,
    p_result, q.points, p_points, g.answer_revealed, g.revealed_at, auth.uid())
  returning id into v_id;
  perform public._r2s_idle(g.id, v_id);
  return v_id;
end $$;

-- Right/Wrong for the team the host confirmed: atomic, idempotent by request id, once per question per session.
create or replace function public.r2s_score(p_request_id uuid, p_session_id uuid, p_question_id uuid, p_team_id uuid, p_result text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r2_sessions; r public.r2_session_results; t public.teams; v public.r2_versions; v_pts numeric; v_id bigint;
begin
  perform public._require_organizer();
  if p_request_id is null then perform public._err('VALIDATION', 'A request id is required.'); end if;
  select * into r from public.r2_session_results where request_id = p_request_id;
  if found then
    return jsonb_build_object('duplicate_request', true, 'result_id', r.id, 'result', r.result, 'team_id', r.team_id, 'points', r.points);
  end if;
  g := public._r2s_lock_session(p_session_id);
  if p_result is null or p_result not in ('right', 'wrong') then perform public._err('VALIDATION', 'The result must be right or wrong.'); end if;
  if exists (select 1 from public.r2_session_results where session_id = g.id and question_id = p_question_id) then
    perform public._err('TRIVIA_QUESTION_USED', 'This question has already been scored.');
  end if;
  if g.phase <> 'revealed' or g.question_id is distinct from p_question_id then
    perform public._err('TRIVIA_NOT_REVEALED', 'Reveal the question before scoring it.');
  end if;
  select tm.* into t from public.teams tm join public.r2_session_teams st on st.team_id = tm.id and st.session_id = g.id where tm.id = p_team_id;
  if not found then perform public._err('TRIVIA_TEAM_NOT_IN_ROUND', 'That team is not playing in this Round 2 session.'); end if;
  select * into v from public.r2_versions where id = g.version_id;
  v_pts := public._r2_delta((select points from public.r2_version_questions where id = p_question_id), p_result, v.wrong_penalty_percent);
  v_id := public._r2s_record(g, p_request_id, p_question_id, t, p_result, v_pts);
  return jsonb_build_object('duplicate_request', false, 'result_id', v_id, 'result', p_result, 'team_id', t.id, 'points', v_pts);
end $$;

-- Close a revealed question without points (e.g. nobody answered). Marks it used.
create or replace function public.r2s_close_question(p_request_id uuid, p_session_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r2_sessions; r public.r2_session_results; v_id bigint; t public.teams;
begin
  perform public._require_organizer();
  if p_request_id is null then perform public._err('VALIDATION', 'A request id is required.'); end if;
  select * into r from public.r2_session_results where request_id = p_request_id;
  if found then return jsonb_build_object('duplicate_request', true, 'result_id', r.id, 'result', r.result, 'points', r.points); end if;
  g := public._r2s_lock_session(p_session_id);
  if exists (select 1 from public.r2_session_results where session_id = g.id and question_id = p_question_id) then
    perform public._err('TRIVIA_QUESTION_USED', 'This question has already been scored.');
  end if;
  if g.phase <> 'revealed' or g.question_id is distinct from p_question_id then
    perform public._err('TRIVIA_NOT_REVEALED', 'Only a revealed question can be closed without points. Use Cancel instead.');
  end if;
  v_id := public._r2s_record(g, p_request_id, p_question_id, t, 'no_score', 0);
  return jsonb_build_object('duplicate_request', false, 'result_id', v_id, 'result', 'no_score', 'points', 0);
end $$;

-- Board of one session. The question text appears only after Reveal Question and the answer only after
-- Answer. p_host adds the score log and lets the host's own screen peek at the answer of a revealed question.
create or replace function public.r2s_board(p_session_id uuid, p_host boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare g public.r2_sessions; v public.r2_versions; q public.r2_version_questions; s public.r2_sets;
begin
  perform public._require_organizer();
  select * into g from public.r2_sessions where id = p_session_id;
  if not found then perform public._err('TRIVIA_SESSION_NOT_FOUND', 'Round 2 session not found.'); end if;
  select * into v from public.r2_versions where id = g.version_id;
  select * into s from public.r2_sets where id = g.set_id;
  if g.question_id is not null then select * into q from public.r2_version_questions where id = g.question_id; end if;
  return jsonb_build_object(
    'server_now', now(),
    'session', jsonb_build_object('id', g.id, 'status', g.status, 'section', g.section, 'started_at', g.started_at, 'ended_at', g.ended_at,
      'title', v.title, 'version', v.version, 'join_code', s.join_code, 'set_id', g.set_id),
    'settings', jsonb_build_object('timer_seconds', v.timer_seconds, 'wrong_penalty_percent', v.wrong_penalty_percent),
    'topics', public._r2s_board_topics(v.id, g.id),
    'game', jsonb_build_object(
      'phase', g.phase, 'question_id', g.question_id, 'topic', q.topic_name, 'points', q.points,
      'question_text', case when g.phase = 'revealed' then q.question_text end,
      'answer_revealed', g.answer_revealed,
      'answer_text', case when g.phase = 'revealed' and (g.answer_revealed or p_host) then (select answer_text from public.r2_version_answers where question_id = q.id) end,
      'revealed_at', g.revealed_at, 'last_result_id', g.last_result_id),
    'scores', public._r2s_scores(g.id),
    'last_result', (select jsonb_build_object('id', r.id, 'result', r.result, 'points', r.points, 'point_value', r.point_value, 'topic', r.topic_name,
        'team_name', r.team_name, 'team_number', r.team_number, 'section', r.team_section)
      from public.r2_session_results r where r.id = g.last_result_id),
    'results', case when p_host then coalesce((select jsonb_agg(to_jsonb(r) - 'request_id' order by r.id) from public.r2_session_results r where r.session_id = g.id), '[]'::jsonb) end);
end $$;

-- ===========================================================================
-- Keep prepared questions: copy the migration-7 board (if any) into a draft set, once.
-- ===========================================================================
do $$
declare v_set uuid; t record; q record; v_topic uuid; v_q uuid;
begin
  if exists (select 1 from public.r2_topics) and not exists (select 1 from public.r2_sets) then
    insert into public.r2_sets (title, section, timer_seconds, wrong_penalty_percent)
    select 'Round 2 board (imported)', 'BOTH', coalesce(st.timer_seconds, 18), coalesce(st.wrong_penalty_percent, 50)
    from (select 1) x left join public.r2_settings st on st.id = 1
    returning id into v_set;
    for t in select * from public.r2_topics order by position, created_at loop
      insert into public.r2_set_topics (set_id, name, position, created_at) values (v_set, t.name, t.position, t.created_at) returning id into v_topic;
      for q in select x.*, a.answer_text from public.r2_questions x left join public.r2_answers a on a.question_id = x.id where x.topic_id = t.id order by x.created_at loop
        insert into public.r2_set_questions (set_id, topic_id, points, question_text, created_at) values (v_set, v_topic, q.points, q.question_text, q.created_at) returning id into v_q;
        if q.answer_text is not null then insert into public.r2_set_answers (question_id, answer_text) values (v_q, q.answer_text); end if;
      end loop;
    end loop;
  end if;
end $$;

-- ===========================================================================
-- Security: RLS (organizer read only, answers never readable directly), Realtime, function permissions
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['r2_sets', 'r2_set_topics', 'r2_set_questions', 'r2_set_answers', 'r2_versions', 'r2_version_questions',
                           'r2_version_answers', 'r2_sessions', 'r2_session_teams', 'r2_session_results'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated, public', t);
  end loop;
  -- Organizers may read everything except the answer tables (answers only via organizer RPCs; needed for Realtime).
  foreach t in array array['r2_sets', 'r2_set_topics', 'r2_set_questions', 'r2_versions', 'r2_version_questions',
                           'r2_sessions', 'r2_session_teams', 'r2_session_results'] loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_organizer_read', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.is_organizer()))', t || '_organizer_read', t);
  end loop;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['r2_sets', 'r2_set_topics', 'r2_set_questions', 'r2_sessions', 'r2_session_teams', 'r2_session_results'] loop
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

-- Organizer RPCs (each checks organizer membership internally). Round 1 list unchanged from migration 9.
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

-- … and trivia sets, versions and sessions (this migration).
grant execute on function
  public.r2s_overview(), public.r2s_set_detail(uuid), public.r2s_save_set(jsonb), public.r2s_delete_set(uuid), public.r2s_archive_set(uuid),
  public.r2s_save_topic(jsonb), public.r2s_delete_topic(uuid), public.r2s_save_question(jsonb), public.r2s_delete_question(uuid),
  public.r2s_publish_set(uuid), public.r2s_lookup(text), public.r2s_eligible_teams(text, text),
  public.r2s_start_session(uuid, text, text, uuid[]), public.r2s_end_session(uuid),
  public.r2s_select(uuid, uuid), public.r2s_cancel(uuid), public.r2s_reveal_question(uuid, uuid), public.r2s_reveal_answer(uuid, uuid),
  public.r2s_score(uuid, uuid, uuid, uuid, text), public.r2s_close_question(uuid, uuid, uuid), public.r2s_board(uuid, boolean)
to authenticated;

-- Registration desk RPCs (each checks registration staff OR organizer internally).
grant execute on function
  public.registration_access(), public.is_registration_staff(), public.reg_overview(), public.reg_save_team(jsonb)
to authenticated;

-- Participant RPCs: unchanged from migration 9.
grant execute on function
  public.join_lookup(text), public.join_roster(text, text), public.join_registered_team(text, text, integer, text),
  public.join_team(text, integer, text, text),
  public.register_team(text, text, text, text, text, text), public.participant_state(text, integer),
  public.participant_start(text), public.participant_submit(text, uuid, uuid, text), public.participant_finish(text),
  public.participant_leave(text)
to anon, authenticated;

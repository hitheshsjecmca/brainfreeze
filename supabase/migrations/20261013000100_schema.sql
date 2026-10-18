-- BRAINFREZE — COLD START · schema
-- Tables, keys, constraints and indexes. Security (RLS, grants, realtime) is
-- in 20261013000300_security.sql; server-side logic in 20261013000200_functions.sql.

-- ---------------------------------------------------------------------------
-- Organizers: only users listed here may read or change quiz data.
-- Add one with:  insert into public.organizers (user_id, display_name)
--                select id, 'Quiz Master' from auth.users where email = 'you@example.com';
-- ---------------------------------------------------------------------------
create table if not exists public.organizers (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 80),
  role         text not null default 'organizer' check (role in ('organizer', 'admin')),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Teams: max 50, exactly two participants, unique team number.
-- ---------------------------------------------------------------------------
create table if not exists public.teams (
  id            uuid primary key default gen_random_uuid(),
  team_number   integer not null check (team_number between 1 and 999),
  team_name     text not null check (char_length(btrim(team_name)) between 1 and 80),
  participant_1 text not null check (char_length(btrim(participant_1)) between 1 and 80),
  participant_2 text not null check (char_length(btrim(participant_2)) between 1 and 80),
  is_demo       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint teams_team_number_key unique (team_number)
);

-- ---------------------------------------------------------------------------
-- Questions (public part) and answer keys (private part) are separate tables
-- so a query for question content can never return the answer key.
-- ---------------------------------------------------------------------------
create table if not exists public.questions (
  id              uuid primary key default gen_random_uuid(),
  position        integer not null check (position >= 1),
  question_text   text not null check (char_length(btrim(question_text)) between 1 and 1000),
  option_a        text not null check (char_length(btrim(option_a)) between 1 and 300),
  option_b        text not null check (char_length(btrim(option_b)) between 1 and 300),
  option_c        text not null check (char_length(btrim(option_c)) between 1 and 300),
  option_d        text not null check (char_length(btrim(option_d)) between 1 and 300),
  image_url       text check (image_url is null or (char_length(image_url) <= 700000 and (image_url ~* '^https://' or image_url ~* '^data:image/(png|jpe?g|gif|webp);base64,'))),
  category        text check (category is null or char_length(category) <= 80),
  marks_correct   numeric(6, 2) check (marks_correct is null or marks_correct between 0 and 100),
  marks_incorrect numeric(6, 2) check (marks_incorrect is null or marks_incorrect between -100 and 0),
  is_sample       boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint questions_position_key unique (position) deferrable initially deferred
);

create table if not exists public.question_keys (
  question_id    uuid primary key references public.questions (id) on delete cascade,
  correct_option char(1) not null check (correct_option in ('A', 'B', 'C', 'D')),
  explanation    text check (explanation is null or char_length(explanation) <= 2000),
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Quiz sessions. Exactly one is current; older ones are archived.
-- Timer = elapsed_ms + (now() - timer_started_at) while running.
-- ---------------------------------------------------------------------------
create table if not exists public.quiz_sessions (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null default 'COLD START' check (char_length(name) <= 80),
  is_current              boolean not null default true,
  status                  text not null default 'setup' check (status in ('setup', 'running', 'paused', 'ended', 'finalized')),
  current_index           integer not null default 0 check (current_index >= 0),
  completed_question_ids  uuid[] not null default '{}',
  started_at              timestamptz,
  timer_started_at        timestamptz,
  elapsed_ms              bigint not null default 0 check (elapsed_ms >= 0),
  ended_at                timestamptz,
  corrections_enabled     boolean not null default false,
  projector_view          text not null default 'standby' check (projector_view in ('standby', 'question', 'leaderboard', 'reveal')),
  results_revealed        boolean not null default false,
  qualifiers              uuid[],
  qualifiers_confirmed_at timestamptz,
  qualification_note      text check (qualification_note is null or char_length(qualification_note) <= 500),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint quiz_sessions_timer_ck check ((status = 'running') = (timer_started_at is not null)),
  constraint quiz_sessions_reveal_ck check (not results_revealed or status = 'finalized'),
  constraint quiz_sessions_qualifiers_ck check ((status = 'finalized') = (qualifiers is not null))
);
create unique index if not exists quiz_sessions_one_current on public.quiz_sessions (is_current) where is_current;

create table if not exists public.quiz_settings (
  session_id        uuid primary key references public.quiz_sessions (id) on delete cascade,
  duration_seconds  integer not null default 1800 check (duration_seconds between 60 and 14400),
  marks_correct     numeric(6, 2) not null default 1 check (marks_correct between 0 and 100),
  marks_incorrect   numeric(6, 2) not null default -0.25 check (marks_incorrect between -100 and 0),
  marks_unanswered  numeric(6, 2) not null default 0 check (marks_unanswered between -100 and 100),
  qualify_count     integer not null default 5 check (qualify_count between 1 and 50),
  accuracy_tiebreak boolean not null default true,
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Recorded answers: one row per (session, team, question) — the unique
-- constraint is the final guard against duplicate scoring.
-- ---------------------------------------------------------------------------
create table if not exists public.team_answers (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.quiz_sessions (id) on delete cascade,
  team_id         uuid not null references public.teams (id) on delete cascade,
  question_id     uuid not null references public.questions (id) on delete cascade,
  selected_option char(1) check (selected_option in ('A', 'B', 'C', 'D')),
  result          text not null check (result in ('correct', 'incorrect', 'unanswered')),
  points          numeric(6, 2) not null,
  recorded_by     uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint team_answers_one_per_question unique (session_id, team_id, question_id),
  constraint team_answers_unanswered_ck check ((selected_option is null) = (result = 'unanswered'))
);
create index if not exists team_answers_session_question_idx on public.team_answers (session_id, question_id);
create index if not exists team_answers_team_idx on public.team_answers (team_id);
create index if not exists team_answers_question_idx on public.team_answers (question_id);

-- ---------------------------------------------------------------------------
-- Append-only audit history of every score change and sensitive action.
-- request_id makes retried client requests idempotent.
-- ---------------------------------------------------------------------------
create table if not exists public.score_events (
  id                bigint generated by default as identity primary key,
  session_id        uuid not null references public.quiz_sessions (id) on delete cascade,
  request_id        uuid unique,
  action            text not null check (action in ('record', 'correction', 'undo', 'rescore', 'delete_team', 'delete_question', 'authorize', 'tiebreak', 'qualify', 'reopen', 'restore')),
  team_id           uuid references public.teams (id) on delete set null,
  team_number       integer,
  question_id       uuid references public.questions (id) on delete set null,
  question_position integer,
  prev_selected     char(1),
  prev_result       text,
  prev_points       numeric(6, 2),
  new_selected      char(1),
  new_result        text,
  new_points        numeric(6, 2),
  undone            boolean not null default false,
  undo_of           bigint references public.score_events (id) on delete set null,
  reason            text check (reason is null or char_length(reason) <= 500),
  actor             uuid,
  created_at        timestamptz not null default now()
);
create index if not exists score_events_session_idx on public.score_events (session_id, id desc);

-- ---------------------------------------------------------------------------
-- Tie-break results entered by the organizer (higher score wins).
-- ---------------------------------------------------------------------------
create table if not exists public.tiebreak_results (
  session_id  uuid not null references public.quiz_sessions (id) on delete cascade,
  team_id     uuid not null references public.teams (id) on delete cascade,
  score       numeric(10, 2) not null check (abs(score) <= 100000),
  note        text check (note is null or char_length(note) <= 300),
  recorded_at timestamptz not null default now(),
  primary key (session_id, team_id)
);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create or replace function public.tg_set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists teams_updated_at on public.teams;
create trigger teams_updated_at before update on public.teams for each row execute function public.tg_set_updated_at();
drop trigger if exists questions_updated_at on public.questions;
create trigger questions_updated_at before update on public.questions for each row execute function public.tg_set_updated_at();
drop trigger if exists question_keys_updated_at on public.question_keys;
create trigger question_keys_updated_at before update on public.question_keys for each row execute function public.tg_set_updated_at();
drop trigger if exists quiz_sessions_updated_at on public.quiz_sessions;
create trigger quiz_sessions_updated_at before update on public.quiz_sessions for each row execute function public.tg_set_updated_at();
drop trigger if exists quiz_settings_updated_at on public.quiz_settings;
create trigger quiz_settings_updated_at before update on public.quiz_settings for each row execute function public.tg_set_updated_at();
drop trigger if exists team_answers_updated_at on public.team_answers;
create trigger team_answers_updated_at before update on public.team_answers for each row execute function public.tg_set_updated_at();

-- Team capacity (50). Advisory lock serializes concurrent inserts.
create or replace function public.tg_teams_capacity() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('brainfreze.teams.capacity'));
  if (select count(*) from public.teams) >= 50 then
    raise exception using errcode = 'P0001', message = 'TEAM_CAPACITY: The 50-team capacity has been reached.';
  end if;
  return new;
end $$;
drop trigger if exists teams_capacity on public.teams;
create trigger teams_capacity before insert on public.teams for each row execute function public.tg_teams_capacity();

-- Audit rows are append-only: only the `undone` flag may flip false -> true.
create or replace function public.tg_score_events_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    -- Deletes happen only via cascades from quiz_sessions (restore / cleanup).
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception using errcode = 'P0001', message = 'AUDIT_IMMUTABLE: Audit history cannot be deleted.';
  end if;
  if new.id <> old.id or new.session_id <> old.session_id or new.action <> old.action
     or new.request_id is distinct from old.request_id
     or new.prev_selected is distinct from old.prev_selected or new.prev_points is distinct from old.prev_points
     or new.new_selected is distinct from old.new_selected or new.new_points is distinct from old.new_points
     or new.reason is distinct from old.reason or new.created_at <> old.created_at
     or (old.undone and not new.undone) then
    -- team_id / question_id / undo_of may be nulled by ON DELETE SET NULL.
    raise exception using errcode = 'P0001', message = 'AUDIT_IMMUTABLE: Audit history is append-only.';
  end if;
  return new;
end $$;
drop trigger if exists score_events_append_only on public.score_events;
create trigger score_events_append_only before update or delete on public.score_events for each row execute function public.tg_score_events_append_only();

-- Initial session.
insert into public.quiz_sessions (is_current)
select true where not exists (select 1 from public.quiz_sessions where is_current);
insert into public.quiz_settings (session_id)
select id from public.quiz_sessions s where is_current and not exists (select 1 from public.quiz_settings x where x.session_id = s.id);

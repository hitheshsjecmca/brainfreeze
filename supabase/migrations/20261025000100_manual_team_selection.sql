-- Migration 15 — Manual team selection for every round; no fixed team-count limits.
--
-- Round 1 (COLD START quiz sets):
--   * Each set has its own organiser-chosen participants (quiz_sessions.team_ids). Only those teams appear in the join
--     roster, can join on a device, can be scored on paper, and are counted in the set's results. Nothing is carried over
--     from another set or round. set_set_teams(set, team ids, reason) replaces the selection: freely before the set
--     starts; while it is live only as an audited correction with a reason (a team that has started or has answers cannot
--     be removed); never after it has ended. start_quiz refuses a set with no selected teams.
--   * Existing sets are back-filled with the teams that actually took part (an attempt or an answer), so live and
--     completed results are unchanged for those teams. Draft sets start with no selection.
--   * Walk-in registration on the join page still registers the team, but it joins a set only after the organiser
--     selects it (register_team now returns TEAM_NOT_SELECTED with the new team number).
-- Round 3: an auction takes ANY number of different registered teams (at least one) instead of exactly three.
-- Round 2 already accepted any number of teams (at least one, no duplicates) and is unchanged.
-- Limits removed: the 50-teams-per-section registration cap (trigger, import, walk-in registration), the 1–50 range of
-- the Round 1 results highlight (qualify_count ≥ 1 now), and team numbers widen from 1–999 to 1–99999.
-- No data is deleted. Function permissions are re-applied in full at the end.

-- ===========================================================================
-- Schema
-- ===========================================================================
alter table public.quiz_sessions add column if not exists team_ids uuid[] not null default '{}';

-- Back-fill: the teams that actually took part in each existing set.
update public.quiz_sessions s set team_ids = coalesce((
  select array_agg(distinct x.team_id order by x.team_id) from (
    select a.team_id from public.quiz_attempts a where a.session_id = s.id and a.status <> 'reset'
    union select a.team_id from public.team_answers a where a.session_id = s.id) x
  where exists (select 1 from public.teams t where t.id = x.team_id and t.section = s.section)), '{}')
where s.team_ids = '{}';

-- A deleted team leaves every selection.
create or replace function public.tg_teams_unselect() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.quiz_sessions set team_ids = array_remove(team_ids, old.id) where old.id = any (team_ids);
  return old;
end $$;
drop trigger if exists teams_unselect on public.teams;
create trigger teams_unselect after delete on public.teams for each row execute function public.tg_teams_unselect();

-- No registration cap per section (the trigger of migration 5 is removed; the function stays unused).
drop trigger if exists teams_capacity on public.teams;

alter table public.teams drop constraint if exists teams_team_number_check;
alter table public.teams add constraint teams_team_number_check check (team_number between 1 and 99999);

alter table public.quiz_settings drop constraint if exists quiz_settings_qualify_count_check;
alter table public.quiz_settings add constraint quiz_settings_qualify_count_check check (qualify_count >= 1);

-- Round 3 seats were limited to 1–3; any number of teams now.
alter table public.r3_session_teams drop constraint if exists r3_session_teams_seat_check;
alter table public.r3_session_teams add constraint r3_session_teams_seat_check check (seat >= 1);

alter table public.score_events drop constraint if exists score_events_action_check;
alter table public.score_events add constraint score_events_action_check check (action in (
  'record', 'correction', 'undo', 'rescore', 'delete_team', 'delete_question', 'authorize', 'tiebreak', 'qualify',
  'reopen', 'restore', 'attempt_reset', 'attempt_finalize', 'key_change', 'participants'));

-- ===========================================================================
-- Round 1: the selected teams are the set's roster
-- ===========================================================================
create or replace function public._roster(p_session uuid) returns table (team_id uuid)
language sql stable security definer set search_path = '' as $$
  select t.id from public.quiz_sessions s join public.teams t on t.id = any (s.team_ids) and t.section = s.section
  where s.id = p_session;
$$;

create or replace function public._team_selected(s public.quiz_sessions, p_team uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_team = any (s.team_ids);
$$;

-- Another active (not archived) set of the section that the team is selected for or took part in.
create or replace function public._team_other_set(s public.quiz_sessions, p_team uuid) returns text
language sql stable security definer set search_path = '' as $$
  select x.name from public.quiz_sessions x
  where x.is_current and x.section = s.section and x.id <> s.id
    and (p_team = any (x.team_ids)
         or exists (select 1 from public.quiz_attempts a where a.session_id = x.id and a.team_id = p_team and a.status <> 'reset')
         or exists (select 1 from public.team_answers a where a.session_id = x.id and a.team_id = p_team))
  order by x.created_at limit 1;
$$;

-- Replace a set's participants. Before the set starts: free. While it is live: an audited correction (reason
-- required); a team that has started or has recorded answers cannot be removed. After it has ended: refused.
-- Any number of teams; duplicates are refused; every team must be a registered team of the set's section.
create or replace function public.set_set_teams(p_set_id uuid, p_team_ids uuid[], p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.quiz_sessions; v_ids uuid[] := coalesce(p_team_ids, '{}'); v_reason text := public._clean(p_reason);
  v_old uuid[]; v_added uuid[]; v_removed uuid[]; v_bad text; x uuid; a public.quiz_attempts; t public.teams; v_live boolean;
begin
  perform public._require_organizer();
  select * into s from public.quiz_sessions where id = p_set_id for update;
  if not found then perform public._err('SET_NOT_FOUND', 'Quiz set not found.'); end if;
  if not s.is_current then perform public._err('INVALID_STATE', 'This set is archived.'); end if;
  if s.status in ('ended', 'finalized') then perform public._err('INVALID_STATE', 'This set has ended; its participants are final.'); end if;
  if array_position(v_ids, null) is not null then perform public._err('VALIDATION', 'Unknown team.'); end if;
  if cardinality(v_ids) <> (select count(distinct y) from unnest(v_ids) y) then
    perform public._err('DUPLICATE_TEAM', 'A team is selected more than once.');
  end if;
  if exists (select 1 from unnest(v_ids) y where not exists (select 1 from public.teams t2 where t2.id = y and t2.section = s.section)) then
    perform public._err('TEAM_NOT_ELIGIBLE', 'Every selected team must be a registered ' || s.section || ' team.');
  end if;
  select format('Team %s already takes part in "%s". Archive that set first or choose another team.', t2.team_number, public._team_other_set(s, t2.id))
    into v_bad from public.teams t2 where t2.id = any (v_ids) and public._team_other_set(s, t2.id) is not null order by t2.team_number limit 1;
  if v_bad is not null then perform public._err('TEAM_IN_OTHER_SET', v_bad); end if;
  v_live := s.status in ('running', 'paused');
  v_old := array(select y from unnest(s.team_ids) y where exists (select 1 from public.teams t2 where t2.id = y));
  v_added := array(select y from unnest(v_ids) y where not (y = any (v_old)));
  v_removed := array(select y from unnest(v_old) y where not (y = any (v_ids)));
  if cardinality(v_added) + cardinality(v_removed) = 0 then
    return jsonb_build_object('ok', true, 'count', cardinality(v_ids), 'added', 0, 'removed', 0);
  end if;
  if v_live and (v_reason is null or char_length(v_reason) > 200) then
    perform public._err('REASON_REQUIRED', 'The set is live: give a reason for changing its participants (max 200 characters).');
  end if;
  if v_live and cardinality(v_ids) = 0 then perform public._err('VALIDATION', 'A live set needs at least one team.'); end if;
  foreach x in array v_removed loop
    select * into t from public.teams where id = x;
    if exists (select 1 from public.team_answers where session_id = s.id and team_id = x) then
      perform public._err('TEAM_HAS_ANSWERS', format('Team %s already has recorded answers in this set and cannot be removed.', t.team_number));
    end if;
    a := public._active_attempt(s.id, x);
    if a.id is not null then
      if a.status <> 'ready' then perform public._err('TEAM_STARTED', format('Team %s has started this quiz and cannot be removed.', t.team_number)); end if;
      update public.quiz_attempts set status = 'reset', reset_at = now(), reset_by = auth.uid(), reset_reason = 'Removed from the set''s participants'
      where id = a.id;
    end if;
    update public.participant_sessions set revoked_at = now(), revoked_reason = 'Removed from the set''s participants'
    where session_id = s.id and team_id = x and revoked_at is null;
  end loop;
  update public.quiz_sessions set team_ids = v_ids where id = s.id;
  insert into public.score_events (session_id, action, reason, actor)
  values (s.id, 'participants', format('Participants: %s selected (+%s, −%s)%s', cardinality(v_ids), cardinality(v_added), cardinality(v_removed),
    case when v_live then ' — correction: ' || v_reason when v_reason is not null then ' — ' || v_reason else '' end), auth.uid());
  return jsonb_build_object('ok', true, 'count', cardinality(v_ids), 'added', cardinality(v_added), 'removed', cardinality(v_removed));
end $$;

create or replace function public.start_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status <> 'setup' then perform public._err('INVALID_STATE', 'The set is already live or completed.'); end if;
  if s.published_at is null then perform public._err('NOT_PUBLISHED', 'Publish the set before going live.'); end if;
  if not exists (select 1 from public._roster(s.id)) then
    perform public._err('QUIZ_NO_TEAMS', 'Select and confirm the participating teams before starting the set.');
  end if;
  perform public._settings(s.id);
  update public.quiz_sessions set status = 'running', started_at = now(), timer_started_at = now(), elapsed_ms = 0,
    current_index = 0, projector_view = 'question', paused_at = null
  where id = s.id;
  return jsonb_build_object('ok', true, 'server_now', now());
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
  if not public._team_selected(s, t.id) then
    perform public._err('TEAM_NOT_SELECTED', format('Team %s is not a participant of this set. Add it to the set''s participants first.', t.team_number));
  end if;
  if public._team_other_set(s, t.id) is not null then
    perform public._err('TEAM_IN_OTHER_SET', format('Team %s takes part in "%s".', t.team_number, public._team_other_set(s, t.id)));
  end if;
  if not exists (select 1 from public._session_questions(s) sq where sq.id = p_question_id) then perform public._err('QUESTION_NOT_IN_QUIZ'); end if;
  a := public._active_attempt(s.id, t.id);
  return public._record(s, st, t, p_question_id, public._normalize_option(p_selected), p_request_id, p_correction, p_reason, 'organizer',
    a.id, null, s.status = 'running' and public._elapsed_ms(s) < st.duration_seconds::bigint * 1000);
end $$;

-- Join roster: only the set's selected teams.
create or replace function public.join_roster(p_code text, p_section text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text := public._client_key(); s public.quiz_sessions; v_section text := upper(btrim(coalesce(p_section, '')));
begin
  if public._join_rate_limited(k) then return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED'); end if;
  s := public._quiz_by_code(p_code);
  if s.id is null then
    perform public._log_join_attempt(k, 'code', false);
    return jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  end if;
  if v_section not in ('UG', 'PG') then return jsonb_build_object('ok', false, 'error', 'VALIDATION', 'message', 'Choose UG or PG.'); end if;
  if v_section <> s.section then return jsonb_build_object('ok', false, 'error', 'SECTION_MISMATCH', 'section', s.section); end if;
  return jsonb_build_object('ok', true, 'section', s.section, 'teams', coalesce((
    select jsonb_agg(jsonb_build_object(
      'team_number', t.team_number, 'team_name', t.team_name, 'participant_1', t.participant_1, 'participant_2', t.participant_2,
      'joined', exists (select 1 from public.participant_sessions p
                        where p.session_id = s.id and p.team_id = t.id and p.revoked_at is null and p.expires_at > now()))
      order by t.team_number)
    from public.teams t
    where t.section = s.section and t.id = any (s.team_ids) and public._team_other_set(s, t.id) is null
      and (s.registration_open or (public._active_attempt(s.id, t.id)).id is not null)), '[]'::jsonb));
end $$;

create or replace function public.join_registered_team(p_code text, p_section text, p_team_number integer, p_device_label text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text := public._client_key(); s public.quiz_sessions; t public.teams; tok text; v_section text := upper(btrim(coalesce(p_section, '')));
begin
  if public._join_rate_limited(k) then return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED'); end if;
  s := public._quiz_by_code(p_code);
  if s.id is null then
    perform public._log_join_attempt(k, 'code', false);
    return jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  end if;
  if v_section not in ('UG', 'PG') then return jsonb_build_object('ok', false, 'error', 'VALIDATION', 'message', 'Choose UG or PG.'); end if;
  if v_section <> s.section then return jsonb_build_object('ok', false, 'error', 'SECTION_MISMATCH', 'section', s.section); end if;
  perform 1 from public.quiz_sessions where id = s.id for update; -- serialize joins
  select * into s from public.quiz_sessions where id = s.id;
  select * into t from public.teams where team_number = p_team_number and section = s.section;
  if t.id is null then
    perform public._log_join_attempt(k, 'pin', false); -- failed team sign-in (same rate limit as the PIN sign-in)
    return jsonb_build_object('ok', false, 'error', 'TEAM_NOT_REGISTERED');
  end if;
  if not public._team_selected(s, t.id) then return jsonb_build_object('ok', false, 'error', 'TEAM_NOT_SELECTED'); end if;
  if public._team_other_set(s, t.id) is not null then return jsonb_build_object('ok', false, 'error', 'TEAM_IN_OTHER_SET'); end if;
  if not s.registration_open and (public._active_attempt(s.id, t.id)).id is null then
    return jsonb_build_object('ok', false, 'error', 'REGISTRATION_CLOSED');
  end if;
  if exists (select 1 from public.participant_sessions where session_id = s.id and team_id = t.id and revoked_at is null and expires_at > now()) then
    return jsonb_build_object('ok', false, 'error', 'TEAM_ALREADY_JOINED');
  end if;
  if (public._active_attempt(s.id, t.id)).id is null then perform public._make_attempt(s, t.id); end if;
  tok := public._open_participant_session(s, t, p_device_label);
  return jsonb_build_object('ok', true, 'token', tok, 'team', public._team_public(t), 'quiz_title', s.name, 'section', s.section);
end $$;

-- Older PIN sign-in: also only for the set's selected teams.
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
  select * into s from public.quiz_sessions where id = s.id;
  select * into t from public.teams where team_number = p_team_number and section = s.section;
  select pin into v_pin from public.team_credentials where team_id = t.id;
  if t.id is null or v_pin is null or v_pin <> upper(btrim(coalesce(p_pin, ''))) then
    perform public._log_join_attempt(k, 'pin', false);
    return jsonb_build_object('ok', false, 'error', 'INVALID_TEAM_OR_PIN');
  end if;
  if not public._team_selected(s, t.id) then return jsonb_build_object('ok', false, 'error', 'TEAM_NOT_SELECTED'); end if;
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
  if (public._active_attempt(s.id, t.id)).id is null then perform public._make_attempt(s, t.id); end if;
  tok := public._open_participant_session(s, t, p_device_label);
  return jsonb_build_object('ok', true, 'token', tok, 'team', public._team_public(t), 'quiz_title', s.name, 'section', s.section);
end $$;

-- Walk-in registration: registers the team (no section cap) but does not join it — the organiser selects it first.
create or replace function public.register_team(p_code text, p_team_name text, p_participant_1 text, p_participant_2 text,
  p_college_name text, p_device_label text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k text := public._client_key(); s public.quiz_sessions; t public.teams; v_num integer;
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
  perform pg_advisory_xact_lock(hashtext('brainfreze.teams.number.' || s.section));
  select min(n) into v_num from generate_series(1, coalesce((select max(team_number) from public.teams where section = s.section), 0) + 1) n
  where not exists (select 1 from public.teams x where x.section = s.section and x.team_number = n);
  insert into public.teams (section, team_number, team_name, participant_1, participant_2, college_name, self_registered)
  values (s.section, v_num, v_name, v_p1, v_p2, v_college, true) returning * into t;
  insert into public.registration_events (team_id, section, team_number, action, actor_role)
  values (t.id, s.section, v_num, 'create', 'registration');
  return jsonb_build_object('ok', false, 'error', 'TEAM_NOT_SELECTED', 'registered', true, 'team_number', v_num, 'section', s.section);
end $$;

create or replace function public.reg_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require_registrar();
  return jsonb_build_object(
    'server_now', now(),
    'capacity', null,
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

-- ===========================================================================
-- Registration: no section cap; team numbers 1–99999
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
  if v_num_txt !~ '^[0-9]{1,5}$' or v_num_txt::int < 1 then
    perform public._err('VALIDATION', 'Team number must be a whole number from 1 to 99999.');
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
-- Backup restore: also restores each set's participants (older backups: the teams that took part)
-- ===========================================================================
create or replace function public.restore_backup(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ver integer; v_sessions jsonb; item jsonb; sess jsonb; v_sid uuid; v_status text; v_section text; v_ids uuid[] := '{}';
  v_frozen timestamptz; v_shift bigint; v_fill uuid[] := '{}';
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
      qualifiers, qualifiers_confirmed_at, qualification_note, published_at, published_by, created_at, team_ids)
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
      coalesce((sess->>'created_at')::timestamptz, now()),
      case when jsonb_typeof(sess->'team_ids') = 'array'
        then array(select distinct (jsonb_array_elements_text(sess->'team_ids'))::uuid) else '{}' end);
    -- Backups made before migration 15 have no selection: the set's participants are the teams that took part.
    if coalesce(jsonb_typeof(sess->'team_ids'), '') <> 'array' then v_fill := v_fill || v_sid; end if;
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

  update public.quiz_sessions s set team_ids = coalesce((
    select array_agg(distinct x.team_id order by x.team_id) from (
      select a.team_id from public.quiz_attempts a where a.session_id = s.id and a.status <> 'reset'
      union select a.team_id from public.team_answers a where a.session_id = s.id) x), '{}')
  where s.id = any (v_fill);

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
-- Round 3: any number of different registered teams (at least one)
-- ===========================================================================
create or replace function public.r3s_start_session(p_request_id uuid, p_code text, p_section text, p_team_ids uuid[], p_settings jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.r3_sets; v public.r3_versions; g public.r3_sessions; v_section text := upper(btrim(coalesce(p_section, ''))); v_ids uuid[] := coalesce(p_team_ids, '{}');
  v_bid integer; v_ans integer;
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
  if cardinality(v_ids) = 0 then perform public._err('R3_TEAM_COUNT', 'Select at least one team.'); end if;
  if array_position(v_ids, null) is not null then perform public._err('VALIDATION', 'Unknown team.'); end if;
  if (select count(distinct x) from unnest(v_ids) x) <> cardinality(v_ids) then perform public._err('DUPLICATE_TEAM', 'A team is selected more than once.'); end if;
  if exists (select 1 from unnest(v_ids) x where not exists (select 1 from public.teams t where t.id = x and t.section = v_section)) then
    perform public._err('R3_TEAM_NOT_ELIGIBLE', 'Every selected team must be a registered ' || v_section || ' team.');
  end if;
  if exists (select 1 from public.r3_sessions where status = 'live' and section = v_section) then
    perform public._err('R3_SESSION_LIVE', 'A ' || v_section || ' auction is already live. End it before starting another.');
  end if;
  v_bid := public._r3_timer_value(p_settings, 'bid_timer_seconds', v.bid_seconds);
  v_ans := public._r3_answer_value(p_settings, v.answer_seconds);
  insert into public.r3_sessions (request_id, set_id, version_id, section, started_by, bid_timer_default, answer_seconds)
  values (p_request_id, s.id, v.id, v_section, auth.uid(), v_bid, v_ans) returning * into g;
  insert into public.r3_session_teams (session_id, team_id, seat, budget, score)
  select g.id, x.id, x.n, 100, 0 from unnest(v_ids) with ordinality x(id, n);
  return jsonb_build_object('session_id', g.id, 'duplicate_request', false, 'version', v.version, 'bid_timer_default', v_bid, 'answer_seconds', v_ans);
end $$;

-- ===========================================================================
-- Function permissions (complete set, as migration 14, plus set_set_teams)
-- ===========================================================================
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

-- Organizer RPCs (each checks organizer membership internally). As migration 14, plus Round 1 participant selection.
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
  public.reset_attempt(uuid, text), public.correct_set_question(uuid, jsonb, text), public.get_set_results(),
  public.set_set_teams(uuid, uuid[], text)
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

-- Round 3 organizer RPCs (migrations 13 and 14).
grant execute on function
  public.r3s_overview(), public.r3s_set_detail(uuid), public.r3s_save_set(jsonb), public.r3s_delete_set(uuid), public.r3s_archive_set(uuid),
  public.r3s_save_topic(jsonb), public.r3s_delete_topic(uuid), public.r3s_save_question(jsonb), public.r3s_delete_question(uuid),
  public.r3s_move(text, uuid, integer), public.r3s_publish_set(uuid), public.r3s_lookup(text), public.r3s_eligible_teams(text, text),
  public.r3s_start_session(uuid, text, text, uuid[], jsonb), public.r3s_update_session_settings(uuid, jsonb),
  public.r3s_select_question(uuid, uuid), public.r3s_cancel_question(uuid, uuid),
  public.r3s_start_bidding(uuid, uuid, jsonb), public.r3s_record_bid(uuid, uuid, uuid, integer, boolean), public.r3s_close_bidding(uuid, uuid),
  public.r3s_resolve_tie(uuid, uuid, uuid[], text), public.r3s_reopen_bidding(uuid, uuid, text), public.r3s_reveal_topic(uuid, uuid),
  public.r3s_reveal_question(uuid, uuid), public.r3s_record_outcome(uuid, uuid, uuid, uuid, text), public.r3s_next_bidder(uuid, uuid),
  public.r3s_reveal_answer(uuid, uuid), public.r3s_finish_question(uuid, uuid), public.r3s_end_auction(uuid),
  public.r3s_reveal_results(uuid, boolean), public.r3s_results(uuid), public.r3s_board(uuid, boolean)
to authenticated;

-- Registration desk RPCs (each checks registration staff OR organizer internally).
grant execute on function
  public.registration_access(), public.is_registration_staff(), public.reg_overview(), public.reg_save_team(jsonb)
to authenticated;

-- Participant RPCs (anon and authenticated; identical to migration 14).
grant execute on function
  public.join_lookup(text), public.join_roster(text, text), public.join_registered_team(text, text, integer, text),
  public.join_team(text, integer, text, text),
  public.register_team(text, text, text, text, text, text), public.participant_state(text, integer),
  public.participant_start(text), public.participant_submit(text, uuid, uuid, text), public.participant_finish(text),
  public.participant_leave(text)
to anon, authenticated;

-- Self-check (as in migrations 12–14).
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

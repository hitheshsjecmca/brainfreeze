-- Round 1 (COLD START) participant flow without PINs.
--  * join_roster(code, section): with a valid join code, lists the registered teams of the
--    set's section (team number, team name, participant names only — never college, ids or PINs).
--    A section that does not match the set is refused (SECTION_MISMATCH).
--  * join_registered_team(code, section, team_number, device): joins as a registered team
--    without a PIN. A team stays bound to the first device that claims it: another device is
--    refused (TEAM_ALREADY_JOINED) until an organizer releases it (revoke_participant) or the
--    device signs out. There is no idle takeover. The team keeps its single attempt.
--  * participant_submit: a team's own answer may be changed while its attempt is running and
--    before its deadline (the last saved choice counts; every change is an audited 'correction'
--    event). Answers recorded by an organizer stay locked. Deadlines, idempotency and the
--    hidden answer key are unchanged.
-- No data is changed. The PIN-based join_team / register_team functions remain for older
-- clients. Function permissions are re-applied in full below (the last migration that grants
-- is authoritative); the only additions are the two new participant functions.

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
    where t.section = s.section and public._team_other_set(s, t.id) is null
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
  select * into t from public.teams where team_number = p_team_number and section = s.section;
  if t.id is null then
    perform public._log_join_attempt(k, 'pin', false); -- failed team sign-in (same rate limit as the PIN sign-in)
    return jsonb_build_object('ok', false, 'error', 'TEAM_NOT_REGISTERED');
  end if;
  if public._team_other_set(s, t.id) is not null then return jsonb_build_object('ok', false, 'error', 'TEAM_IN_OTHER_SET'); end if;
  if not s.registration_open and (public._active_attempt(s.id, t.id)).id is null then
    return jsonb_build_object('ok', false, 'error', 'REGISTRATION_CLOSED');
  end if;
  if exists (select 1 from public.participant_sessions where session_id = s.id and team_id = t.id and revoked_at is null and expires_at > now()) then
    return jsonb_build_object('ok', false, 'error', 'TEAM_ALREADY_JOINED');
  end if;
  -- Create the team's attempt once; a released team resumes the same attempt (its timer keeps running).
  if (public._active_attempt(s.id, t.id)).id is null then perform public._make_attempt(s, t.id); end if;
  tok := public._open_participant_session(s, t, p_device_label);
  return jsonb_build_object('ok', true, 'token', tok, 'team', public._team_public(t), 'quiz_title', s.name, 'section', s.section);
end $$;

-- p_option is the letter the team SAW; it is mapped back to the original option for scoring.
-- A team may change its own answer until it submits or its deadline passes.
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
  -- Idempotent retry: the current answer, only for the team that made the request.
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
  st := public._settings(s.id);
  select * into t from public.teams where id = ps.team_id;
  select * into ex from public.team_answers where session_id = s.id and team_id = ps.team_id and question_id = p_question_id for update;
  if found then
    if ex.source <> 'participant' then
      return jsonb_build_object('ok', false, 'error', 'ALREADY_SUBMITTED', 'selected',
        coalesce(ex.displayed_option, chr(64 + position(ex.selected_option in a.option_orders[v_i]))));
    end if;
    if ex.selected_option is not distinct from v_orig then -- same choice again: nothing to change
      return jsonb_build_object('ok', true, 'duplicate_request', false, 'selected', v_shown, 'question_id', p_question_id, 'submitted_at', ex.updated_at);
    end if;
    perform public._record(s, st, t, p_question_id, v_orig, p_request_id, true, 'Changed by the team before submitting', 'participant', a.id, v_shown, true);
    update public.team_answers set displayed_option = v_shown, on_time = true where id = ex.id;
  else
    perform public._record(s, st, t, p_question_id, v_orig, p_request_id, false, null, 'participant', a.id, v_shown, true);
  end if;
  -- Deliberately no result/points: correctness is never revealed here.
  return jsonb_build_object('ok', true, 'duplicate_request', false, 'selected', v_shown, 'question_id', p_question_id, 'submitted_at', now());
end $$;

-- ===========================================================================
-- Function permissions (complete set; unchanged from migration 7 except the two new participant functions)
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

-- Participant RPCs: callable without an account; authorized by join code + registered team / device token.
grant execute on function
  public.join_lookup(text), public.join_roster(text, text), public.join_registered_team(text, text, integer, text),
  public.join_team(text, integer, text, text),
  public.register_team(text, text, text, text, text, text), public.participant_state(text, integer),
  public.participant_start(text), public.participant_submit(text, uuid, uuid, text), public.participant_finish(text),
  public.participant_leave(text)
to anon, authenticated;

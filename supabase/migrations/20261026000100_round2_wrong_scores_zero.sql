-- Migration 16 — Round 2 scoring: a wrong answer scores 0 (nothing is deducted), and the board always carries
-- the game's team list.
--
--   * public._r2_delta (same signature, so every caller and permission is unchanged): right = +the question's saved
--     points, wrong = 0, anything else = 0. The set's wrong_penalty_percent is no longer used for scoring (the column
--     and its stored values are kept). r2s_score keeps every other rule: organizer only, the question must be the
--     one revealed in this session, the team must belong to the session, one result per question per session, and a
--     repeated request id returns the first result instead of scoring again.
--   * public.r2s_board is re-installed exactly as in migration 11 (same signature and organizer-only grant). Its
--     `teams` list feeds the "Which Team Answered?" step; a database where migration 10's older r2s_board is live
--     (migration 11 missing, or migration 10 re-run after it) returns no team list.
--   * No data changes: results already recorded keep their points. No table or RLS changes. The complete function
--     permission set is re-applied unchanged (identical to migration 15), as every newest migration does.

create or replace function public._r2_delta(p_points numeric, p_result text, p_penalty_percent numeric) returns numeric
language sql immutable set search_path = '' as $$
  select case p_result when 'right' then p_points else 0::numeric end;
$$;

create or replace function public.r2s_board(p_session_id uuid, p_host boolean default false) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare g public.r2_sessions; v public.r2_versions; q public.r2_version_questions; s public.r2_sets; v_host boolean := coalesce(p_host, false); b jsonb;
begin
  perform public._require_organizer();
  select * into g from public.r2_sessions where id = p_session_id;
  if not found then perform public._err('TRIVIA_SESSION_NOT_FOUND', 'Round 2 session not found.'); end if;
  select * into v from public.r2_versions where id = g.version_id;
  select * into s from public.r2_sets where id = g.set_id;
  if g.question_id is not null then select * into q from public.r2_version_questions where id = g.question_id; end if;
  b := jsonb_build_object(
    'server_now', now(),
    'view', case when v_host then 'host' else 'projector' end,
    'session', jsonb_build_object('id', g.id, 'status', g.status, 'section', g.section, 'started_at', g.started_at, 'ended_at', g.ended_at,
      'title', v.title, 'version', v.version, 'set_id', g.set_id),
    'settings', jsonb_build_object('timer_seconds', v.timer_seconds, 'wrong_penalty_percent', v.wrong_penalty_percent),
    'topics', public._r2s_board_topics(v.id, g.id),
    'game', jsonb_build_object(
      'phase', g.phase, 'question_id', g.question_id, 'topic', q.topic_name, 'points', q.points,
      'question_text', case when g.phase = 'revealed' then q.question_text end,
      'answer_revealed', g.answer_revealed,
      'answer_text', case when g.phase = 'revealed' and (g.answer_revealed or v_host) then (select answer_text from public.r2_version_answers where question_id = q.id) end,
      'revealed_at', g.revealed_at),
    -- Team names only (for the "Which team answered?" picker), never their scores.
    'teams', coalesce((select jsonb_agg(jsonb_build_object('team_id', tm.id, 'team_number', tm.team_number, 'team_name', tm.team_name, 'section', tm.section)
        order by tm.team_number) from public.r2_session_teams st join public.teams tm on tm.id = st.team_id where st.session_id = g.id), '[]'::jsonb));
  if not v_host then return b; end if;
  return b
    || jsonb_build_object('session', (b->'session') || jsonb_build_object('join_code', s.join_code))
    || jsonb_build_object('game', (b->'game') || jsonb_build_object('last_result_id', g.last_result_id))
    || jsonb_build_object(
      'scores', public._r2s_scores(g.id),
      'last_result', (select jsonb_build_object('id', r.id, 'result', r.result, 'points', r.points, 'point_value', r.point_value, 'topic', r.topic_name,
          'team_name', r.team_name, 'team_number', r.team_number, 'section', r.team_section)
        from public.r2_session_results r where r.id = g.last_result_id),
      'results', coalesce((select jsonb_agg(to_jsonb(r) - 'request_id' order by r.id) from public.r2_session_results r where r.session_id = g.id), '[]'::jsonb));
end $$;

-- Self-check.
do $$
begin
  if public._r2_delta(20, 'right', 50) <> 20 or public._r2_delta(20, 'wrong', 50) <> 0 or public._r2_delta(30, 'wrong', 100) <> 0
     or public._r2_delta(10, 'no_score', 50) <> 0 then
    raise exception 'Round 2 scoring check failed';
  end if;
  if position('''teams''' in pg_get_functiondef('public.r2s_board(uuid,boolean)'::regprocedure)) = 0 then
    raise exception 'r2s_board does not return the team list';
  end if;
end $$;

-- ===========================================================================
-- Function permissions (complete set, identical to migration 15; the newest migration always re-applies it)
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

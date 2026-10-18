-- Migration 11 — Round 2: keep scores private to the organiser's host view.
--
-- r2s_board(p_session_id, p_host) is redefined (same signature, so its organizer-only grant from
-- migration 10 is kept as is):
--   p_host = false  → the PUBLIC PROJECTOR board: topics and point tiles with "used" marks, the open
--                     question (text only after Reveal Question, answer only after Answer), the timer,
--                     and the session's team names (id, number, name, section) so the organiser can pick
--                     the answering team on the projector. NO scores, NO last result, NO score log,
--                     NO join code and never a peek at a hidden answer.
--   p_host = true   → the PRIVATE HOST board: everything above plus scores (leaderboard), the last
--                     result, the score log, the join code and the host's own peek at the answer.
-- Both still require an organizer (_require_organizer) — the board is never readable by anon, by
-- registration staff or by participants holding a join code. Gameplay functions are unchanged and
-- remain organizer-only and server-validated.
-- No table, data or permission changes. Rollback: re-run the r2s_board definition of migration 10.

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

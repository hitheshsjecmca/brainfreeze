-- BRAINFREZE — COLD START · security
-- Model:
--   * anon (not signed in): no table access, no function access.
--   * authenticated: SELECT only, and RLS limits rows to organizers.
--     No INSERT/UPDATE/DELETE grants at all — every write goes through the
--     SECURITY DEFINER RPCs, which re-check organizer membership.
--   * The service-role key is never needed by the app and must never be
--     shipped to the browser or committed.

-- ---------------------------------------------------------------- RLS
alter table public.organizers       enable row level security;
alter table public.teams            enable row level security;
alter table public.questions        enable row level security;
alter table public.question_keys    enable row level security;
alter table public.quiz_sessions    enable row level security;
alter table public.quiz_settings    enable row level security;
alter table public.team_answers     enable row level security;
alter table public.score_events     enable row level security;
alter table public.tiebreak_results enable row level security;

-- Table privileges: strip everything, then grant read-only to signed-in users.
revoke all on public.organizers, public.teams, public.questions, public.question_keys, public.quiz_sessions,
  public.quiz_settings, public.team_answers, public.score_events, public.tiebreak_results from anon, authenticated, public;
grant select on public.organizers, public.teams, public.questions, public.question_keys, public.quiz_sessions,
  public.quiz_settings, public.team_answers, public.score_events, public.tiebreak_results to authenticated;

drop policy if exists organizers_self_read on public.organizers;
create policy organizers_self_read on public.organizers for select to authenticated
  using (user_id = (select auth.uid()));

do $$
declare t text;
begin
  foreach t in array array['teams', 'questions', 'question_keys', 'quiz_sessions', 'quiz_settings', 'team_answers', 'score_events', 'tiebreak_results'] loop
    execute format('drop policy if exists %I on public.%I', t || '_organizer_read', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.is_organizer()))', t || '_organizer_read', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- functions
-- Supabase grants EXECUTE on new functions to anon/authenticated by default.
-- Revoke everything in this schema, then grant only the public RPC surface.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

grant execute on function
  public.is_organizer(),
  public.server_now(),
  public.ensure_session(),
  public.save_team(jsonb),
  public.delete_team(uuid, boolean),
  public.import_teams(jsonb, boolean, boolean),
  public.save_question(jsonb),
  public.delete_question(uuid, boolean),
  public.reorder_questions(uuid[]),
  public.import_questions(jsonb, boolean, boolean),
  public.remove_demo_data(boolean, boolean, boolean),
  public.update_settings(jsonb),
  public.start_quiz(),
  public.pause_quiz(),
  public.resume_quiz(),
  public.reset_timer(),
  public.end_quiz(),
  public.go_to_question(integer),
  public.set_question_completed(uuid, boolean),
  public.set_projector_view(text),
  public.set_corrections(boolean, text),
  public.new_session(),
  public.record_answer(uuid, uuid, uuid, text, boolean, text),
  public.undo_last_action(uuid),
  public.get_standings(),
  public.set_tiebreak(uuid, numeric, text),
  public.confirm_qualifiers(uuid[], text),
  public.reopen_results(text),
  public.reveal_results(boolean),
  public.restore_backup(jsonb)
to authenticated;

-- ---------------------------------------------------------------- realtime
-- Realtime postgres_changes honours RLS, so only organizers receive rows.
-- question_keys is deliberately NOT published.
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['teams', 'questions', 'quiz_sessions', 'quiz_settings', 'team_answers', 'score_events', 'tiebreak_results'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

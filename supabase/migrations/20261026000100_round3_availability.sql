-- Migration 16 — Round 3 Availability: an organizer-controlled switch for Round 3 (THE KNOWLEDGE AUCTION).
--
--   * public.app_settings: one row of event-wide settings. round3_enabled defaults to FALSE, so Round 3 is disabled
--     until an organizer enables it (Settings & Backup → Round 3 Availability).
--   * get_app_settings() / set_round3_enabled(boolean): organizer-only RPCs that read and change the switch.
--   * Every r3s_* RPC is wrapped: the original function is renamed to _r3s_<name>_ungated (not callable by any API role)
--     and a same-signature r3s_<name> checks organizer access, then refuses with ROUND3_DISABLED while Round 3 is
--     disabled. Signatures and grants are unchanged, so the app's RPC calls need no change.
--   * Every r3_* table gets a RESTRICTIVE select policy: organizers can no longer read Round 3 rows (or receive them
--     through Realtime) while Round 3 is disabled. RLS stays enabled everywhere.
--   * Nothing is deleted: Round 3 tables, data, sessions and functions are kept; enabling Round 3 restores everything.
--   * Round 1 and Round 2 functions, tables and grants are untouched.
--
-- NOTE for later migrations: a `create or replace function public.r3s_…` replaces the gated wrapper with an ungated
-- body. Change the _r3s_…_ungated function instead (tests/round3_availability.sql.test.js fails on an ungated r3s_*;
-- re-running this migration wraps it again).

-- ===========================================================================
-- Event-wide settings (one row)
-- ===========================================================================
create table if not exists public.app_settings (
  id boolean primary key default true check (id),
  round3_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
insert into public.app_settings (id) values (true) on conflict (id) do nothing;

-- No direct table access: read and written only through the organizer RPCs below.
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated, public;

-- ===========================================================================
-- Helpers and organizer RPCs
-- ===========================================================================
-- Used inside RLS policies, so callable by signed-in users; reveals only whether Round 3 is enabled.
create or replace function public.round3_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select round3_enabled from public.app_settings where id), false);
$$;

create or replace function public._require_round3() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.round3_enabled() then
    perform public._err('ROUND3_DISABLED', 'Round 3 is disabled. An organizer can enable it in Settings & Backup.');
  end if;
end $$;

create or replace function public.get_app_settings() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.app_settings;
begin
  perform public._require_organizer();
  select * into r from public.app_settings where id;
  return jsonb_build_object('round3_enabled', coalesce(r.round3_enabled, false), 'updated_at', r.updated_at);
end $$;

create or replace function public.set_round3_enabled(p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.app_settings;
begin
  perform public._require_organizer();
  if p_enabled is null then perform public._err('VALIDATION', 'Choose Enabled or Disabled.'); end if;
  insert into public.app_settings (id, round3_enabled, updated_at, updated_by) values (true, p_enabled, now(), auth.uid())
  on conflict (id) do update set round3_enabled = excluded.round3_enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  returning * into r;
  return jsonb_build_object('round3_enabled', r.round3_enabled, 'updated_at', r.updated_at);
end $$;

-- ===========================================================================
-- Gate every Round 3 RPC. Safe to re-run: an already-gated function is left alone; a function that an older
-- migration (re-run later) replaced with an ungated body becomes the new _ungated body and is wrapped again.
-- ===========================================================================
do $$
declare
  f record;
  old record;
  v_inner text;
  v_args text;
begin
  for f in
    select p.oid, p.proname, p.prosrc, pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as result, p.pronargs
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.proname like 'r3s\_%'
  loop
    if f.prosrc like '%public._require_round3()%' then
      continue;
    end if;
    v_inner := '_' || f.proname || '_ungated';
    for old in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = v_inner and p.proargtypes = (select proargtypes from pg_proc where oid = f.oid) loop
      execute format('drop function %s', old.oid::regprocedure);
    end loop;
    if f.result is null or f.result ilike 'setof %' or f.result ilike 'table%' or f.result = 'void' then
      raise exception 'Round 3 gate: unexpected return type % for %', f.result, f.proname;
    end if;
    execute format('alter function %s rename to %I', f.oid::regprocedure, v_inner);
    select coalesce(string_agg('$' || i, ', ' order by i), '') into v_args from generate_series(1, f.pronargs) as i;
    execute format(
      'create function public.%I(%s) returns %s language plpgsql security definer set search_path = '''' as $w$ '
      'begin perform public._require_organizer(); perform public._require_round3(); return public.%I(%s); end $w$',
      f.proname, f.args, f.result, v_inner, v_args);
  end loop;
end $$;

-- ===========================================================================
-- RLS: Round 3 rows are readable only while Round 3 is enabled (in addition to the organizer-only policies)
-- ===========================================================================
do $$
declare t text;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'r3\_%'
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_round3_enabled', t);
    execute format('create policy %I on public.%I as restrictive for select to authenticated using ((select public.round3_enabled()))',
                   t || '_round3_enabled', t);
  end loop;
end $$;

-- ===========================================================================
-- Function permissions (complete set, as migration 15, plus the Round 3 Availability RPCs)
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

-- Organizer RPCs (each checks organizer membership internally). As migration 15.
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

-- Round 3 organizer RPCs (migrations 13 and 14; gated by Round 3 Availability).
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

-- Participant RPCs (anon and authenticated; identical to migration 15).
grant execute on function
  public.join_lookup(text), public.join_roster(text, text), public.join_registered_team(text, text, integer, text),
  public.join_team(text, integer, text, text),
  public.register_team(text, text, text, text, text, text), public.participant_state(text, integer),
  public.participant_start(text), public.participant_submit(text, uuid, uuid, text), public.participant_finish(text),
  public.participant_leave(text)
to anon, authenticated;

-- Round 3 Availability (this migration): organizer read/write, and the RLS helper.
grant execute on function
  public.get_app_settings(), public.set_round3_enabled(boolean), public.round3_enabled()
to authenticated;

-- Self-check (as in migrations 12–15, plus: every r3s_* RPC is gated).
do $$
declare bad text;
begin
  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'r2s\_%' and not has_function_privilege('authenticated', p.oid, 'execute');
  if bad is not null then raise exception 'Permission check failed: authenticated cannot execute %', bad; end if;
  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and (p.proname like 'r2s\_%' or p.proname like 'r3s\_%' or p.proname like 'r2\_%'
    or p.proname in ('get_standings', 'publish_quiz', 'record_answer', 'restore_backup', 'get_app_settings', 'set_round3_enabled'))
    and has_function_privilege('anon', p.oid, 'execute');
  if bad is not null then raise exception 'Permission check failed: anon can execute organizer function(s) %', bad; end if;
  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like '\_%' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
  if bad is not null then raise exception 'Permission check failed: internal helper(s) are callable: %', bad; end if;
  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'r3s\_%'
    and (not exists (select 1 from pg_proc u where u.pronamespace = n.oid and u.proname = '_' || p.proname || '_ungated')
         or p.prosrc not like '%public._require_round3()%');
  if bad is not null then raise exception 'Round 3 gate check failed: not gated: %', bad; end if;
end $$;

-- Migration 14 — Round 3: optional, configurable bidding timer that closes bidding automatically; per-session
-- answer timer. (Migration 13 is already applied to the live database, so it is not edited.)
--
-- Bidding timer:
--   * NO TIMER (null seconds): no countdown, no deadline; bidding stays open until the organizer presses Close Bidding.
--   * TIMED (1–3600 whole seconds — the documented safety limit): the server stores the start time and the duration;
--     when the deadline passes, bidding is CLOSED AUTOMATICALLY at the deadline. The close happens in the database the
--     next time anything touches the auction — every organizer action locks the auction row and closes an expired
--     bidding first, and the board read (projector or control panel, including after a refresh or reconnect) does the
--     same. So an expired bidding period is closed even if the organizer was disconnected, and no bid is accepted
--     after the deadline. An active timer can no longer be restarted (r3s_start_bidding works only from "selected");
--     the only way to bid again after closing is the audited "reopen bidding" correction.
--   * Defaults: the set's bid_seconds (null = no timer; new sets default to no timer) → the auction's
--     bid_timer_default (chosen at Start Round 3, changeable while no question is being answered) → an optional
--     per-question override when bidding starts.
-- Answer timer: per auction (answer_seconds, 5–600, default the set's value, 25 s); timeouts are checked against it.
--
-- Schema: r3_sets.bid_seconds / r3_versions.bid_seconds become nullable (1–3600); r3_sets.answer_seconds 5–600;
-- r3_sessions gains bid_timer_default, answer_seconds and bid_seconds_current; r3_question_results gains bid_seconds;
-- r3_events allows kind 'settings_changed'. Existing rows are back-filled from their published version. No data is
-- deleted. New function signatures: r3s_start_session(…, p_settings jsonb), r3s_start_bidding(…, p_timer jsonb),
-- r3s_update_session_settings(uuid, jsonb); the old signatures are dropped. Function permissions are re-applied in full.

-- ===========================================================================
-- Schema
-- ===========================================================================
alter table public.r3_sets drop constraint if exists r3_sets_bid_seconds_check;
alter table public.r3_sets alter column bid_seconds drop not null;
alter table public.r3_sets alter column bid_seconds set default null;
alter table public.r3_sets add constraint r3_sets_bid_seconds_check check (bid_seconds is null or bid_seconds between 1 and 3600);
alter table public.r3_sets drop constraint if exists r3_sets_answer_seconds_check;
alter table public.r3_sets add constraint r3_sets_answer_seconds_check check (answer_seconds between 5 and 600);
alter table public.r3_versions alter column bid_seconds drop not null;

alter table public.r3_sessions add column if not exists bid_timer_default integer;
alter table public.r3_sessions add column if not exists answer_seconds integer;
alter table public.r3_sessions add column if not exists bid_seconds_current integer;
update public.r3_sessions g set
  bid_timer_default = coalesce(g.bid_timer_default, v.bid_seconds),
  answer_seconds = coalesce(g.answer_seconds, v.answer_seconds),
  bid_seconds_current = case when g.phase = 'bidding' and g.bid_seconds_current is null then v.bid_seconds else g.bid_seconds_current end
from public.r3_versions v where v.id = g.version_id and g.answer_seconds is null;
alter table public.r3_sessions alter column answer_seconds set default 25;
alter table public.r3_sessions alter column answer_seconds set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'r3_sessions_timers_check') then
    alter table public.r3_sessions add constraint r3_sessions_timers_check check (
      (bid_timer_default is null or bid_timer_default between 1 and 3600)
      and (bid_seconds_current is null or bid_seconds_current between 1 and 3600)
      and answer_seconds between 5 and 600);
  end if;
end $$;

alter table public.r3_question_results add column if not exists bid_seconds integer;

alter table public.r3_events drop constraint if exists r3_events_kind_check;
alter table public.r3_events add constraint r3_events_kind_check check (kind in ('bid', 'bidding_started', 'bidding_closed', 'tie_resolved',
  'bidding_reopened', 'topic_revealed', 'question_revealed', 'outcome', 'next_bidder', 'answer_revealed', 'question_completed',
  'question_cancelled', 'auction_ended', 'results_revealed', 'settings_changed'));

-- ===========================================================================
-- Timer helpers
-- ===========================================================================
-- Reads a bidding timer from a jsonb object: key absent → p_default; null / "" / "none" → no timer (null);
-- otherwise 1–3600 whole seconds.
create or replace function public._r3_timer_value(p jsonb, p_key text, p_default integer) returns integer
language plpgsql immutable set search_path = '' as $$
declare raw text;
begin
  if p is null or not (p ? p_key) then return p_default; end if;
  if jsonb_typeof(p->p_key) = 'null' then return null; end if;
  raw := btrim(p->>p_key);
  if raw = '' or lower(raw) = 'none' then return null; end if;
  if raw !~ '^[0-9]{1,6}$' or raw::int not between 1 and 3600 then
    perform public._err('VALIDATION', 'The bidding timer must be 1–3600 whole seconds, or no timer.');
  end if;
  return raw::int;
end $$;

create or replace function public._r3_answer_value(p jsonb, p_default integer) returns integer
language plpgsql immutable set search_path = '' as $$
declare raw text;
begin
  if p is null or not (p ? 'answer_seconds') or jsonb_typeof(p->'answer_seconds') = 'null' then return p_default; end if;
  raw := btrim(p->>'answer_seconds');
  if raw = '' then return p_default; end if;
  if raw !~ '^[0-9]{1,6}$' or raw::int not between 5 and 600 then perform public._err('VALIDATION', 'The answer timer must be 5–600 whole seconds.'); end if;
  return raw::int;
end $$;

-- The bidding deadline of an auction (null = no timer or not bidding).
create or replace function public._r3_bid_deadline(g public.r3_sessions) returns timestamptz
language sql immutable set search_path = '' as $$
  select case when g.phase = 'bidding' and g.bid_seconds_current is not null and g.bid_started_at is not null
    then g.bid_started_at + make_interval(secs => g.bid_seconds_current) end;
$$;

-- Close bidding at p_at (manual: now(); automatic: the deadline). Locks the bids and builds the order.
create or replace function public._r3_close(g public.r3_sessions, p_at timestamptz, p_auto boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_order uuid[]; v_tie boolean;
begin
  insert into public.r3_bids (session_id, question_id, team_id, status, amount, updated_by)
  select g.id, g.question_id, st.team_id, 'no_bid', null, auth.uid() from public.r3_session_teams st where st.session_id = g.id
  on conflict (session_id, question_id, team_id) do nothing;
  select coalesce(array_agg(b.team_id order by b.amount desc, st.seat), '{}') into v_order
  from public.r3_bids b join public.r3_session_teams st on st.session_id = b.session_id and st.team_id = b.team_id
  where b.session_id = g.id and b.question_id = g.question_id and b.status = 'bid';
  select exists (select 1 from public.r3_bids where session_id = g.id and question_id = g.question_id and status = 'bid'
                 group by amount having count(*) > 1) into v_tie;
  update public.r3_sessions set bids_closed_at = p_at, bid_order = v_order,
    phase = case when cardinality(v_order) = 0 then phase when v_tie then 'tie' else 'closed' end,
    order_pos = case when cardinality(v_order) > 0 and not v_tie then 1 else 0 end,
    current_team_id = case when cardinality(v_order) > 0 and not v_tie then v_order[1] end,
    updated_at = now()
  where id = g.id returning * into g;
  perform public._r3_event(g, 'bidding_closed', null, jsonb_build_object('order', to_jsonb(v_order), 'tie', v_tie, 'auto', p_auto,
    'timer_seconds', g.bid_seconds_current));
  if cardinality(v_order) = 0 then
    perform public._r3_complete(g, 'no_bids', null);
    return jsonb_build_object('ok', true, 'phase', 'done', 'result', 'no_bids');
  end if;
  return jsonb_build_object('ok', true, 'phase', g.phase, 'order', to_jsonb(v_order), 'tie', v_tie);
end $$;

-- If the auction's timed bidding has passed its deadline, close it (at the deadline). Caller must hold the row lock
-- or call this before locking; it locks the row itself.
create or replace function public._r3_auto_close(p_session uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions; v_deadline timestamptz;
begin
  select * into g from public.r3_sessions where id = p_session for update;
  if not found or g.status <> 'live' then return; end if;
  v_deadline := public._r3_bid_deadline(g);
  if v_deadline is not null and now() >= v_deadline then perform public._r3_close(g, v_deadline, true); end if;
end $$;

-- A live auction, locked, with an expired timed bidding closed first.
create or replace function public._r3_lock_session(p_session uuid) returns public.r3_sessions
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions;
begin
  select * into g from public.r3_sessions where id = p_session for update;
  if not found then perform public._err('R3_SESSION_NOT_FOUND', 'Round 3 auction not found.'); end if;
  if g.status <> 'live' then perform public._err('R3_SESSION_ENDED', 'This auction has ended.'); end if;
  perform public._r3_auto_close(g.id);
  select * into g from public.r3_sessions where id = p_session;
  return g;
end $$;

-- Completed question (now also records the bidding timer that was used).
create or replace function public._r3_complete(g public.r3_sessions, p_result text, p_winner uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.r3_version_questions; v_top uuid := g.bid_order[1]; v_top_bid integer;
begin
  select * into q from public.r3_version_questions where id = g.question_id;
  if v_top is not null then select amount into v_top_bid from public.r3_bids where session_id = g.id and question_id = q.id and team_id = v_top; end if;
  insert into public.r3_question_results (session_id, question_id, seq, topic_name, mode, result, winner_team_id, top_team_id, top_bid, bid_order, bids, bid_seconds)
  values (g.id, q.id, q.seq, q.topic_name, q.mode, p_result, p_winner, v_top, v_top_bid, g.bid_order,
    coalesce((select jsonb_agg(jsonb_build_object('team_id', b.team_id, 'status', b.status, 'amount', b.amount) order by b.amount desc nulls last)
      from public.r3_bids b where b.session_id = g.id and b.question_id = q.id), '[]'::jsonb), g.bid_seconds_current);
  update public.r3_sessions set phase = 'done', current_team_id = null, updated_at = now() where id = g.id;
  perform public._r3_event(g, 'question_completed', p_winner, jsonb_build_object('result', p_result));
end $$;

-- ===========================================================================
-- Auction sets: bidding timer is optional (null = no timer)
-- ===========================================================================
create or replace function public.r3s_save_set(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid; v_title text := public._clean(p->>'title'); v_desc text := public._clean(p->>'description');
  v_section text := upper(coalesce(nullif(btrim(p->>'section'), ''), 'BOTH'));
  s public.r3_sets; v_bid integer; v_ans integer;
begin
  perform public._require_organizer();
  if v_title is null or char_length(v_title) > 80 then perform public._err('VALIDATION', 'The auction set title is required (max 80 characters).'); end if;
  if v_desc is not null and char_length(v_desc) > 500 then perform public._err('VALIDATION', 'The description can be at most 500 characters.'); end if;
  if v_section not in ('UG', 'PG', 'BOTH') then perform public._err('VALIDATION', 'Section must be UG, PG or both.'); end if;
  if v_id is null then
    v_bid := public._r3_timer_value(p, 'bid_seconds', null);
    v_ans := public._r3_answer_value(p, 25);
    insert into public.r3_sets (title, description, section, bid_seconds, answer_seconds)
    values (v_title, v_desc, v_section, v_bid, v_ans) returning id into v_id;
  else
    s := public._r3_lock_set(v_id);
    v_bid := public._r3_timer_value(p, 'bid_seconds', s.bid_seconds);
    v_ans := public._r3_answer_value(p, s.answer_seconds);
    update public.r3_sets set title = v_title, description = v_desc, section = v_section, bid_seconds = v_bid, answer_seconds = v_ans where id = v_id;
    perform public._r3_touch(v_id);
  end if;
  return v_id;
end $$;

-- ===========================================================================
-- Start Round 3 with the auction's timer defaults
-- ===========================================================================
drop function if exists public.r3s_start_session(uuid, text, text, uuid[]);
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
  if cardinality(v_ids) <> 3 then perform public._err('R3_TEAM_COUNT', 'Select exactly three teams.'); end if;
  if (select count(distinct x) from unnest(v_ids) x) <> 3 then perform public._err('R3_TEAM_COUNT', 'The three teams must be different.'); end if;
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

-- Change the auction's defaults (bidding timer for the next questions; answer timer while nobody is answering). Audited.
create or replace function public.r3s_update_session_settings(p_session_id uuid, p_settings jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions; v_bid integer; v_ans integer;
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  v_bid := public._r3_timer_value(p_settings, 'bid_timer_seconds', g.bid_timer_default);
  v_ans := public._r3_answer_value(p_settings, g.answer_seconds);
  if v_ans <> g.answer_seconds and g.phase in ('answering', 'between') then
    perform public._err('R3_WRONG_PHASE', 'The answer timer can be changed when no team is answering.');
  end if;
  update public.r3_sessions set bid_timer_default = v_bid, answer_seconds = v_ans, updated_at = now() where id = g.id returning * into g;
  perform public._r3_event(g, 'settings_changed', null, jsonb_build_object('bid_timer_seconds', v_bid, 'answer_seconds', v_ans));
  return jsonb_build_object('ok', true, 'bid_timer_default', v_bid, 'answer_seconds', v_ans);
end $$;

-- ===========================================================================
-- Live auction: phase functions using the timer
-- ===========================================================================
create or replace function public.r3s_select_question(p_session_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions; q public.r3_version_questions;
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  if g.phase <> 'idle' then
    if g.phase = 'selected' and g.question_id = p_question_id then return jsonb_build_object('ok', true, 'phase', g.phase); end if;
    perform public._err('R3_QUESTION_ACTIVE', 'Another question is open. Finish or cancel it first.');
  end if;
  select * into q from public.r3_version_questions where id = p_question_id and version_id = g.version_id;
  if not found then perform public._err('R3_NOT_FOUND', 'That question is not in this auction.'); end if;
  if exists (select 1 from public.r3_question_results where session_id = g.id and question_id = q.id) then
    perform public._err('R3_QUESTION_USED', 'This question has already been played.');
  end if;
  update public.r3_sessions set phase = 'selected', question_id = q.id, topic_revealed = (q.mode = 'NORMAL'), bid_started_at = null, bids_closed_at = null,
    bid_seconds_current = null, bid_order = '{}', order_pos = 0, current_team_id = null, question_revealed = false, answer_started_at = null,
    answer_revealed = false, last_event_id = null, updated_at = now()
  where id = g.id;
  return jsonb_build_object('ok', true, 'phase', 'selected');
end $$;

create or replace function public.r3s_cancel_question(p_session_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions;
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  perform public._r3_require(g, p_question_id, array['selected', 'bidding', 'tie', 'closed']);
  if g.question_revealed then perform public._err('R3_QUESTION_LIVE', 'The question is already revealed. Record the outcomes instead.'); end if;
  delete from public.r3_bids where session_id = g.id and question_id = g.question_id;
  perform public._r3_event(g, 'question_cancelled');
  update public.r3_sessions set phase = 'idle', question_id = null, topic_revealed = false, bid_started_at = null, bids_closed_at = null,
    bid_seconds_current = null, bid_order = '{}', order_pos = 0, current_team_id = null, updated_at = now() where id = g.id;
  return jsonb_build_object('ok', true);
end $$;

-- Opens bidding for the selected question. p_timer {"bid_timer_seconds": n | null} overrides the auction default for
-- this question only; without it the default applies. An open bidding cannot be restarted or extended.
drop function if exists public.r3s_start_bidding(uuid, uuid);
create or replace function public.r3s_start_bidding(p_session_id uuid, p_question_id uuid, p_timer jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions; v_secs integer;
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  perform public._r3_require(g, p_question_id, null);
  if g.phase = 'bidding' then perform public._err('R3_BIDDING_RUNNING', 'Bidding is already open. Its timer cannot be restarted or extended.'); end if;
  perform public._r3_require(g, p_question_id, array['selected']);
  v_secs := public._r3_timer_value(p_timer, 'bid_timer_seconds', g.bid_timer_default);
  update public.r3_sessions set phase = 'bidding', bid_started_at = now(), bid_seconds_current = v_secs, updated_at = now()
  where id = g.id returning * into g;
  perform public._r3_event(g, 'bidding_started', null, jsonb_build_object('timer_seconds', v_secs, 'timed', v_secs is not null));
  return jsonb_build_object('ok', true, 'bid_started_at', g.bid_started_at, 'bid_seconds', v_secs);
end $$;

-- Record (or correct) a verbal bid while bidding is open. A bid after an expired timer is refused (bidding closed itself).
create or replace function public.r3s_record_bid(p_session_id uuid, p_question_id uuid, p_team_id uuid, p_amount integer, p_pass boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions; st public.r3_session_teams;
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  perform public._r3_require(g, p_question_id, null);
  if g.phase <> 'bidding' then
    if g.bids_closed_at is not null then perform public._err('R3_BIDDING_CLOSED', 'Bidding is closed for this question; bids are locked.'); end if;
    perform public._err('R3_WRONG_PHASE', 'Start bidding first.');
  end if;
  select * into st from public.r3_session_teams where session_id = g.id and team_id = p_team_id;
  if not found then perform public._err('R3_TEAM_NOT_IN_AUCTION', 'That team is not in this auction.'); end if;
  if coalesce(p_pass, false) then
    insert into public.r3_bids (session_id, question_id, team_id, status, amount, updated_by) values (g.id, g.question_id, st.team_id, 'pass', null, auth.uid())
    on conflict (session_id, question_id, team_id) do update set status = 'pass', amount = null, updated_at = now(), updated_by = auth.uid();
  elsif p_amount is null then
    delete from public.r3_bids where session_id = g.id and question_id = g.question_id and team_id = st.team_id;
  else
    if st.budget < 10 then perform public._err('R3_CANNOT_BID', 'This team has less than 10 left and must pass.'); end if;
    if p_amount < 10 then perform public._err('R3_BID_TOO_LOW', 'The minimum bid is 10.'); end if;
    if p_amount % 10 <> 0 then perform public._err('R3_BID_STEP', 'Bids go up in steps of 10.'); end if;
    if p_amount > st.budget then perform public._err('R3_BID_OVER_BUDGET', 'The bid is more than the team''s budget (' || st.budget || ').'); end if;
    insert into public.r3_bids (session_id, question_id, team_id, status, amount, updated_by) values (g.id, g.question_id, st.team_id, 'bid', p_amount, auth.uid())
    on conflict (session_id, question_id, team_id) do update set status = 'bid', amount = excluded.amount, updated_at = now(), updated_by = auth.uid();
  end if;
  perform public._r3_event(g, 'bid', st.team_id, jsonb_build_object('amount', case when coalesce(p_pass, false) then null else p_amount end, 'pass', coalesce(p_pass, false)));
  return jsonb_build_object('ok', true);
end $$;

-- Manual Close Bidding (both modes).
create or replace function public.r3s_close_bidding(p_session_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions;
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  perform public._r3_require(g, p_question_id, null);
  if g.phase <> 'bidding' then
    if g.bids_closed_at is not null then return jsonb_build_object('ok', true, 'phase', g.phase, 'already_closed', true); end if;
    perform public._r3_require(g, p_question_id, array['bidding']);
  end if;
  return public._r3_close(g, now(), false);
end $$;

-- Audited correction before the question is revealed: reopen bidding with the question's timer setting.
create or replace function public.r3s_reopen_bidding(p_session_id uuid, p_question_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions; v_reason text := public._clean(p_reason);
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  perform public._r3_require(g, p_question_id, array['tie', 'closed']);
  if g.question_revealed then perform public._err('R3_QUESTION_LIVE', 'The question is already revealed; bids are final.'); end if;
  if v_reason is null or char_length(v_reason) > 200 then perform public._err('VALIDATION', 'Give a reason for reopening bidding (max 200 characters).'); end if;
  delete from public.r3_bids where session_id = g.id and question_id = g.question_id and status = 'no_bid';
  update public.r3_sessions set phase = 'bidding', bid_started_at = now(), bids_closed_at = null, bid_order = '{}', order_pos = 0,
    current_team_id = null, updated_at = now() where id = g.id returning * into g;
  perform public._r3_event(g, 'bidding_reopened', null, jsonb_build_object('reason', v_reason, 'timer_seconds', g.bid_seconds_current));
  return jsonb_build_object('ok', true);
end $$;

-- Outcome confirmation: the timeout check now uses the auction's answer timer (otherwise unchanged from migration 13).
create or replace function public.r3s_record_outcome(p_request_id uuid, p_session_id uuid, p_question_id uuid, p_team_id uuid, p_outcome text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  g public.r3_sessions; e public.r3_events; st public.r3_session_teams; t public.teams;
  v_top boolean; v_bid integer; d record; v_id bigint; v_next text;
begin
  perform public._require_organizer();
  if p_request_id is null then perform public._err('VALIDATION', 'A request id is required.'); end if;
  select * into e from public.r3_events where request_id = p_request_id;
  if found then
    return jsonb_build_object('duplicate_request', true, 'event_id', e.id, 'outcome', e.outcome, 'team_id', e.team_id, 'was_top', e.was_top, 'bid', e.bid,
      'score_delta', e.score_delta, 'budget_delta', e.budget_delta);
  end if;
  g := public._r3_lock_session(p_session_id);
  if p_outcome is null or p_outcome not in ('correct', 'wrong', 'pass', 'timeout') then perform public._err('VALIDATION', 'The outcome must be correct, wrong, pass or timeout.'); end if;
  perform public._r3_require(g, p_question_id, array['answering']);
  if g.current_team_id is distinct from p_team_id then perform public._err('R3_NOT_CURRENT_TEAM', 'It is not this team''s turn to answer.'); end if;
  if exists (select 1 from public.r3_events where session_id = g.id and question_id = g.question_id and team_id = p_team_id and kind = 'outcome') then
    perform public._err('R3_ALREADY_ANSWERED', 'This team already had its turn on this question.');
  end if;
  if p_outcome = 'timeout' and now() < g.answer_started_at + make_interval(secs => g.answer_seconds) then
    perform public._err('R3_TIMER_RUNNING', 'The answer timer is still running.');
  end if;
  select * into st from public.r3_session_teams where session_id = g.id and team_id = p_team_id for update;
  select amount into v_bid from public.r3_bids where session_id = g.id and question_id = g.question_id and team_id = p_team_id and status = 'bid';
  v_top := g.order_pos = 1;
  select * into d from public._r3_deltas(v_top, p_outcome, v_bid);
  update public.r3_session_teams set score = score + d.score_delta, budget = budget + d.budget_delta
  where session_id = g.id and team_id = p_team_id returning * into st;
  select * into t from public.teams where id = p_team_id;
  insert into public.r3_events (request_id, session_id, question_id, seq, team_id, team_number, team_name, kind, outcome, was_top, bid,
    score_delta, budget_delta, score_after, budget_after, actor)
  values (p_request_id, g.id, g.question_id, (select seq from public.r3_version_questions where id = g.question_id), t.id, t.team_number, t.team_name,
    'outcome', p_outcome, v_top, v_bid, d.score_delta, d.budget_delta, st.score, st.budget, auth.uid())
  returning id into v_id;
  update public.r3_sessions set last_event_id = v_id, updated_at = now() where id = g.id returning * into g;
  if p_outcome = 'correct' then
    perform public._r3_complete(g, 'correct', p_team_id); v_next := 'done';
  elsif g.order_pos < cardinality(g.bid_order) then
    update public.r3_sessions set phase = 'between', updated_at = now() where id = g.id; v_next := 'next_bidder';
  else
    perform public._r3_complete(g, 'no_correct', null); v_next := 'done';
  end if;
  return jsonb_build_object('duplicate_request', false, 'event_id', v_id, 'outcome', p_outcome, 'team_id', p_team_id, 'was_top', v_top, 'bid', v_bid,
    'score_delta', d.score_delta, 'budget_delta', d.budget_delta, 'next', v_next);
end $$;

create or replace function public.r3s_finish_question(p_session_id uuid, p_question_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions;
begin
  perform public._require_organizer();
  g := public._r3_lock_session(p_session_id);
  if g.phase = 'idle' then return jsonb_build_object('ok', true); end if;
  perform public._r3_require(g, p_question_id, array['done']);
  update public.r3_sessions set phase = 'idle', question_id = null, topic_revealed = false, bid_started_at = null, bids_closed_at = null,
    bid_seconds_current = null, bid_order = '{}', order_pos = 0, current_team_id = null, question_revealed = false, answer_started_at = null,
    answer_revealed = false, updated_at = now() where id = g.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.r3s_end_auction(p_session_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions;
begin
  perform public._require_organizer();
  perform public._r3_auto_close(p_session_id);
  select * into g from public.r3_sessions where id = p_session_id for update;
  if not found then perform public._err('R3_SESSION_NOT_FOUND', 'Round 3 auction not found.'); end if;
  if g.status = 'ended' then return jsonb_build_object('ok', true); end if;
  if g.phase not in ('idle', 'done') then perform public._err('R3_QUESTION_LIVE', 'Finish or cancel the open question before ending the auction.'); end if;
  update public.r3_sessions set status = 'ended', ended_at = now(), phase = 'idle', question_id = null, topic_revealed = false, bid_order = '{}',
    order_pos = 0, current_team_id = null, question_revealed = false, answer_started_at = null, answer_revealed = false, bid_started_at = null,
    bids_closed_at = null, bid_seconds_current = null, updated_at = now()
  where id = g.id returning * into g;
  perform public._r3_event(g, 'auction_ended');
  return jsonb_build_object('ok', true);
end $$;

-- Board of one auction (now VOLATILE: reading it closes an expired timed bidding first, so a refresh or a
-- reconnect after the deadline always shows bidding closed). Visibility rules unchanged from migration 13.
create or replace function public.r3s_board(p_session_id uuid, p_host boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.r3_sessions; v public.r3_versions; q public.r3_version_questions; a public.r3_version_answers;
  v_host boolean := coalesce(p_host, false); b jsonb; e public.r3_events;
begin
  perform public._require_organizer();
  perform public._r3_auto_close(p_session_id);
  select * into g from public.r3_sessions where id = p_session_id;
  if not found then perform public._err('R3_SESSION_NOT_FOUND', 'Round 3 auction not found.'); end if;
  select * into v from public.r3_versions where id = g.version_id;
  if g.question_id is not null then
    select * into q from public.r3_version_questions where id = g.question_id;
    select * into a from public.r3_version_answers where question_id = q.id;
  end if;
  if g.last_event_id is not null and g.phase in ('between', 'done') then select * into e from public.r3_events where id = g.last_event_id; end if;
  b := jsonb_build_object(
    'server_now', now(),
    'view', case when v_host then 'host' else 'projector' end,
    'session', jsonb_build_object('id', g.id, 'status', g.status, 'section', g.section, 'title', v.title, 'version', v.version,
      'results_revealed', g.results_revealed, 'started_at', g.started_at, 'ended_at', g.ended_at),
    'settings', jsonb_build_object('bid_timer_default', g.bid_timer_default, 'answer_seconds', g.answer_seconds, 'set_bid_seconds', v.bid_seconds,
      'min_bid', 10, 'bid_step', 10, 'max_timer', 3600),
    'questions', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'seq', x.seq, 'mode', x.mode, 'mystery_no', x.mystery_no,
        'label', case when x.mode = 'BLIND' then 'MYSTERY QUESTION #' || x.mystery_no else x.topic_name end,
        'used', exists (select 1 from public.r3_question_results r where r.session_id = g.id and r.question_id = x.id)) order by x.seq)
      from public.r3_version_questions x where x.version_id = v.id), '[]'::jsonb),
    'current', jsonb_build_object(
      'phase', g.phase, 'question_id', g.question_id, 'seq', q.seq, 'mode', q.mode, 'mystery_no', q.mystery_no,
      'label', case when q.id is null then null when q.mode = 'BLIND' then 'MYSTERY QUESTION #' || q.mystery_no else q.topic_name end,
      'topic', case when g.topic_revealed then q.topic_name end,
      'topic_revealed', g.topic_revealed,
      'question_text', case when g.question_revealed then q.question_text end,
      'question_revealed', g.question_revealed,
      'answer_text', case when g.answer_revealed then a.answer_text end,
      'explanation', case when g.answer_revealed then a.explanation end,
      'answer_revealed', g.answer_revealed,
      'bid_started_at', g.bid_started_at, 'bid_seconds', g.bid_seconds_current, 'bid_deadline', public._r3_bid_deadline(g),
      'bids_closed_at', g.bids_closed_at, 'answer_started_at', g.answer_started_at,
      'bid_order', to_jsonb(g.bid_order), 'order_pos', g.order_pos, 'current_team_id', g.current_team_id),
    'teams', public._r3_teams(g.id, v_host),
    'last_outcome', case when e.id is not null and e.kind = 'outcome' then jsonb_build_object('team_id', e.team_id, 'team_name', e.team_name,
        'team_number', e.team_number, 'outcome', e.outcome, 'was_top', e.was_top, 'budget_delta', e.budget_delta) end,
    'final', case when g.status = 'ended' and g.results_revealed then public._r3_ranking(g.id) end);
  if not v_host then return b; end if;
  return b
    || jsonb_build_object('current', (b->'current') || jsonb_build_object('topic', q.topic_name, 'question_text', q.question_text,
          'answer_text', a.answer_text, 'explanation', a.explanation))
    || jsonb_build_object(
      'session', (b->'session') || jsonb_build_object('join_code', (select join_code from public.r3_sets where id = g.set_id)),
      'question_list', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'seq', x.seq, 'mode', x.mode, 'mystery_no', x.mystery_no, 'topic_name', x.topic_name,
          'question_text', x.question_text, 'used', exists (select 1 from public.r3_question_results r where r.session_id = g.id and r.question_id = x.id)) order by x.seq)
        from public.r3_version_questions x where x.version_id = v.id), '[]'::jsonb),
      'last_outcome', case when e.id is not null and e.kind = 'outcome' then jsonb_build_object('team_id', e.team_id, 'team_name', e.team_name, 'team_number', e.team_number,
          'outcome', e.outcome, 'was_top', e.was_top, 'bid', e.bid, 'score_delta', e.score_delta, 'budget_delta', e.budget_delta) end,
      'ranking', public._r3_ranking(g.id),
      'log', coalesce((select jsonb_agg(to_jsonb(x) - 'request_id' order by x.id desc) from (select * from public.r3_events where session_id = g.id order by id desc limit 60) x), '[]'::jsonb));
end $$;

-- ===========================================================================
-- Function permissions (complete set, as migration 13, with the new Round 3 signatures)
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

-- Organizer RPCs (each checks organizer membership internally). Identical to migration 13.
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

-- Participant RPCs (anon and authenticated; identical to migration 13).
grant execute on function
  public.join_lookup(text), public.join_roster(text, text), public.join_registered_team(text, text, integer, text),
  public.join_team(text, integer, text, text),
  public.register_team(text, text, text, text, text, text), public.participant_state(text, integer),
  public.participant_start(text), public.participant_submit(text, uuid, uuid, text), public.participant_finish(text),
  public.participant_leave(text)
to anon, authenticated;

-- Self-check (as in migrations 12 and 13).
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

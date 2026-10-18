-- BRAINFREZE — COLD START · server-side logic
-- Every write goes through these SECURITY DEFINER functions. Each one checks
-- organizer membership first, validates input, and computes scores from the
-- private answer key. Clients never send a score.
-- Errors are raised as 'CODE: detail' (codes listed in src/lib/errors.js).
-- The local demo engine (src/lib/engine.js) mirrors this file.

-- ===========================================================================
-- Internal helpers (not executable by API roles; see security migration)
-- ===========================================================================
create or replace function public._err(p_code text, p_detail text default null) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = p_code || ': ' || coalesce(p_detail, '');
end $$;

create or replace function public.is_organizer() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.organizers o where o.user_id = auth.uid());
$$;

create or replace function public._require_organizer() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_organizer() then
    raise exception using errcode = '42501', message = 'NOT_AUTHORIZED: This account is not an authorized organizer.';
  end if;
end $$;

create or replace function public._clean(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g'), '');
$$;

create or replace function public._lock_current_session() returns public.quiz_sessions
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  select * into s from public.quiz_sessions where is_current for update;
  if not found then perform public._err('NO_SESSION'); end if;
  return s;
end $$;

create or replace function public._settings(p_session uuid) returns public.quiz_settings
language plpgsql security definer set search_path = '' as $$
declare st public.quiz_settings;
begin
  select * into st from public.quiz_settings where session_id = p_session;
  if not found then
    insert into public.quiz_settings (session_id) values (p_session) returning * into st;
  end if;
  return st;
end $$;

create or replace function public._elapsed_ms(s public.quiz_sessions) returns bigint
language sql stable set search_path = '' as $$
  select s.elapsed_ms + case
    when s.status = 'running' and s.timer_started_at is not null
      then greatest(0, floor(extract(epoch from (now() - s.timer_started_at)) * 1000))::bigint
    else 0 end;
$$;

create or replace function public._assert_scoring_open(s public.quiz_sessions, st public.quiz_settings) returns void
language plpgsql stable set search_path = '' as $$
begin
  if s.status = 'setup' then perform public._err('QUIZ_NOT_STARTED'); end if;
  if s.status = 'finalized' then perform public._err('RESULTS_FINALIZED'); end if;
  if s.corrections_enabled then return; end if;
  if s.status = 'ended' then perform public._err('QUIZ_ENDED'); end if;
  if public._elapsed_ms(s) >= st.duration_seconds::bigint * 1000 then perform public._err('TIME_EXPIRED'); end if;
end $$;

create or replace function public._normalize_option(p text) returns text
language plpgsql stable set search_path = '' as $$
declare v text := upper(btrim(coalesce(p, '')));
begin
  if v in ('', 'U', '-', 'UNANSWERED', 'NONE') then return null; end if;
  if v in ('A', 'B', 'C', 'D') then return v; end if;
  perform public._err('INVALID_OPTION');
  return null;
end $$;

create or replace function public._evaluate(
  p_selected text, p_key text, p_correct numeric, p_incorrect numeric, p_unanswered numeric,
  out result text, out points numeric)
language plpgsql stable set search_path = '' as $$
begin
  if p_selected is null then
    result := 'unanswered'; points := round(p_unanswered, 2); return;
  end if;
  if p_key is null then perform public._err('NO_ANSWER_KEY'); end if;
  if p_selected = p_key then result := 'correct'; points := round(p_correct, 2);
  else result := 'incorrect'; points := round(p_incorrect, 2);
  end if;
end $$;

create or replace function public._renumber_questions() returns void
language plpgsql security definer set search_path = '' as $$
begin
  with o as (select id, row_number() over (order by position, created_at) as rn from public.questions)
  update public.questions q set position = o.rn from o where q.id = o.id and q.position <> o.rn;
  update public.quiz_sessions s set
    current_index = greatest(0, least(s.current_index, (select count(*)::int from public.questions) - 1)),
    completed_question_ids = array(select x from unnest(s.completed_question_ids) x where exists (select 1 from public.questions q where q.id = x))
  where s.is_current;
end $$;

-- Re-evaluate recorded answers for one question after its key/marks change.
create or replace function public._rescore_question(s public.quiz_sessions, p_question uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  st public.quiz_settings := public._settings(s.id);
  q public.questions; k text; a public.team_answers; r record; n integer := 0;
begin
  select * into q from public.questions where id = p_question;
  select correct_option into k from public.question_keys where question_id = p_question;
  for a in select * from public.team_answers where session_id = s.id and question_id = p_question for update loop
    if s.status = 'finalized' then perform public._err('RESULTS_FINALIZED'); end if;
    select * into r from public._evaluate(a.selected_option, k, coalesce(q.marks_correct, st.marks_correct), coalesce(q.marks_incorrect, st.marks_incorrect), st.marks_unanswered);
    if r.result <> a.result or r.points <> a.points then
      update public.team_answers set result = r.result, points = r.points where id = a.id;
      insert into public.score_events (session_id, action, team_id, team_number, question_id, question_position,
        prev_selected, prev_result, prev_points, new_selected, new_result, new_points, reason, actor)
      values (s.id, 'rescore', a.team_id, (select team_number from public.teams where id = a.team_id), q.id, q.position,
        a.selected_option, a.result, a.points, a.selected_option, r.result, r.points, 'Answer key or marks changed', auth.uid());
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Ranking policy — identical to computeStandings() in src/lib/scoring.js:
--   points desc → (accuracy rule) fewer incorrect → tie-break result desc
--   (only when every team in that tied group has one) → shared rank.
create or replace function public._standings(p_session uuid)
returns table (team_id uuid, team_number integer, team_name text, is_demo boolean, points numeric,
               correct integer, incorrect integer, unanswered integer, recorded integer, tiebreak numeric, rank integer)
language sql stable security definer set search_path = '' as $$
  with st as (select * from public.quiz_settings where session_id = p_session),
  qn as (select count(*)::int as n from public.questions),
  agg as (
    select t.id, t.team_number, t.team_name, t.is_demo,
      coalesce(sum(a.points), 0) as rec_points,
      count(a.id) filter (where a.result = 'correct')::int as correct,
      count(a.id) filter (where a.result = 'incorrect')::int as incorrect,
      count(a.id)::int as recorded
    from public.teams t
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

-- ===========================================================================
-- Public RPCs (granted to authenticated; every one requires an organizer)
-- ===========================================================================

create or replace function public.server_now() returns timestamptz
language sql stable set search_path = '' as $$ select now(); $$;

create or replace function public.ensure_session() returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public._require_organizer();
  perform pg_advisory_xact_lock(hashtext('brainfreze.session'));
  select id into v_id from public.quiz_sessions where is_current;
  if v_id is null then
    insert into public.quiz_sessions (is_current) values (true) returning id into v_id;
    insert into public.quiz_settings (session_id) values (v_id);
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------- teams
create or replace function public.save_team(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_num_txt text := btrim(coalesce(p->>'team_number', ''));
  v_num integer; v_name text; v_p1 text; v_p2 text;
begin
  perform public._require_organizer();
  if v_num_txt !~ '^[0-9]{1,3}$' or v_num_txt::int < 1 then
    perform public._err('VALIDATION', 'Team number must be a whole number from 1 to 999.');
  end if;
  v_num := v_num_txt::int;
  v_name := public._clean(p->>'team_name');
  v_p1 := public._clean(p->>'participant_1');
  v_p2 := public._clean(p->>'participant_2');
  if v_name is null or char_length(v_name) > 80 then perform public._err('VALIDATION', 'Team name is required (max 80 characters).'); end if;
  if v_p1 is null or v_p2 is null then perform public._err('VALIDATION', 'Both participants are required (teams have exactly two members).'); end if;
  if char_length(v_p1) > 80 or char_length(v_p2) > 80 then perform public._err('VALIDATION', 'Participant names must be 80 characters or fewer.'); end if;
  if exists (select 1 from public.teams where team_number = v_num and id is distinct from v_id) then
    perform public._err('DUPLICATE_TEAM_NUMBER', format('Team number %s is already in use.', v_num));
  end if;
  if v_id is null then
    insert into public.teams (team_number, team_name, participant_1, participant_2, is_demo)
    values (v_num, v_name, v_p1, v_p2, coalesce((p->>'is_demo')::boolean, false))
    returning id into v_id;
  else
    update public.teams set team_number = v_num, team_name = v_name, participant_1 = v_p1, participant_2 = v_p2,
      is_demo = coalesce((p->>'is_demo')::boolean, is_demo)
    where id = v_id;
    if not found then perform public._err('TEAM_NOT_FOUND'); end if;
  end if;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.delete_team(p_id uuid, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.quiz_sessions; t public.teams; n integer; pts numeric;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
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
    values (s.id, 'delete_team', t.team_number, pts, format('Deleted team "%s" with %s recorded answer(s)', t.team_name, n), auth.uid());
  end if;
  delete from public.teams where id = p_id;
  return jsonb_build_object('deleted', true);
end $$;

create or replace function public.import_teams(p_rows jsonb, p_replace boolean default false, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.quiz_sessions; n_ans integer; existing integer; v_row jsonb; i bigint; cnt integer := 0; code text;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then perform public._err('VALIDATION', 'No team rows to import.'); end if;
  if p_replace then
    select count(*) into n_ans from public.team_answers where session_id = s.id;
    if n_ans > 0 and not coalesce(p_confirm, false) then perform public._err('TEAM_HAS_ANSWERS', 'Existing teams have recorded answers. Confirm to replace them.'); end if;
    if n_ans > 0 and s.status = 'finalized' then perform public._err('RESULTS_FINALIZED'); end if;
    if n_ans > 0 then
      insert into public.score_events (session_id, action, reason, actor)
      values (s.id, 'delete_team', format('Replaced all teams by import (%s recorded answer(s) removed)', n_ans), auth.uid());
    end if;
    delete from public.teams where true;
  end if;
  select count(*) into existing from public.teams;
  if existing + jsonb_array_length(p_rows) > 50 then
    perform public._err('TEAM_CAPACITY', format('Import would exceed 50 teams (%s existing + %s new).', existing, jsonb_array_length(p_rows)));
  end if;
  for v_row, i in select e, o from jsonb_array_elements(p_rows) with ordinality as x(e, o) loop
    begin
      perform public.save_team((v_row - 'id') - '__line');
    exception when others then
      code := coalesce(substring(sqlerrm from '^([A-Z_]{3,40}):'), case when sqlstate = '23505' then 'DUPLICATE_TEAM_NUMBER' else 'VALIDATION' end);
      raise exception using errcode = 'P0001',
        message = code || ': Row ' || coalesce(v_row->>'__line', i::text) || ': ' || regexp_replace(sqlerrm, '^[A-Z_]{3,40}:\s*', '');
    end;
    cnt := cnt + 1;
  end loop;
  return jsonb_build_object('imported', cnt);
end $$;

-- ---------------------------------------------------------------- questions
create or replace function public.save_question(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.quiz_sessions;
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
  s := public._lock_current_session();
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
      v_rescored := public._rescore_question(s, v_id);
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
declare s public.quiz_sessions; q public.questions; n integer;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  select * into q from public.questions where id = p_id for update;
  if not found then perform public._err('QUESTION_NOT_FOUND'); end if;
  if s.status in ('running', 'paused') then perform public._err('QUIZ_IN_PROGRESS'); end if;
  select count(*) into n from public.team_answers where session_id = s.id and question_id = p_id;
  if n > 0 and not coalesce(p_confirm, false) then
    perform public._err('QUESTION_HAS_ANSWERS', format('Q%s has %s recorded answer(s). Confirm to delete them too.', q.position, n));
  end if;
  if n > 0 then
    if s.status = 'finalized' then perform public._err('RESULTS_FINALIZED'); end if;
    insert into public.score_events (session_id, action, question_position, reason, actor)
    values (s.id, 'delete_question', q.position, format('Deleted Q%s with %s recorded answer(s)', q.position, n), auth.uid());
  end if;
  delete from public.questions where id = p_id;
  perform public._renumber_questions();
  return jsonb_build_object('deleted', true);
end $$;

create or replace function public.reorder_questions(p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status in ('running', 'paused') then perform public._err('QUIZ_IN_PROGRESS'); end if;
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
declare s public.quiz_sessions; n_ans integer; item jsonb; i bigint; cnt integer := 0; code text;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then perform public._err('VALIDATION', 'No questions to import.'); end if;
  if p_replace then
    if s.status in ('running', 'paused') then perform public._err('QUIZ_IN_PROGRESS'); end if;
    select count(*) into n_ans from public.team_answers where session_id = s.id;
    if n_ans > 0 and not coalesce(p_confirm, false) then perform public._err('QUESTION_HAS_ANSWERS', 'Existing questions have recorded answers. Confirm to replace them.'); end if;
    if n_ans > 0 and s.status = 'finalized' then perform public._err('RESULTS_FINALIZED'); end if;
    if n_ans > 0 then
      insert into public.score_events (session_id, action, reason, actor)
      values (s.id, 'delete_question', format('Replaced question bank by import (%s recorded answer(s) removed)', n_ans), auth.uid());
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

create or replace function public.remove_demo_data(p_teams boolean default true, p_questions boolean default true, p_confirm boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; n_t integer := 0; n_q integer := 0; a_t integer := 0; a_q integer := 0;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if p_teams then
    select count(*) into n_t from public.teams where is_demo;
    select count(*) into a_t from public.team_answers a join public.teams t on t.id = a.team_id where a.session_id = s.id and t.is_demo;
    if a_t > 0 and not coalesce(p_confirm, false) then perform public._err('TEAM_HAS_ANSWERS', format('Demo teams have %s recorded answer(s). Confirm to delete them too.', a_t)); end if;
  end if;
  if p_questions then
    select count(*) into n_q from public.questions where is_sample;
    if n_q > 0 and s.status in ('running', 'paused') then perform public._err('QUIZ_IN_PROGRESS'); end if;
    select count(*) into a_q from public.team_answers a join public.questions q on q.id = a.question_id where a.session_id = s.id and q.is_sample;
    if a_q > 0 and not coalesce(p_confirm, false) then perform public._err('QUESTION_HAS_ANSWERS', format('Sample questions have %s recorded answer(s). Confirm to delete them too.', a_q)); end if;
  end if;
  if (a_t > 0 or a_q > 0) and s.status = 'finalized' then perform public._err('RESULTS_FINALIZED'); end if;
  if a_t > 0 or a_q > 0 then
    insert into public.score_events (session_id, action, reason, actor)
    values (s.id, case when a_t > 0 then 'delete_team' else 'delete_question' end,
      format('Removed demo data (%s demo team answer(s), %s sample question answer(s))', a_t, a_q), auth.uid());
  end if;
  if p_teams then delete from public.teams where is_demo; end if;
  if p_questions then delete from public.questions where is_sample; perform public._renumber_questions(); end if;
  return jsonb_build_object('removedTeams', n_t, 'removedQuestions', n_q);
end $$;

-- ---------------------------------------------------------------- settings & session control
create or replace function public.update_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status <> 'setup' then perform public._err('INVALID_STATE', 'Scoring and timer settings are locked once the quiz has started.'); end if;
  perform public._settings(s.id);
  update public.quiz_settings set
    duration_seconds  = coalesce((p->>'duration_seconds')::numeric::int, duration_seconds),
    marks_correct     = coalesce((p->>'marks_correct')::numeric, marks_correct),
    marks_incorrect   = coalesce((p->>'marks_incorrect')::numeric, marks_incorrect),
    marks_unanswered  = coalesce((p->>'marks_unanswered')::numeric, marks_unanswered),
    qualify_count     = coalesce((p->>'qualify_count')::numeric::int, qualify_count),
    accuracy_tiebreak = coalesce((p->>'accuracy_tiebreak')::boolean, accuracy_tiebreak)
  where session_id = s.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.start_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; nt integer; nq integer;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status <> 'setup' then perform public._err('INVALID_STATE', 'The quiz has already started.'); end if;
  select count(*) into nt from public.teams;
  select count(*) into nq from public.questions;
  if nt = 0 then perform public._err('QUIZ_NOT_READY', 'Add at least one team.'); end if;
  if nq = 0 then perform public._err('QUIZ_NOT_READY', 'Add at least one question.'); end if;
  if exists (select 1 from public.questions q where not exists (select 1 from public.question_keys k where k.question_id = q.id)) then
    perform public._err('QUIZ_NOT_READY', 'Every question needs an answer key.');
  end if;
  perform public._settings(s.id);
  update public.quiz_sessions set status = 'running', started_at = now(), timer_started_at = now(), elapsed_ms = 0,
    current_index = 0, projector_view = 'question'
  where id = s.id;
  return jsonb_build_object('ok', true, 'server_now', now());
end $$;

create or replace function public.pause_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; st public.quiz_settings;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status <> 'running' then perform public._err('INVALID_STATE', 'The timer is not running.'); end if;
  st := public._settings(s.id);
  update public.quiz_sessions set status = 'paused', timer_started_at = null,
    elapsed_ms = least(st.duration_seconds::bigint * 1000, public._elapsed_ms(s))
  where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.resume_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status <> 'paused' then perform public._err('INVALID_STATE', 'The timer is not paused.'); end if;
  update public.quiz_sessions set status = 'running', timer_started_at = now() where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.reset_timer() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status not in ('running', 'paused') then perform public._err('INVALID_STATE', 'The timer can only be reset while the quiz is running or paused.'); end if;
  update public.quiz_sessions set elapsed_ms = 0,
    timer_started_at = case when s.status = 'running' then now() else null end
  where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.end_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; st public.quiz_settings;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status not in ('running', 'paused') then perform public._err('INVALID_STATE', 'The quiz is not running.'); end if;
  st := public._settings(s.id);
  update public.quiz_sessions set status = 'ended', timer_started_at = null, ended_at = now(),
    elapsed_ms = least(st.duration_seconds::bigint * 1000, public._elapsed_ms(s))
  where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.go_to_question(p_index integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if p_index is null or p_index < 0 or p_index >= (select count(*) from public.questions) then
    perform public._err('VALIDATION', 'Question index out of range.');
  end if;
  update public.quiz_sessions set current_index = p_index where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.set_question_completed(p_question_id uuid, p_completed boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if not exists (select 1 from public.questions where id = p_question_id) then perform public._err('QUESTION_NOT_FOUND'); end if;
  update public.quiz_sessions set completed_question_ids = case
      when p_completed then array(select distinct x from unnest(array_append(completed_question_ids, p_question_id)) x)
      else array_remove(completed_question_ids, p_question_id) end
  where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.set_projector_view(p_view text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if p_view not in ('standby', 'question', 'leaderboard', 'reveal') then perform public._err('VALIDATION', 'Unknown projector view.'); end if;
  if p_view = 'reveal' and not s.results_revealed then
    perform public._err('NOT_FINALIZED', 'Reveal results (after confirming qualifiers) before showing the reveal screen.');
  end if;
  update public.quiz_sessions set projector_view = p_view where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.set_corrections(p_enabled boolean, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status in ('setup', 'finalized') then
    perform public._err('INVALID_STATE', 'Corrections can be authorized only after the quiz starts and before results are finalized.');
  end if;
  if p_enabled and public._clean(p_reason) is null then perform public._err('REASON_REQUIRED'); end if;
  update public.quiz_sessions set corrections_enabled = coalesce(p_enabled, false) where id = s.id;
  insert into public.score_events (session_id, action, reason, actor)
  values (s.id, 'authorize', case when p_enabled then 'Enabled: ' || public._clean(p_reason) else 'Disabled' end, auth.uid());
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.new_session() returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; st public.quiz_settings; v_id uuid;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  st := public._settings(s.id);
  update public.quiz_sessions set is_current = false where id = s.id;
  insert into public.quiz_sessions (is_current) values (true) returning id into v_id;
  insert into public.quiz_settings (session_id, duration_seconds, marks_correct, marks_incorrect, marks_unanswered, qualify_count, accuracy_tiebreak)
  values (v_id, st.duration_seconds, st.marks_correct, st.marks_incorrect, st.marks_unanswered, st.qualify_count, st.accuracy_tiebreak);
  return v_id;
end $$;

-- ---------------------------------------------------------------- scoring
create or replace function public.record_answer(
  p_request_id uuid, p_team_id uuid, p_question_id uuid, p_selected text,
  p_correction boolean default false, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.quiz_sessions; st public.quiz_settings; t public.teams; q public.questions;
  ev public.score_events; ex public.team_answers; has_ex boolean;
  k text; sel text; r record; v_action text; v_id bigint;
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
  select * into t from public.teams where id = p_team_id;
  if not found then perform public._err('TEAM_NOT_FOUND'); end if;
  select * into q from public.questions where id = p_question_id;
  if not found then perform public._err('QUESTION_NOT_FOUND'); end if;
  select correct_option into k from public.question_keys where question_id = q.id;
  sel := public._normalize_option(p_selected);
  select * into r from public._evaluate(sel, k, coalesce(q.marks_correct, st.marks_correct), coalesce(q.marks_incorrect, st.marks_incorrect), st.marks_unanswered);

  select * into ex from public.team_answers where session_id = s.id and team_id = t.id and question_id = q.id for update;
  has_ex := found;
  if has_ex then
    if not coalesce(p_correction, false) then perform public._err('ALREADY_RECORDED'); end if;
    if public._clean(p_reason) is null then perform public._err('REASON_REQUIRED', 'A reason is required to correct a recorded answer.'); end if;
    if ex.selected_option is not distinct from sel then perform public._err('NO_CHANGE'); end if;
    update public.team_answers set selected_option = sel, result = r.result, points = r.points, recorded_by = auth.uid() where id = ex.id;
    v_action := 'correction';
  else
    insert into public.team_answers (session_id, team_id, question_id, selected_option, result, points, recorded_by)
    values (s.id, t.id, q.id, sel, r.result, r.points, auth.uid());
    v_action := 'record';
  end if;

  insert into public.score_events (session_id, request_id, action, team_id, team_number, question_id, question_position,
    prev_selected, prev_result, prev_points, new_selected, new_result, new_points, reason, actor)
  values (s.id, p_request_id, v_action, t.id, t.team_number, q.id, q.position,
    case when has_ex then ex.selected_option end, case when has_ex then ex.result end, case when has_ex then ex.points end,
    sel, r.result, r.points, case when has_ex then public._clean(p_reason) end, auth.uid())
  returning id into v_id;

  return jsonb_build_object('duplicate_request', false, 'event_id', v_id, 'action', v_action, 'result', r.result, 'points', r.points, 'selected', sel);
end $$;

create or replace function public.undo_last_action(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.quiz_sessions; st public.quiz_settings; ev public.score_events; tgt public.score_events;
  ex public.team_answers; q public.questions; k text; r record; v_id bigint;
  v_sel text; v_res text; v_pts numeric;
begin
  perform public._require_organizer();
  if p_request_id is null then perform public._err('VALIDATION', 'request_id is required.'); end if;
  s := public._lock_current_session();
  select * into ev from public.score_events where request_id = p_request_id;
  if found then return jsonb_build_object('duplicate_request', true, 'event_id', ev.id, 'undo_of', ev.undo_of); end if;
  st := public._settings(s.id);
  perform public._assert_scoring_open(s, st);
  select * into tgt from public.score_events
  where session_id = s.id and action in ('record', 'correction') and not undone
  order by id desc limit 1 for update;
  if not found then perform public._err('NOTHING_TO_UNDO'); end if;
  select * into ex from public.team_answers
  where session_id = s.id and team_id = tgt.team_id and question_id = tgt.question_id for update;
  if not found or ex.selected_option is distinct from tgt.new_selected then perform public._err('UNDO_CONFLICT'); end if;
  select * into q from public.questions where id = tgt.question_id;

  if tgt.action = 'record' then
    delete from public.team_answers where id = ex.id;
  else
    select correct_option into k from public.question_keys where question_id = q.id;
    select * into r from public._evaluate(tgt.prev_selected, k, coalesce(q.marks_correct, st.marks_correct), coalesce(q.marks_incorrect, st.marks_incorrect), st.marks_unanswered);
    update public.team_answers set selected_option = tgt.prev_selected, result = r.result, points = r.points, recorded_by = auth.uid() where id = ex.id;
    v_sel := tgt.prev_selected; v_res := r.result; v_pts := r.points;
  end if;
  update public.score_events set undone = true where id = tgt.id;
  insert into public.score_events (session_id, request_id, action, undo_of, team_id, team_number, question_id, question_position,
    prev_selected, prev_result, prev_points, new_selected, new_result, new_points, reason, actor)
  values (s.id, p_request_id, 'undo', tgt.id, tgt.team_id, tgt.team_number, tgt.question_id, coalesce(q.position, tgt.question_position),
    ex.selected_option, ex.result, ex.points,
    v_sel, v_res, v_pts,
    'Undo of #' || tgt.id, auth.uid())
  returning id into v_id;
  return jsonb_build_object('duplicate_request', false, 'event_id', v_id, 'undo_of', tgt.id);
end $$;

-- ---------------------------------------------------------------- results
create or replace function public.get_standings()
returns table (team_id uuid, team_number integer, team_name text, is_demo boolean, points numeric,
               correct integer, incorrect integer, unanswered integer, recorded integer, tiebreak numeric, rank integer)
language plpgsql stable security definer set search_path = '' as $$
declare v_sid uuid;
begin
  perform public._require_organizer();
  select id into v_sid from public.quiz_sessions where is_current;
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
  select * into t from public.teams where id = p_team_id;
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

create or replace function public.confirm_qualifiers(p_team_ids uuid[], p_override_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.quiz_sessions; st public.quiz_settings; target integer; boundary integer;
  ids uuid[]; ranks integer[]; certain uuid[]; tied uuid[]; slots integer; unresolved boolean; nums text;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status = 'finalized' then perform public._err('RESULTS_FINALIZED'); end if;
  if s.status <> 'ended' then perform public._err('QUIZ_NOT_ENDED'); end if;
  st := public._settings(s.id);
  select coalesce(array_agg(b.team_id order by b.rank, b.team_number), '{}'), coalesce(array_agg(b.rank order by b.rank, b.team_number), '{}')
    into ids, ranks from public._standings(s.id) b;
  target := least(st.qualify_count, cardinality(ids));
  if target = 0 or coalesce(cardinality(p_team_ids), 0) <> target
     or (select count(distinct x) from unnest(p_team_ids) x) <> target then
    perform public._err('QUALIFIER_COUNT', format('Select exactly %s distinct teams.', target));
  end if;
  boundary := ranks[target];
  certain := array(select ids[i] from generate_subscripts(ids, 1) i where ranks[i] < boundary);
  tied := array(select ids[i] from generate_subscripts(ids, 1) i where ranks[i] = boundary);
  slots := target - cardinality(certain);
  unresolved := cardinality(tied) > slots;
  if not unresolved then
    if not (array_cat(certain, tied) <@ p_team_ids) then perform public._err('QUALIFIERS_MISMATCH'); end if;
  else
    if public._clean(p_override_reason) is null then perform public._err('TIE_UNRESOLVED'); end if;
    if not (certain <@ p_team_ids) or not (p_team_ids <@ array_cat(certain, tied)) then perform public._err('QUALIFIERS_MISMATCH'); end if;
  end if;
  update public.quiz_sessions set status = 'finalized', corrections_enabled = false, qualifiers = p_team_ids,
    qualifiers_confirmed_at = now(), qualification_note = case when unresolved then public._clean(p_override_reason) end
  where id = s.id;
  select string_agg(t.team_number::text, ', ' order by array_position(p_team_ids, t.id)) into nums from public.teams t where t.id = any (p_team_ids);
  insert into public.score_events (session_id, action, reason, actor)
  values (s.id, 'qualify', 'Qualifiers: teams ' || nums || case when unresolved then ' (tie override: ' || public._clean(p_override_reason) || ')' else '' end, auth.uid());
  return jsonb_build_object('ok', true, 'override', unresolved);
end $$;

create or replace function public.reopen_results(p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status <> 'finalized' then perform public._err('INVALID_STATE', 'Results are not finalized.'); end if;
  if public._clean(p_reason) is null then perform public._err('REASON_REQUIRED'); end if;
  update public.quiz_sessions set status = 'ended', qualifiers = null, qualifiers_confirmed_at = null, qualification_note = null,
    results_revealed = false, projector_view = case when projector_view = 'reveal' then 'standby' else projector_view end
  where id = s.id;
  insert into public.score_events (session_id, action, reason, actor) values (s.id, 'reopen', public._clean(p_reason), auth.uid());
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.reveal_results(p_reveal boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status <> 'finalized' then perform public._err('NOT_FINALIZED'); end if;
  update public.quiz_sessions set results_revealed = coalesce(p_reveal, false),
    projector_view = case when p_reveal then 'reveal' else 'standby' end
  where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- backup restore
-- Replaces ALL quiz data with the backup (the client validates and confirms
-- first; constraints re-validate every row here). A running session is
-- restored as paused.
create or replace function public.restore_backup(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_sid uuid; sess jsonb := p->'session'; v_status text;
begin
  perform public._require_organizer();
  if p->>'app' is distinct from 'brainfreze-cold-start' or (p->>'format_version')::int is distinct from 1 then
    perform public._err('INVALID_BACKUP');
  end if;
  if jsonb_typeof(p->'teams') <> 'array' or jsonb_typeof(p->'questions') <> 'array' or jsonb_typeof(sess) <> 'object' then
    perform public._err('INVALID_BACKUP');
  end if;
  perform pg_advisory_xact_lock(hashtext('brainfreze.session'));
  delete from public.quiz_sessions where true;
  delete from public.questions where true;
  delete from public.teams where true;

  insert into public.teams (id, team_number, team_name, participant_1, participant_2, is_demo, created_at)
  select x.id, x.team_number, x.team_name, x.participant_1, x.participant_2, coalesce(x.is_demo, false), coalesce(x.created_at, now())
  from jsonb_to_recordset(p->'teams') as x(id uuid, team_number int, team_name text, participant_1 text, participant_2 text, is_demo boolean, created_at timestamptz);

  insert into public.questions (id, position, question_text, option_a, option_b, option_c, option_d, image_url, category, marks_correct, marks_incorrect, is_sample, created_at)
  select x.id, row_number() over (order by x.position), x.question_text, x.option_a, x.option_b, x.option_c, x.option_d, x.image_url, x.category,
         x.marks_correct, x.marks_incorrect, coalesce(x.is_sample, false), coalesce(x.created_at, now())
  from jsonb_to_recordset(p->'questions') as x(id uuid, position int, question_text text, option_a text, option_b text, option_c text, option_d text,
       image_url text, category text, marks_correct numeric, marks_incorrect numeric, is_sample boolean, created_at timestamptz);
  insert into public.question_keys (question_id, correct_option, explanation)
  select x.id, upper(x.correct_option), x.explanation from jsonb_to_recordset(p->'questions') as x(id uuid, correct_option text, explanation text);

  v_status := sess->>'status';
  v_sid := (sess->>'id')::uuid;
  insert into public.quiz_sessions (id, name, is_current, status, current_index, completed_question_ids, started_at, timer_started_at,
    elapsed_ms, ended_at, corrections_enabled, projector_view, results_revealed, qualifiers, qualifiers_confirmed_at, qualification_note, created_at)
  values (v_sid, coalesce(sess->>'name', 'COLD START'), true,
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
  from jsonb_to_record(coalesce(p->'settings', '{}'::jsonb)) as x(duration_seconds int, marks_correct numeric, marks_incorrect numeric,
       marks_unanswered numeric, qualify_count int, accuracy_tiebreak boolean);

  insert into public.team_answers (session_id, team_id, question_id, selected_option, result, points, created_at)
  select v_sid, x.team_id, x.question_id, x.selected_option, x.result, x.points, coalesce(x.created_at, now())
  from jsonb_to_recordset(coalesce(p->'answers', '[]'::jsonb)) as x(session_id uuid, team_id uuid, question_id uuid, selected_option text, result text, points numeric, created_at timestamptz)
  where x.session_id = v_sid;

  insert into public.tiebreak_results (session_id, team_id, score, note)
  select v_sid, x.team_id, x.score, x.note
  from jsonb_to_recordset(coalesce(p->'tiebreaks', '[]'::jsonb)) as x(session_id uuid, team_id uuid, score numeric, note text)
  where x.session_id = v_sid;

  insert into public.score_events (id, session_id, request_id, action, team_id, team_number, question_id, question_position,
    prev_selected, prev_result, prev_points, new_selected, new_result, new_points, undone, undo_of, reason, actor, created_at)
  select x.id, v_sid, x.request_id, x.action,
    case when exists (select 1 from public.teams t where t.id = x.team_id) then x.team_id end, x.team_number,
    case when exists (select 1 from public.questions q where q.id = x.question_id) then x.question_id end, x.question_position,
    x.prev_selected, x.prev_result, x.prev_points, x.new_selected, x.new_result, x.new_points, coalesce(x.undone, false), x.undo_of,
    x.reason, null, coalesce(x.created_at, now())
  from jsonb_to_recordset(coalesce(p->'events', '[]'::jsonb)) as x(id bigint, session_id uuid, request_id uuid, action text, team_id uuid, team_number int,
       question_id uuid, question_position int, prev_selected text, prev_result text, prev_points numeric, new_selected text, new_result text,
       new_points numeric, undone boolean, undo_of bigint, reason text, created_at timestamptz)
  where x.session_id = v_sid
  order by x.id;
  perform setval(pg_get_serial_sequence('public.score_events', 'id'), greatest(coalesce((select max(id) from public.score_events), 0), 1));

  insert into public.score_events (session_id, action, reason, actor)
  values (v_sid, 'restore', 'Restored backup exported ' || coalesce(p->>'exported_at', 'at unknown time'), auth.uid());
  perform public._renumber_questions();
  return jsonb_build_object('ok', true);
end $$;

-- Round 1 (COLD START) setup simplification.
--  * A quiz set may have any number of questions; publishing needs at least one complete MCQ
--    (previously 30–60, and at most 60 could be selected).
--  * The time limit per team is any positive whole number of seconds chosen by the organizer
--    (previously 5–120 minutes in update_settings / publish_quiz and 1–240 minutes in the table).
-- Only checks are relaxed: no data is changed or deleted, and existing grants are kept
-- (create or replace preserves function privileges). Round 2 / Round 3 objects are untouched.

alter table public.quiz_settings drop constraint if exists quiz_settings_duration_seconds_check;
alter table public.quiz_settings add constraint quiz_settings_duration_seconds_check check (duration_seconds > 0);

-- Name and description always; section, questions and self-registration only while a draft.
create or replace function public.update_quiz_details(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; v_name text; v_desc text; v_ids uuid[]; v_self boolean; v_section text;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  v_name := coalesce(public._clean(p->>'name'), s.name);
  if char_length(v_name) > 80 then perform public._err('VALIDATION', 'Quiz set name must be 80 characters or fewer.'); end if;
  v_desc := case when p ? 'description' then public._clean(p->>'description') else s.description end;
  if v_desc is not null and char_length(v_desc) > 500 then perform public._err('VALIDATION', 'Description must be 500 characters or fewer.'); end if;
  v_self := coalesce((p->>'self_registration')::boolean, s.self_registration);
  v_section := upper(coalesce(p->>'section', s.section));
  if v_section not in ('UG', 'PG') then perform public._err('VALIDATION', 'Section must be UG or PG.'); end if;
  if (v_section <> s.section or (p ? 'question_ids')) and s.published_at is not null then
    perform public._err('SET_FROZEN', 'A published set''s section and questions are frozen.');
  end if;
  if p ? 'question_ids' then
    if jsonb_typeof(p->'question_ids') = 'null' then
      v_ids := null;
    elsif jsonb_typeof(p->'question_ids') = 'array' then
      if (select count(*) from jsonb_array_elements_text(p->'question_ids')) <> (select count(distinct x) from jsonb_array_elements_text(p->'question_ids') x) then
        perform public._err('VALIDATION', 'A question can be selected only once.');
      end if;
      v_ids := array(select (jsonb_array_elements_text(p->'question_ids'))::uuid);
      if cardinality(v_ids) = 0 then perform public._err('VALIDATION', 'Select at least one question.'); end if;
      if exists (select 1 from unnest(v_ids) x where not exists (select 1 from public.questions q where q.id = x)) then
        perform public._err('VALIDATION', 'A selected question no longer exists.');
      end if;
    else
      perform public._err('VALIDATION', 'question_ids must be an array or null.');
    end if;
  else
    v_ids := s.question_ids;
  end if;
  update public.quiz_sessions set name = v_name, description = v_desc, question_ids = v_ids, self_registration = v_self,
    section = v_section, self_paced = true
  where id = s.id;
  perform public._renumber_questions();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.update_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; v_dur numeric := (p->>'duration_seconds')::numeric;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.published_at is not null or s.status <> 'setup' then
    perform public._err('SET_FROZEN', 'Timer and scoring are frozen once the set is published.');
  end if;
  if v_dur is not null and (round(v_dur) < 1 or v_dur > 2147483647) then
    perform public._err('VALIDATION', 'The time limit must be a positive number of minutes.');
  end if;
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

-- Validate, freeze (snapshot) and open for joining — one transaction.
create or replace function public.publish_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; st public.quiz_settings; c text; n integer;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if not s.is_current then perform public._err('INVALID_STATE', 'An archived set cannot be published.'); end if;
  if s.status in ('ended', 'finalized') then perform public._err('INVALID_STATE', 'A completed set cannot be published again. Duplicate it instead.'); end if;
  if s.join_code_active then return jsonb_build_object('ok', true, 'join_code', s.join_code); end if;
  if s.published_at is not null then
    perform public._err('INVALID_STATE', 'This set''s code was revoked. Use "New code" to issue a fresh one.');
  end if;
  st := public._settings(s.id);
  n := public._session_question_count(s);
  if n < 1 then
    perform public._err('QUESTION_COUNT', 'Add at least one question before publishing.');
  end if;
  perform public._assert_quiz_ready(s, false);
  if st.duration_seconds < 1 then
    perform public._err('VALIDATION', 'The time limit must be a positive number of minutes.');
  end if;
  if exists (select 1 from public._session_questions(s) sq join public.questions q on q.id = sq.id
             where coalesce(q.marks_correct, st.marks_correct) < 0 or coalesce(q.marks_incorrect, st.marks_incorrect) > 0) then
    perform public._err('VALIDATION', 'Every question needs valid marks (correct ≥ 0, incorrect ≤ 0).');
  end if;
  delete from public.set_questions where session_id = s.id;
  insert into public.set_questions (session_id, question_id, position, question_text, option_a, option_b, option_c, option_d,
    image_url, category, correct_option, explanation, marks_correct, marks_incorrect)
  select s.id, q.id, sq.idx + 1, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.image_url, q.category,
         k.correct_option, k.explanation, coalesce(q.marks_correct, st.marks_correct), coalesce(q.marks_incorrect, st.marks_incorrect)
  from public._session_questions(s) sq join public.questions q on q.id = sq.id join public.question_keys k on k.question_id = q.id;
  update public.quiz_sessions set published_at = now(), published_by = auth.uid(), self_paced = true,
    question_ids = (select array_agg(question_id order by position) from public.set_questions where session_id = s.id)
  where id = s.id;
  c := public._issue_join_code(s.id);
  update public.quiz_sessions set registration_open = true where id = s.id;
  return jsonb_build_object('ok', true, 'join_code', c);
end $$;

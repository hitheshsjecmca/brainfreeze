-- Migration 17 — Round 1: fresh quiz sets, 2–6 answer options, participant self-join with a verified code.
--
-- Quiz sets
--   * create_set starts every new set with an EMPTY question list (question_ids = '{}'); it never picks up the
--     question bank or another set's questions. Existing sets are not changed.
--   * import_set_questions(items) COPIES questions from previous sets into the selected draft: each copy is a new
--     bank question (questions.source_question_id = the root original, also for a copy of a copy), so editing it never touches the original
--     question or set. A question already in the draft (itself, or a copy of the same original) is skipped.
--     previous_set_questions() lists the other sets' questions (frozen copies for published sets) to choose from.
--   * save_set_question(p) saves a NEW question and appends it to the draft in one transaction (Save & Next);
--     editing an existing question is the same as save_question.
--   * update_quiz_details accepts an empty question list for a draft (publishing still needs one question).
-- Answer options
--   * A question has 2 to 6 options, A–F, without gaps (questions.option_e / option_f added, option_c / option_d
--     may be empty). The key must be one of the question's own options. Published copies (set_questions), the
--     per-team option order (quiz_attempts.option_orders now 2–6 letters), participant_state, participant_submit,
--     record_answer and correct_set_question all use the question's own option count.
-- Participants
--   * join_quiz(code, full name, college, request id, section, device): the participant identifies themselves
--     when joining; there is no pre-registration, team list or PIN. The code (validated here) decides the set and
--     its UG/PG section; a section sent by the client that differs is refused. The entry is stored as a teams row
--     (participant_1 = full name, college_name, section, self_registered, join_session_id = the set), added to the
--     set's participants and given its attempt, so scoring, timers, shuffling, results, Round 2 qualification and
--     exports keep working unchanged. A retried request (same request id) never creates a second entry or attempt;
--     the same name + college in the same set is one entry (unique index). An entry stays bound to its device until
--     an organizer releases it (revoke_participant); then the same name + college can resume the same attempt.
--   * start_quiz no longer requires pre-selected teams (participants join themselves, before or after Go live).
--   * Retired (no longer granted to any API role; definitions and data are kept): join_roster,
--     join_registered_team, join_team, register_team and the registration desk RPCs (registration_access,
--     is_registration_staff, reg_overview, reg_save_team). No table, column or row is dropped.
-- No new tables are created, so no new table grants are needed (new columns inherit the existing table grants;
-- RLS is unchanged). Function permissions are re-applied in full at the end.

-- ===========================================================================
-- Schema
-- ===========================================================================
alter table public.questions add column if not exists option_e text;
alter table public.questions add column if not exists option_f text;
alter table public.questions add column if not exists source_question_id uuid references public.questions (id) on delete set null;
alter table public.questions alter column option_c drop not null;
alter table public.questions alter column option_d drop not null;
alter table public.questions drop constraint if exists questions_option_c_check;
alter table public.questions drop constraint if exists questions_option_d_check;
alter table public.questions drop constraint if exists questions_option_cdef_ck;
alter table public.questions add constraint questions_option_cdef_ck check (
  (option_c is null or char_length(btrim(option_c)) between 1 and 300)
  and (option_d is null or char_length(btrim(option_d)) between 1 and 300)
  and (option_e is null or char_length(btrim(option_e)) between 1 and 300)
  and (option_f is null or char_length(btrim(option_f)) between 1 and 300));
alter table public.questions drop constraint if exists questions_options_contiguous_ck;
alter table public.questions add constraint questions_options_contiguous_ck check (
  (option_d is null or option_c is not null) and (option_e is null or option_d is not null) and (option_f is null or option_e is not null));
create index if not exists questions_source_idx on public.questions (source_question_id) where source_question_id is not null;

alter table public.question_keys drop constraint if exists question_keys_correct_option_check;
alter table public.question_keys add constraint question_keys_correct_option_check check (correct_option in ('A', 'B', 'C', 'D', 'E', 'F'));

alter table public.set_questions add column if not exists option_e text;
alter table public.set_questions add column if not exists option_f text;
alter table public.set_questions alter column option_c drop not null;
alter table public.set_questions alter column option_d drop not null;
alter table public.set_questions drop constraint if exists set_questions_correct_option_check;
alter table public.set_questions add constraint set_questions_correct_option_check check (correct_option in ('A', 'B', 'C', 'D', 'E', 'F'));

alter table public.team_answers drop constraint if exists team_answers_selected_option_check;
alter table public.team_answers add constraint team_answers_selected_option_check check (selected_option in ('A', 'B', 'C', 'D', 'E', 'F'));
alter table public.team_answers drop constraint if exists team_answers_displayed_ck;
alter table public.team_answers add constraint team_answers_displayed_ck check (displayed_option is null or displayed_option in ('A', 'B', 'C', 'D', 'E', 'F'));

-- Self-joined participants: one person, so participant_2 may be empty.
alter table public.teams alter column participant_2 drop not null;
alter table public.teams drop constraint if exists teams_participant_2_check;
alter table public.teams add constraint teams_participant_2_check check (participant_2 is null or char_length(btrim(participant_2)) between 1 and 80);
alter table public.teams add column if not exists join_session_id uuid references public.quiz_sessions (id) on delete set null;
alter table public.teams add column if not exists join_request_id uuid;
-- A retried join request, and the same name + college in the same set, are one entry.
create unique index if not exists teams_join_request_key on public.teams (join_session_id, join_request_id)
  where join_session_id is not null and join_request_id is not null;
create unique index if not exists teams_join_identity_key on public.teams (join_session_id, lower(participant_1), lower(college_name))
  where join_session_id is not null;

-- ===========================================================================
-- Options helpers
-- ===========================================================================
-- Options are contiguous (A, B, then C…F only when the previous one exists).
create or replace function public._option_count(p_c text, p_d text, p_e text, p_f text) returns integer
language sql immutable set search_path = '' as $$
  select 2 + (p_c is not null)::int + (p_c is not null and p_d is not null)::int
           + (p_c is not null and p_d is not null and p_e is not null)::int
           + (p_c is not null and p_d is not null and p_e is not null and p_f is not null)::int;
$$;

create or replace function public._normalize_option(p text) returns text
language plpgsql stable set search_path = '' as $$
declare v text := upper(btrim(coalesce(p, '')));
begin
  if v in ('', 'U', '-', 'UNANSWERED', 'NONE') then return null; end if;
  if v in ('A', 'B', 'C', 'D', 'E', 'F') then return v; end if;
  perform public._err('INVALID_OPTION');
  return null;
end $$;

-- One question of a set with ALL its options and its option count (snapshot when published). A separate helper, so
-- public._set_question (used by scoring) keeps its signature and older migrations stay re-runnable.
create or replace function public._set_question_options(s public.quiz_sessions, p_question uuid)
returns table (id uuid, pos integer, question_text text, option_a text, option_b text, option_c text, option_d text,
               option_e text, option_f text, image_url text, correct_option text, explanation text, option_count integer)
language sql stable security definer set search_path = '' as $$
  select sq.question_id, sq.position, sq.question_text, sq.option_a, sq.option_b, sq.option_c, sq.option_d, sq.option_e, sq.option_f,
         sq.image_url, sq.correct_option::text, sq.explanation, public._option_count(sq.option_c, sq.option_d, sq.option_e, sq.option_f)
  from public.set_questions sq where s.published_at is not null and sq.session_id = s.id and sq.question_id = p_question
  union all
  select q.id, q.position, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.option_e, q.option_f, q.image_url,
         k.correct_option::text, k.explanation, public._option_count(q.option_c, q.option_d, q.option_e, q.option_f)
  from public.questions q
  left join public.question_keys k on k.question_id = q.id
  where s.published_at is null and q.id = p_question;
$$;

-- New attempt: random question order, and for every question a random order of ITS OWN options (2–6 letters).
create or replace function public._make_attempt(s public.quiz_sessions, p_team uuid) returns public.quiz_attempts
language plpgsql security definer set search_path = '' as $$
declare a public.quiz_attempts; v_order uuid[]; v_opts text[];
begin
  select array_agg(id order by gen_random_uuid()) into v_order from public._session_questions(s);
  -- correlated with each question so every question gets its own random option order
  select array_agg((select string_agg(chr(64 + g), '' order by gen_random_uuid())
                    from generate_series(1, coalesce((select x.option_count from public._set_question_options(s, o.qid) x), 4)) g) order by o.i)
    into v_opts
  from unnest(v_order) with ordinality as o(qid, i);
  insert into public.quiz_attempts (session_id, team_id, question_order, option_orders)
  values (s.id, p_team, coalesce(v_order, '{}'), coalesce(v_opts, '{}')) returning * into a;
  return a;
end $$;

-- ===========================================================================
-- Question bank: 2–6 options
-- ===========================================================================
create or replace function public.save_question(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_text text := public._clean(p->>'question_text');
  v_opts text[] := array[public._clean(p->>'option_a'), public._clean(p->>'option_b'), public._clean(p->>'option_c'),
                         public._clean(p->>'option_d'), public._clean(p->>'option_e'), public._clean(p->>'option_f')];
  v_cnt integer := case when coalesce(p->>'option_count', '') ~ '^[0-9]+$' then (p->>'option_count')::int end;
  v_key text := upper(btrim(coalesce(p->>'correct_option', '')));
  v_expl text := public._clean(p->>'explanation');
  v_img text := nullif(btrim(coalesce(p->>'image_url', '')), '');
  v_cat text := public._clean(p->>'category');
  v_mc numeric := nullif(btrim(coalesce(p->>'marks_correct', '')), '')::numeric;
  v_mi numeric := nullif(btrim(coalesce(p->>'marks_incorrect', '')), '')::numeric;
  v_sample boolean := coalesce((p->>'is_sample')::boolean, false);
  v_n integer; v_pos integer; n integer; i integer;
begin
  perform public._require_organizer();
  if v_text is null then perform public._err('VALIDATION', 'Question text is required.'); end if;
  -- Removed options are never stored: everything after option_count is dropped.
  if v_cnt is not null then
    if v_cnt < 2 or v_cnt > 6 then perform public._err('VALIDATION', 'A question has 2 to 6 options.'); end if;
    for i in (v_cnt + 1)..6 loop v_opts[i] := null; end loop;
  end if;
  select coalesce(max(o.i), 0) into v_n from unnest(v_opts) with ordinality as o(v, i) where o.v is not null;
  if v_cnt is not null and v_n < v_cnt then v_n := v_cnt; end if;
  if v_n < 2 then perform public._err('VALIDATION', 'A question needs at least two options (A and B).'); end if;
  for i in 1..v_n loop
    if v_opts[i] is null then perform public._err('VALIDATION', format('Option %s is empty. Enter its text or remove it.', chr(64 + i))); end if;
    if char_length(v_opts[i]) > 300 then perform public._err('VALIDATION', format('Option %s must be 300 characters or fewer.', chr(64 + i))); end if;
  end loop;
  if (select count(distinct lower(x)) from unnest(v_opts[1:v_n]) x) <> v_n then perform public._err('VALIDATION', 'Options must all be different.'); end if;
  if v_key !~ '^[A-F]$' or ascii(v_key) - 64 > v_n then
    perform public._err('VALIDATION', format('Choose exactly one correct answer (A–%s).', chr(64 + v_n)));
  end if;
  if v_mc is not null and (v_mc < 0 or v_mc > 100) then perform public._err('VALIDATION', 'Marks for a correct answer must be between 0 and 100.'); end if;
  if v_mi is not null and (v_mi < -100 or v_mi > 0) then perform public._err('VALIDATION', 'Marks for an incorrect answer must be between -100 and 0.'); end if;
  if v_id is not null then
    perform 1 from public.questions where id = v_id for update;
    if not found then perform public._err('QUESTION_NOT_FOUND'); end if;
    update public.questions set question_text = v_text, option_a = v_opts[1], option_b = v_opts[2], option_c = v_opts[3],
      option_d = v_opts[4], option_e = v_opts[5], option_f = v_opts[6],
      image_url = v_img, category = v_cat, marks_correct = v_mc, marks_incorrect = v_mi, is_sample = v_sample
    where id = v_id;
    insert into public.question_keys (question_id, correct_option, explanation) values (v_id, v_key, v_expl)
    on conflict (question_id) do update set correct_option = excluded.correct_option, explanation = excluded.explanation;
  else
    perform pg_advisory_xact_lock(hashtext('brainfreze.questions.order'));
    select count(*) into n from public.questions;
    v_pos := nullif(p->>'position', '')::int;
    if v_pos is null or v_pos < 1 or v_pos > n + 1 then v_pos := n + 1; end if;
    update public.questions set position = position + 1 where position >= v_pos;
    insert into public.questions (position, question_text, option_a, option_b, option_c, option_d, option_e, option_f,
      image_url, category, marks_correct, marks_incorrect, is_sample)
    values (v_pos, v_text, v_opts[1], v_opts[2], v_opts[3], v_opts[4], v_opts[5], v_opts[6], v_img, v_cat, v_mc, v_mi, v_sample)
    returning id into v_id;
    insert into public.question_keys (question_id, correct_option, explanation) values (v_id, v_key, v_expl);
  end if;
  -- Published sets keep their snapshot; only the bank (and drafts) change.
  return jsonb_build_object('id', v_id, 'rescored', 0);
end $$;

-- ===========================================================================
-- Quiz sets: fresh by default, Save & Next, explicit imports
-- ===========================================================================
create or replace function public.create_set(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_section text := upper(btrim(coalesce(p->>'section', ''))); v_name text := public._clean(p->>'name');
begin
  perform public._require_organizer();
  if v_section not in ('UG', 'PG') then perform public._err('VALIDATION', 'Choose the section (UG or PG).'); end if;
  if v_name is null or char_length(v_name) > 80 then perform public._err('VALIDATION', 'Quiz set name is required (max 80 characters).'); end if;
  -- A new set starts with no questions: nothing is taken from the bank or from earlier sets.
  insert into public.quiz_sessions (is_current, section, name, description, self_paced, question_ids)
  values (true, v_section, v_name, public._clean(p->>'description'), true, '{}') returning id into v_id;
  insert into public.quiz_settings (session_id) values (v_id);
  return v_id;
end $$;

-- Name and description always; section, questions and self-registration only while a draft. A draft may be empty.
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

-- The selected draft's question ids (a legacy draft without a list uses the whole bank, in bank order).
create or replace function public._draft_question_ids(s public.quiz_sessions) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(s.question_ids, array(select x.id from public._session_questions(s) x order by x.idx));
$$;

create or replace function public._assert_draft(s public.quiz_sessions) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not s.is_current or s.published_at is not null or s.status <> 'setup' then
    perform public._err('SET_FROZEN', 'Questions can be added only to an unpublished draft set.');
  end if;
end $$;

-- Save & Next: a new question is saved AND added to the selected draft in one transaction.
-- With an id it edits that bank question (the draft's list is unchanged).
create or replace function public.save_set_question(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; v_ids uuid[]; res jsonb; v_id uuid;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if nullif(p->>'id', '') is not null then
    res := public.save_question(p);
    return res || jsonb_build_object('count', cardinality(public._draft_question_ids(s)), 'added', false);
  end if;
  perform public._assert_draft(s);
  v_ids := public._draft_question_ids(s); -- before the insert (a legacy list-less draft would include it otherwise)
  res := public.save_question((p - 'position') - 'id');
  v_id := (res->>'id')::uuid;
  update public.quiz_sessions set question_ids = v_ids || v_id where id = s.id;
  return res || jsonb_build_object('count', cardinality(v_ids) + 1, 'added', true);
end $$;

-- The other sets' questions, to copy into the selected draft (organizer only; includes keys).
-- Published sets show their frozen copy; drafts show their current bank questions.
create or replace function public.previous_set_questions() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_cur uuid;
begin
  perform public._require_organizer();
  v_cur := public._selected_set_id();
  return coalesce((
    select jsonb_agg(x.j order by x.created_at desc) from (
      select s.created_at, jsonb_build_object(
        'set_id', s.id, 'name', s.name, 'section', s.section, 'stage', public._set_stage(s), 'created_at', s.created_at,
        'questions', coalesce((
          select jsonb_agg(jsonb_build_object(
            'question_id', q.id, 'position', q.pos, 'question_text', q.question_text,
            'option_a', q.option_a, 'option_b', q.option_b, 'option_c', q.option_c, 'option_d', q.option_d,
            'option_e', q.option_e, 'option_f', q.option_f, 'option_count', q.option_count,
            'image_url', q.image_url, 'correct_option', q.correct_option, 'explanation', q.explanation,
            'category', b.category, 'source_question_id', b.source_question_id) order by sq.idx)
          from public._session_questions(s) sq
          cross join lateral public._set_question_options(s, sq.id) q
          left join public.questions b on b.id = sq.id), '[]'::jsonb)) as j
      from public.quiz_sessions s
      where s.id is distinct from v_cur and public._session_question_count(s) > 0
    ) x), '[]'::jsonb);
end $$;

-- Copy questions from previous sets into the selected draft. items = [{ set_id, question_id }].
-- Every copy is a new, editable bank question that remembers its original; the original and its set never change.
create or replace function public.import_set_questions(p_items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  s public.quiz_sessions; src public.quiz_sessions; item jsonb; v_set uuid; v_qid uuid; v_ids uuid[]; v_new uuid;
  v_new_ids uuid[] := '{}'; v_skipped integer := 0; v_root uuid; n integer;
  v_text text; v_a text; v_b text; v_c text; v_d text; v_e text; v_f text; v_img text; v_cat text; v_key text; v_expl text;
  v_mc numeric; v_mi numeric; v_sample boolean;
begin
  perform public._require_organizer();
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    perform public._err('VALIDATION', 'Choose at least one question to import.');
  end if;
  if jsonb_array_length(p_items) > 1000 then perform public._err('VALIDATION', 'Import at most 1000 questions at a time.'); end if;
  s := public._lock_current_session();
  perform public._assert_draft(s);
  v_ids := public._draft_question_ids(s);
  perform pg_advisory_xact_lock(hashtext('brainfreze.questions.order'));
  for item in select e from jsonb_array_elements(p_items) as x(e) loop
    begin
      v_set := nullif(item->>'set_id', '')::uuid;
      v_qid := nullif(item->>'question_id', '')::uuid;
    exception when others then
      perform public._err('VALIDATION', 'Unknown question.');
    end;
    if v_qid is null or v_set is null then perform public._err('VALIDATION', 'Unknown question.'); end if;
    if v_set = s.id then perform public._err('VALIDATION', 'Choose questions from another set.'); end if;
    select * into src from public.quiz_sessions where id = v_set;
    if not found then perform public._err('NO_SESSION', 'That quiz set does not exist.'); end if;
    if not exists (select 1 from public._session_questions(src) sq where sq.id = v_qid) then perform public._err('QUESTION_NOT_IN_QUIZ'); end if;
    -- Duplicates: the question itself, or any copy of the same original, already in this draft.
    v_root := coalesce((select source_question_id from public.questions where id = v_qid), v_qid);
    if v_qid = any (v_ids) or v_root = any (v_ids)
       or exists (select 1 from public.questions x where x.id = any (v_ids) and x.source_question_id in (v_qid, v_root)) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if src.published_at is not null then
      select sq.question_text, sq.option_a, sq.option_b, sq.option_c, sq.option_d, sq.option_e, sq.option_f, sq.image_url, sq.category,
             sq.correct_option, sq.explanation
        into v_text, v_a, v_b, v_c, v_d, v_e, v_f, v_img, v_cat, v_key, v_expl
      from public.set_questions sq where sq.session_id = src.id and sq.question_id = v_qid;
    else
      select q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.option_e, q.option_f, q.image_url, q.category,
             k.correct_option, k.explanation
        into v_text, v_a, v_b, v_c, v_d, v_e, v_f, v_img, v_cat, v_key, v_expl
      from public.questions q left join public.question_keys k on k.question_id = q.id where q.id = v_qid;
    end if;
    -- Per-question marks come from the bank question (a published copy stores the set's resolved marks).
    select q.marks_correct, q.marks_incorrect, q.is_sample into v_mc, v_mi, v_sample from public.questions q where q.id = v_qid;
    select count(*) into n from public.questions;
    insert into public.questions (position, question_text, option_a, option_b, option_c, option_d, option_e, option_f,
      image_url, category, marks_correct, marks_incorrect, is_sample, source_question_id)
    values (n + 1, v_text, v_a, v_b, v_c, v_d, v_e, v_f, v_img, v_cat, v_mc, v_mi, coalesce(v_sample, false), v_root)
    returning id into v_new;
    if v_key is not null then
      insert into public.question_keys (question_id, correct_option, explanation) values (v_new, v_key, v_expl);
    end if;
    v_ids := v_ids || v_new;
    v_new_ids := v_new_ids || v_new;
  end loop;
  update public.quiz_sessions set question_ids = v_ids where id = s.id;
  return jsonb_build_object('imported', cardinality(v_new_ids), 'skipped', v_skipped, 'ids', to_jsonb(v_new_ids), 'count', cardinality(v_ids));
end $$;

-- Validate, freeze (snapshot, all options) and open for joining — one transaction.
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
  if exists (select 1 from public._session_questions(s) sq join public.questions q on q.id = sq.id join public.question_keys k on k.question_id = q.id
             where ascii(k.correct_option) - 64 > public._option_count(q.option_c, q.option_d, q.option_e, q.option_f)) then
    perform public._err('QUIZ_NOT_READY', 'A question''s answer key is not one of its options.');
  end if;
  delete from public.set_questions where session_id = s.id;
  insert into public.set_questions (session_id, question_id, position, question_text, option_a, option_b, option_c, option_d, option_e, option_f,
    image_url, category, correct_option, explanation, marks_correct, marks_incorrect)
  select s.id, q.id, sq.idx + 1, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.option_e, q.option_f, q.image_url, q.category,
         k.correct_option, k.explanation, coalesce(q.marks_correct, st.marks_correct), coalesce(q.marks_incorrect, st.marks_incorrect)
  from public._session_questions(s) sq join public.questions q on q.id = sq.id join public.question_keys k on k.question_id = q.id;
  update public.quiz_sessions set published_at = now(), published_by = auth.uid(), self_paced = true,
    question_ids = (select array_agg(question_id order by position) from public.set_questions where session_id = s.id)
  where id = s.id;
  c := public._issue_join_code(s.id);
  update public.quiz_sessions set registration_open = true where id = s.id;
  return jsonb_build_object('ok', true, 'join_code', c);
end $$;

-- "Go live": participants may now press Start. Participants join themselves, so no pre-selected teams are needed.
create or replace function public.start_quiz() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions;
begin
  perform public._require_organizer();
  s := public._lock_current_session();
  if s.status <> 'setup' then perform public._err('INVALID_STATE', 'The set is already live or completed.'); end if;
  if s.published_at is null then perform public._err('NOT_PUBLISHED', 'Publish the set before going live.'); end if;
  perform public._settings(s.id);
  update public.quiz_sessions set status = 'running', started_at = now(), timer_started_at = now(), elapsed_ms = 0,
    current_index = 0, projector_view = 'question', paused_at = null
  where id = s.id;
  return jsonb_build_object('ok', true, 'server_now', now());
end $$;

-- Explicit, audited change to a PUBLISHED set's key or marks; the key must be one of the question's options.
create or replace function public.correct_set_question(p_question_id uuid, p jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; old public.set_questions; v_key text; v_mc numeric; v_mi numeric; n integer; v_n integer;
begin
  perform public._require_organizer();
  if public._clean(p_reason) is null then perform public._err('REASON_REQUIRED'); end if;
  s := public._lock_current_session();
  if s.published_at is null then perform public._err('INVALID_STATE', 'Edit draft questions in the question bank.'); end if;
  if s.status = 'finalized' then perform public._err('RESULTS_FINALIZED'); end if;
  select * into old from public.set_questions where session_id = s.id and question_id = p_question_id for update;
  if not found then perform public._err('QUESTION_NOT_IN_QUIZ'); end if;
  v_n := public._option_count(old.option_c, old.option_d, old.option_e, old.option_f);
  v_key := upper(btrim(coalesce(p->>'correct_option', old.correct_option)));
  v_mc := coalesce(nullif(p->>'marks_correct', '')::numeric, old.marks_correct);
  v_mi := coalesce(nullif(p->>'marks_incorrect', '')::numeric, old.marks_incorrect);
  if v_key !~ '^[A-F]$' or ascii(v_key) - 64 > v_n or v_mc < 0 or v_mc > 100 or v_mi > 0 or v_mi < -100 then
    perform public._err('VALIDATION', format('Key must be A–%s; correct marks 0–100; incorrect marks −100–0.', chr(64 + v_n)));
  end if;
  if v_key = old.correct_option and v_mc = old.marks_correct and v_mi = old.marks_incorrect then perform public._err('NO_CHANGE'); end if;
  update public.set_questions set correct_option = v_key, marks_correct = v_mc, marks_incorrect = v_mi
  where session_id = s.id and question_id = p_question_id;
  insert into public.score_events (session_id, action, question_id, question_position, reason, actor)
  values (s.id, 'key_change', p_question_id, old.position,
    format('Q%s key %s→%s, marks %s/%s→%s/%s: %s', old.position, old.correct_option, v_key, old.marks_correct, old.marks_incorrect, v_mc, v_mi, public._clean(p_reason)),
    auth.uid());
  n := public._rescore_question(s, p_question_id);
  return jsonb_build_object('ok', true, 'rescored', n);
end $$;

-- Organizer paper entry: the option must exist for the question.
create or replace function public.record_answer(
  p_request_id uuid, p_team_id uuid, p_question_id uuid, p_selected text,
  p_correction boolean default false, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.quiz_sessions; st public.quiz_settings; t public.teams; ev public.score_events; a public.quiz_attempts; v_sel text;
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
  v_sel := public._normalize_option(p_selected);
  if v_sel is not null and ascii(v_sel) - 64 > (select x.option_count from public._set_question_options(s, p_question_id) x) then
    perform public._err('INVALID_OPTION', 'That option does not exist for this question.');
  end if;
  a := public._active_attempt(s.id, t.id);
  return public._record(s, st, t, p_question_id, v_sel, p_request_id, p_correction, p_reason, 'organizer',
    a.id, null, s.status = 'running' and public._elapsed_ms(s) < st.duration_seconds::bigint * 1000);
end $$;

-- ===========================================================================
-- Participants
-- ===========================================================================
create or replace function public._team_public(t public.teams) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('team_number', t.team_number, 'team_name', t.team_name,
    'participant_1', t.participant_1, 'participant_2', t.participant_2, 'college_name', t.college_name, 'section', t.section,
    'self_joined', t.join_session_id is not null);
$$;

-- Join a published set with its code and the participant's own details (no pre-registration, list or PIN).
create or replace function public.join_quiz(p_code text, p_full_name text, p_college_name text, p_request_id uuid,
  p_section text default null, p_device_label text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  k text := public._client_key(); s public.quiz_sessions; t public.teams; tok text; v_num integer; v_known boolean := false;
  v_name text := public._clean(p_full_name); v_college text := public._clean(p_college_name);
  v_section text := upper(btrim(coalesce(p_section, '')));
begin
  if public._join_rate_limited(k) then return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED'); end if;
  s := public._quiz_by_code(p_code);
  if s.id is null then
    perform public._log_join_attempt(k, 'code', false);
    return jsonb_build_object('ok', false, 'error', 'INVALID_CODE');
  end if;
  -- The section comes from the code; a client that claims another section is refused.
  if v_section <> '' and v_section <> s.section then
    return jsonb_build_object('ok', false, 'error', 'SECTION_MISMATCH', 'section', s.section);
  end if;
  if p_request_id is null then
    return jsonb_build_object('ok', false, 'error', 'VALIDATION', 'message', 'This join request is incomplete. Reload the page and try again.');
  end if;
  if v_name is null or char_length(v_name) > 80 or v_name !~ '[[:alpha:]]' or v_name ~ '[[:cntrl:]<>]' then
    return jsonb_build_object('ok', false, 'error', 'VALIDATION', 'field', 'full_name', 'message', 'Enter your full name (up to 80 characters).');
  end if;
  if v_college is null or char_length(v_college) > 120 or v_college !~ '[[:alpha:]]' or v_college ~ '[[:cntrl:]<>]' then
    return jsonb_build_object('ok', false, 'error', 'VALIDATION', 'field', 'college_name', 'message', 'Enter your college name (up to 120 characters).');
  end if;
  perform 1 from public.quiz_sessions where id = s.id for update; -- serialize joins of this set
  select * into s from public.quiz_sessions where id = s.id;

  -- 1. The same request retried (e.g. the first answer was lost): the same entry, never a second one.
  select * into t from public.teams where join_session_id = s.id and join_request_id = p_request_id;
  if found then
    if lower(t.participant_1) <> lower(v_name) or lower(coalesce(t.college_name, '')) <> lower(v_college) then
      return jsonb_build_object('ok', false, 'error', 'VALIDATION', 'message', 'This join request was already used with other details. Reload the page and try again.');
    end if;
    v_known := true;
  else
    -- 2. The same person (name + college) already joined this set.
    select * into t from public.teams
    where join_session_id = s.id and lower(participant_1) = lower(v_name) and lower(college_name) = lower(v_college);
    if found then
      if exists (select 1 from public.participant_sessions where session_id = s.id and team_id = t.id and revoked_at is null and expires_at > now()) then
        perform public._log_join_attempt(k, 'register', false);
        return jsonb_build_object('ok', false, 'error', 'ALREADY_JOINED');
      end if;
      -- Released by an organizer (or signed out): continue the same attempt on this device.
      update public.teams set join_request_id = p_request_id where id = t.id returning * into t;
      v_known := true;
    end if;
  end if;

  if v_known then
    if not public._team_selected(s, t.id) then return jsonb_build_object('ok', false, 'error', 'PARTICIPANT_REMOVED'); end if;
  else
    if not s.registration_open then return jsonb_build_object('ok', false, 'error', 'REGISTRATION_CLOSED'); end if;
    perform pg_advisory_xact_lock(hashtext('brainfreze.teams.number.' || s.section));
    select min(n) into v_num from generate_series(1, coalesce((select max(team_number) from public.teams where section = s.section), 0) + 1) n
    where not exists (select 1 from public.teams x where x.section = s.section and x.team_number = n);
    insert into public.teams (section, team_number, team_name, participant_1, participant_2, college_name, self_registered, join_session_id, join_request_id)
    values (s.section, v_num, v_name, v_name, null, v_college, true, s.id, p_request_id) returning * into t;
    insert into public.registration_events (team_id, section, team_number, action, actor_role)
    values (t.id, s.section, v_num, 'create', 'registration');
    update public.quiz_sessions set team_ids = team_ids || t.id where id = s.id;
    select * into s from public.quiz_sessions where id = s.id;
  end if;

  -- One device at a time: any older sign-in of this entry ends here.
  update public.participant_sessions set revoked_at = now(), revoked_reason = 'Replaced by a new join on this device'
  where session_id = s.id and team_id = t.id and revoked_at is null;
  -- One attempt per entry: a retried or resumed join keeps the same attempt (and its timer).
  if (public._active_attempt(s.id, t.id)).id is null then perform public._make_attempt(s, t.id); end if;
  tok := public._open_participant_session(s, t, p_device_label);
  return jsonb_build_object('ok', true, 'token', tok, 'team', public._team_public(t), 'quiz_title', s.name, 'section', s.section,
    'resumed', v_known);
end $$;

-- The participant's attempt: status, server times, and (while running) one question in their own order with ITS OWN
-- options in their own order. Never keys or points.
create or replace function public.participant_state(p_token text, p_position integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  ps public.participant_sessions; s public.quiz_sessions; st public.quiz_settings; t public.teams; a public.quiz_attempts;
  q record; ans public.team_answers; total integer; res jsonb; r record; revoked public.participant_sessions;
  v_pos integer; v_progress jsonb; v_perm text; v_clock timestamptz; v_shown text; v_question jsonb; v_letter text; i integer;
begin
  ps := public._participant_session(p_token);
  if ps.id is null then
    if p_token ~ '^[0-9a-f]{64}$' then
      select * into revoked from public.participant_sessions where token_hash = public._sha256_hex(p_token);
      if revoked.revoked_at is not null then
        return jsonb_build_object('ok', false, 'error', 'SESSION_REVOKED', 'message', revoked.revoked_reason);
      end if;
    end if;
    return jsonb_build_object('ok', false, 'error', 'SESSION_INVALID');
  end if;
  if ps.last_seen_at < now() - interval '10 seconds' then
    update public.participant_sessions set last_seen_at = now() where id = ps.id;
  end if;
  select * into s from public.quiz_sessions where id = ps.session_id;
  select * into t from public.teams where id = ps.team_id;
  perform public._finalize_expired(s);
  a := public._active_attempt(s.id, t.id);
  -- After an organizer reset the participant gets a fresh attempt (new order) on the next check-in.
  if a.id is null and s.status in ('setup', 'running', 'paused') then a := public._make_attempt(s, t.id); end if;
  st := public._settings(s.id);
  total := public._session_question_count(s);
  v_clock := public._clock(s);
  res := jsonb_build_object(
    'ok', true, 'server_now', now(),
    'team', public._team_public(t),
    'quiz', jsonb_build_object('title', s.name, 'description', s.description, 'status', s.status, 'section', s.section,
      'self_paced', true, 'registration_open', s.registration_open, 'total_questions', total,
      'duration_seconds', st.duration_seconds, 'results_revealed', s.results_revealed,
      'marks', jsonb_build_object('correct', st.marks_correct, 'incorrect', st.marks_incorrect, 'unanswered', st.marks_unanswered)),
    'attempt', jsonb_build_object('status', coalesce(a.status, 'none'), 'started_at', a.started_at, 'deadline_at', a.deadline_at,
      'finished_at', a.finished_at, 'paused', s.status = 'paused',
      'remaining_ms', case when a.status = 'in_progress' then greatest(0, floor(extract(epoch from (a.deadline_at - v_clock)) * 1000))::bigint end),
    -- legacy timer shape used by older clients
    'timer', jsonb_build_object('status', s.status, 'elapsed_ms', s.elapsed_ms, 'timer_started_at', s.timer_started_at,
      'duration_seconds', st.duration_seconds));
  if a.status = 'in_progress' and s.status = 'running' and total > 0 then
    select coalesce(jsonb_agg(exists (select 1 from public.team_answers x
             where x.session_id = s.id and x.team_id = t.id and x.question_id = o.qid) order by o.i), '[]'::jsonb)
      into v_progress from unnest(a.question_order) with ordinality as o(qid, i);
    v_pos := p_position;
    if v_pos is null or v_pos < 0 or v_pos >= cardinality(a.question_order) then
      select coalesce(min(x.i - 1), 0) into v_pos from jsonb_array_elements(v_progress) with ordinality as x(v, i) where x.v = 'false'::jsonb;
    end if;
    v_perm := a.option_orders[v_pos + 1];
    select * into q from public._set_question_options(s, a.question_order[v_pos + 1]);
    select * into ans from public.team_answers where session_id = s.id and team_id = t.id and question_id = q.id;
    v_shown := case when ans.selected_option is null then null
                    else coalesce(ans.displayed_option, chr(64 + position(ans.selected_option in v_perm))) end;
    v_question := jsonb_build_object('id', q.id, 'number', v_pos + 1, 'question_text', q.question_text, 'image_url', q.image_url,
      'option_count', length(v_perm));
    for i in 1..length(v_perm) loop
      v_letter := substr(v_perm, i, 1);
      v_question := v_question || jsonb_build_object('option_' || chr(96 + i),
        case v_letter when 'A' then q.option_a when 'B' then q.option_b when 'C' then q.option_c
                      when 'D' then q.option_d when 'E' then q.option_e else q.option_f end);
    end loop;
    res := res || jsonb_build_object(
      'question', v_question,
      'position', v_pos, 'progress', v_progress, 'question_closed', false,
      'my_answer', case when ans.id is null then null
        else jsonb_build_object('selected', v_shown, 'submitted_at', ans.created_at, 'source', ans.source) end);
  end if;
  if s.status = 'finalized' and s.results_revealed then
    select x.rank, x.points into r from public._standings(s.id) x where x.team_id = t.id;
    res := res || jsonb_build_object('result', jsonb_build_object('rank', r.rank, 'points', r.points, 'qualified', t.id = any (s.qualifiers)));
  end if;
  return res;
end $$;

-- p_option is the letter the participant SAW; it is mapped back to the original option for scoring.
-- An answer may be changed until the attempt is submitted or its deadline passes.
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
  -- Idempotent retry: the current answer, only for the participant that made the request.
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
  -- Only the letters this question showed (2–6) are valid.
  if v_shown !~ '^[A-F]$' or ascii(v_shown) - 64 > length(a.option_orders[v_i]) then
    return jsonb_build_object('ok', false, 'error', 'INVALID_OPTION');
  end if;
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
-- Teams: an organizer may edit a self-joined participant (one person, no second participant)
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
  if v_p1 is null or (v_p2 is null and old.join_session_id is null) then
    perform public._err('VALIDATION', 'Both participants are required (teams have exactly two members).');
  end if;
  if char_length(v_p1) > 80 or char_length(coalesce(v_p2, '')) > 80 then perform public._err('VALIDATION', 'Participant names must be 80 characters or fewer.'); end if;
  if v_college is null or char_length(v_college) > 120 then perform public._err('VALIDATION', 'College name is required (max 120 characters).'); end if;
  if old.id is not null and old.section <> v_section
     and (exists (select 1 from public.team_answers where team_id = v_id)
          or exists (select 1 from public.participant_sessions where team_id = v_id and revoked_at is null)
          or old.join_session_id is not null) then
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
    perform public._err('DUPLICATE_TEAM_NUMBER', format('Team number %s is already in use in the %s section (or this participant already joined).', v_num, v_section));
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

-- ===========================================================================
-- Backup restore: also options E–F, question copies and self-joined participants
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
  select x.id, upper(coalesce(x.section, 'UG')), x.team_number, x.team_name, x.participant_1, nullif(btrim(coalesce(x.participant_2, '')), ''), x.college_name,
         coalesce(x.is_demo, false), coalesce(x.self_registered, false), coalesce(x.created_at, now())
  from jsonb_to_recordset(p->'teams') as x(id uuid, section text, team_number int, team_name text, participant_1 text, participant_2 text,
       college_name text, is_demo boolean, self_registered boolean, created_at timestamptz);
  update public.team_credentials c set pin = x.pin
  from jsonb_to_recordset(coalesce(p->'team_credentials', '[]'::jsonb)) as x(team_id uuid, pin text)
  where c.team_id = x.team_id and x.pin ~ '^[A-HJ-NP-Z2-9]{6}$';

  insert into public.questions (id, position, question_text, option_a, option_b, option_c, option_d, option_e, option_f, image_url, category,
    marks_correct, marks_incorrect, is_sample, created_at)
  select x.id, row_number() over (order by x.position), x.question_text, x.option_a, x.option_b, nullif(x.option_c, ''), nullif(x.option_d, ''),
         nullif(x.option_e, ''), nullif(x.option_f, ''), x.image_url, x.category,
         x.marks_correct, x.marks_incorrect, coalesce(x.is_sample, false), coalesce(x.created_at, now())
  from jsonb_to_recordset(p->'questions') as x(id uuid, position int, question_text text, option_a text, option_b text, option_c text, option_d text,
       option_e text, option_f text, image_url text, category text, marks_correct numeric, marks_incorrect numeric, is_sample boolean, created_at timestamptz);
  update public.questions q set source_question_id = x.source_question_id
  from jsonb_to_recordset(p->'questions') as x(id uuid, source_question_id uuid)
  where q.id = x.id and x.source_question_id is not null and exists (select 1 from public.questions y where y.id = x.source_question_id);
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
    insert into public.set_questions (session_id, question_id, position, question_text, option_a, option_b, option_c, option_d, option_e, option_f,
      image_url, category, correct_option, explanation, marks_correct, marks_incorrect)
    select v_sid, x.question_id, x.position, x.question_text, x.option_a, x.option_b, nullif(x.option_c, ''), nullif(x.option_d, ''),
           nullif(x.option_e, ''), nullif(x.option_f, ''), x.image_url, x.category,
           upper(x.correct_option), x.explanation, x.marks_correct, x.marks_incorrect
    from jsonb_to_recordset(coalesce(item->'set_questions', '[]'::jsonb)) as x(question_id uuid, position int, question_text text,
         option_a text, option_b text, option_c text, option_d text, option_e text, option_f text, image_url text, category text,
         correct_option text, explanation text, marks_correct numeric, marks_incorrect numeric)
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

  -- Self-joined participants keep the set they joined (and their join request id, so a retry stays one entry).
  update public.teams t set join_session_id = x.join_session_id, join_request_id = x.join_request_id
  from jsonb_to_recordset(p->'teams') as x(id uuid, join_session_id uuid, join_request_id uuid)
  where t.id = x.id and x.join_session_id = any (v_ids);

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
-- Function permissions (complete set; the newest migration always re-applies it)
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

-- Organizer RPCs (each checks organizer membership internally). As migration 16, plus fresh-set question tools.
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
  public.set_set_teams(uuid, uuid[], text),
  public.save_set_question(jsonb), public.import_set_questions(jsonb), public.previous_set_questions()
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

-- Round 3 organizer RPCs (migrations 13 and 14; the app no longer calls them, kept as before).
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

-- Participant RPCs (anon and authenticated): join with a code and one's own details, then the device token.
-- join_roster, join_registered_team, join_team, register_team and the registration desk RPCs are retired (not granted).
grant execute on function
  public.join_lookup(text), public.join_quiz(text, text, text, uuid, text, text),
  public.participant_state(text, integer), public.participant_start(text), public.participant_submit(text, uuid, uuid, text),
  public.participant_finish(text), public.participant_leave(text)
to anon, authenticated;

-- Self-check: Round 2 functions callable, nothing organizer-only callable by anon, no internal helper exposed,
-- retired participant / registration functions callable by nobody.
do $$
declare bad text;
begin
  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'r2s\_%' and not has_function_privilege('authenticated', p.oid, 'execute');
  if bad is not null then raise exception 'Permission check failed: authenticated cannot execute %', bad; end if;
  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and (p.proname like 'r2s\_%' or p.proname like 'r3s\_%' or p.proname like 'r2\_%'
    or p.proname in ('get_standings', 'publish_quiz', 'record_answer', 'restore_backup', 'save_set_question', 'import_set_questions', 'previous_set_questions'))
    and has_function_privilege('anon', p.oid, 'execute');
  if bad is not null then raise exception 'Permission check failed: anon can execute organizer function(s) %', bad; end if;
  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like '\_%' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
  if bad is not null then raise exception 'Permission check failed: internal helper(s) are callable: %', bad; end if;
  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('join_roster', 'join_registered_team', 'join_team', 'register_team',
    'registration_access', 'is_registration_staff', 'reg_overview', 'reg_save_team')
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
  if bad is not null then raise exception 'Permission check failed: retired function(s) still callable: %', bad; end if;
end $$;

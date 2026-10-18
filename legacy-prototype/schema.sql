-- BRAINFREZE COLD START shared state table.
-- Create your organizer user in Supabase Auth before using the deployed app.
create table if not exists public.quiz_state (
  id text primary key check (id = 'cold-start-main'),
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.quiz_state enable row level security;

-- Authenticated organizer accounts only. Do not create public/anon write policies.
drop policy if exists "Organizers can read quiz state" on public.quiz_state;
create policy "Organizers can read quiz state"
  on public.quiz_state for select to authenticated using (true);

drop policy if exists "Organizers can create quiz state" on public.quiz_state;
create policy "Organizers can create quiz state"
  on public.quiz_state for insert to authenticated with check (true);

drop policy if exists "Organizers can update quiz state" on public.quiz_state;
create policy "Organizers can update quiz state"
  on public.quiz_state for update to authenticated using (true) with check (true);

-- Enable realtime updates for the single shared state row.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'quiz_state'
  ) then
    alter publication supabase_realtime add table public.quiz_state;
  end if;
end $$;

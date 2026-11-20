-- Миграция 2: личная цель часов в неделю (с историей).
-- Supabase → SQL Editor → New query → вставить всё → Run (один раз, после migration.sql)

-- цель действует с недели week_start (понедельник) и до следующей записи
create table public.goals (
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  week_start date not null check (extract(isodow from week_start) = 1),
  hours      int  not null check (hours between 1 and 168),
  primary key (user_id, week_start)
);

alter table public.goals enable row level security;

create policy "goals read"   on public.goals for select to authenticated using (true);
create policy "goals insert" on public.goals for insert to authenticated with check (user_id = auth.uid());
create policy "goals update" on public.goals for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "goals delete" on public.goals for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on public.goals to authenticated;

alter publication supabase_realtime add table public.goals;

-- Миграция 1: пауза, таймер, флажки.
-- Supabase → SQL Editor → New query → вставить всё → Run (один раз, после schema.sql)

-- ============ ТЕКУЩИЙ ЗАХОД (секундомер/таймер, может быть на паузе) ============

create table public.timers (
  user_id          uuid primary key default auth.uid() references public.profiles(id) on delete cascade,
  mode             text not null default 'stopwatch' check (mode in ('stopwatch', 'timer')),
  target_seconds   int check (target_seconds is null or target_seconds > 0),
  block_started_at timestamptz not null default now()
);

-- ============ ФЛАЖКИ ============

create table public.laps (
  id              bigint generated always as identity primary key,
  user_id         uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  at              timestamptz not null default now(),
  elapsed_seconds int not null default 0,
  note            text
);
create index laps_user_at on public.laps(user_id, at);

-- ============ RLS ============

alter table public.timers enable row level security;
alter table public.laps   enable row level security;

create policy "timers read"   on public.timers for select to authenticated using (true);
create policy "timers insert" on public.timers for insert to authenticated with check (user_id = auth.uid());
create policy "timers update" on public.timers for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "timers delete" on public.timers for delete to authenticated using (user_id = auth.uid());

create policy "laps read"     on public.laps for select to authenticated using (true);
create policy "laps insert"   on public.laps for insert to authenticated with check (user_id = auth.uid());
create policy "laps update"   on public.laps for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "laps delete"   on public.laps for delete to authenticated using (user_id = auth.uid());

grant select, insert, update, delete on public.timers, public.laps to authenticated;

-- если секундомер шёл до миграции — превратить его в заход
insert into public.timers (user_id, block_started_at)
select user_id, started_at from public.sessions where ended_at is null
on conflict do nothing;

-- ============ ФУНКЦИИ ============

drop function if exists public.start_timer();

-- старт нового захода или продолжение после паузы
create function public.start_timer(p_mode text default 'stopwatch', p_target int default null)
returns void language plpgsql as $$
begin
  insert into public.timers (user_id, mode, target_seconds)
  values (auth.uid(), p_mode, case when p_mode = 'timer' then p_target end)
  on conflict (user_id) do nothing;
  insert into public.sessions (user_id) values (auth.uid()) on conflict do nothing;
end;
$$;

-- пауза; p_at — момент, когда таймер дошёл до нуля (не позже now())
create function public.pause_timer(p_at timestamptz default null)
returns void language sql as $$
  update public.sessions
     set ended_at = greatest(started_at, least(now(), coalesce(p_at, now())))
   where user_id = auth.uid() and ended_at is null;
$$;

-- сброс: закрыть сессию и завершить заход (наработанное время остаётся)
create function public.finish_timer()
returns void language sql as $$
  update public.sessions set ended_at = now() where user_id = auth.uid() and ended_at is null;
  delete from public.timers where user_id = auth.uid();
$$;

revoke execute on function public.start_timer(text, int), public.pause_timer(timestamptz), public.finish_timer() from public, anon;
grant  execute on function public.start_timer(text, int), public.pause_timer(timestamptz), public.finish_timer() to authenticated;

-- ============ REALTIME ============

alter publication supabase_realtime add table public.timers, public.laps;

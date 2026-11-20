-- Выполнить один раз: Supabase → SQL Editor → New query → вставить всё → Run

-- ============ ТАБЛИЦЫ ============

create table public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);

create table public.sessions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at   timestamptz,                      -- null = секундомер сейчас идёт
  check (ended_at is null or ended_at >= started_at)
);

-- у одного человека может идти только один секундомер
create unique index sessions_one_running on public.sessions(user_id) where ended_at is null;
create index sessions_user_started on public.sessions(user_id, started_at);

create table public.reports (
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  day        date not null,
  text       text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- ============ ПРОФИЛЬ СОЗДАЁТСЯ АВТОМАТИЧЕСКИ ПРИ РЕГИСТРАЦИИ ============

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============ RLS: читать всё могут залогиненные, менять — только своё ============

alter table public.profiles enable row level security;
alter table public.sessions enable row level security;
alter table public.reports  enable row level security;

create policy "profiles read"   on public.profiles for select to authenticated using (true);
create policy "profiles update" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "sessions read"   on public.sessions for select to authenticated using (true);
create policy "sessions insert" on public.sessions for insert to authenticated with check (user_id = auth.uid());
create policy "sessions update" on public.sessions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "sessions delete" on public.sessions for delete to authenticated using (user_id = auth.uid());

create policy "reports read"    on public.reports for select to authenticated using (true);
create policy "reports insert"  on public.reports for insert to authenticated with check (user_id = auth.uid());
create policy "reports update"  on public.reports for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "reports delete"  on public.reports for delete to authenticated using (user_id = auth.uid());

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.sessions, public.reports to authenticated;

-- ============ ФУНКЦИИ: старт/стоп по серверному времени ============

create function public.start_timer() returns void language sql as $$
  insert into public.sessions (user_id) values (auth.uid()) on conflict do nothing;
$$;

create function public.stop_timer() returns void language sql as $$
  update public.sessions set ended_at = now() where user_id = auth.uid() and ended_at is null;
$$;

create function public.server_now() returns timestamptz language sql stable as $$
  select now();
$$;

revoke execute on function public.start_timer(), public.stop_timer(), public.server_now() from public, anon;
grant  execute on function public.start_timer(), public.stop_timer(), public.server_now() to authenticated;

-- ============ REALTIME ============

alter publication supabase_realtime add table public.sessions, public.reports, public.profiles;

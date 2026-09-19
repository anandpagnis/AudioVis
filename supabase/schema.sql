-- AudioVis account/entitlement schema.
--
-- Run this once in the Supabase project's SQL editor (or via `supabase db push`
-- once the CLI is linked to the project). There is no ORM/migration runner in
-- this codebase — this file is the source of truth, applied by hand.
--
-- No billing integration yet — `plan` exists so the app has somewhere to read
-- entitlement from, but nothing writes 'pro' automatically. Grant it by hand:
--   update public.profiles set plan = 'pro' where email = 'someone@example.com';
-- Swap in a real payment provider later by adding columns for it and a
-- server-side writer (a Worker, an Edge Function) — the RLS shape below
-- already assumes writes to `plan` never come from the client, which is what
-- makes that swap additive rather than a rework.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  -- Permanent Pro bypass for the app's own owner/operator, independent of
  -- `plan` — this is also their live-use DJ tool, not just a demo of one.
  -- Flip by hand in the Supabase table editor after the owner's own account
  -- exists; nothing in the app sets this automatically.
  is_owner boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Signed-in users may read only their own row. There is deliberately no
-- insert/update/delete policy for regular users — the only way `plan` or
-- `is_owner` ever changes today is you, by hand, in the table editor (or the
-- SQL editor, per the comment above). This is what stops a visitor from
-- flipping their own `plan` to 'pro' from the browser console.
create policy "profiles: read own row"
  on public.profiles for select
  using (auth.uid() = id);

-- Auto-create a profile row the moment someone signs up, so the app never has
-- to handle "signed in, no profile yet" as a distinct state.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Realtime: lets the client subscribe to its own profile row so the UI flips
-- to Pro the instant you grant it by hand, without the visitor refreshing.
alter publication supabase_realtime add table public.profiles;

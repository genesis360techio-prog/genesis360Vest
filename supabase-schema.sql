-- ============================================================
-- GENESIS360 — SUPABASE SCHEMA
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- 1. PROFILES (extends auth.users)
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  full_name    text not null,
  email        text not null,
  country      text,
  phone        text,
  kyc_status   text default 'pending' check (kyc_status in ('pending','approved','rejected')),
  risk_score   integer default 0 check (risk_score between 0 and 100),
  access_tier  text default 'standard' check (access_tier in ('standard','priority','restricted')),
  created_at   timestamptz default now()
);

-- 2. KYC DOCUMENTS
create table public.kyc_documents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  document_type   text not null check (document_type in ('passport','national_id','drivers_license')),
  file_url        text not null,
  status          text default 'pending' check (status in ('pending','approved','rejected')),
  reviewer_notes  text,
  reviewed_at     timestamptz,
  created_at      timestamptz default now()
);

-- 3. WALLETS
create table public.wallets (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null unique references public.profiles(id) on delete cascade,
  balance_usd      numeric(12,2) default 0.00,
  locked_amount    numeric(12,2) default 0.00,
  total_deposited  numeric(12,2) default 0.00,
  total_withdrawn  numeric(12,2) default 0.00,
  updated_at       timestamptz default now()
);

-- 4. FUNDING CYCLES
create table public.funding_cycles (
  id                  uuid primary key default gen_random_uuid(),
  cycle_name          text not null,
  status              text default 'upcoming' check (status in ('upcoming','open','full','active','completed')),
  total_slots         integer not null,
  filled_slots        integer default 0,
  contribution_amount numeric(12,2) not null,
  duration_months     integer not null,
  start_date          date,
  end_date            date,
  payout_schedule     jsonb,
  created_by          uuid references public.profiles(id),
  created_at          timestamptz default now()
);

-- 5. CYCLE PARTICIPATIONS
create table public.cycle_participations (
  id         uuid primary key default gen_random_uuid(),
  cycle_id   uuid not null references public.funding_cycles(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  amount     numeric(12,2) not null,
  joined_at  timestamptz default now(),
  status     text default 'active' check (status in ('active','completed','withdrawn')),
  unique(cycle_id, user_id)
);

-- 6. TRANSACTIONS
create table public.transactions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  type             text not null check (type in ('deposit','withdrawal','participation','payout')),
  amount           numeric(12,2) not null,
  currency         text default 'USD',
  payment_provider text check (payment_provider in ('stripe','paystack','manual')),
  payment_ref      text,
  status           text default 'pending' check (status in ('pending','confirmed','failed')),
  created_at       timestamptz default now()
);

-- 7. PAYOUTS
create table public.payouts (
  id             uuid primary key default gen_random_uuid(),
  cycle_id       uuid not null references public.funding_cycles(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  amount         numeric(12,2) not null,
  scheduled_date date,
  paid_date      date,
  status         text default 'pending' check (status in ('pending','sent','confirmed')),
  created_at     timestamptz default now()
);

-- 8. NOTIFICATIONS
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  title      text not null,
  message    text not null,
  read       boolean default false,
  created_at timestamptz default now()
);

-- 9. ADMIN USERS
create table public.admin_users (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  role    text default 'manager' check (role in ('super_admin','manager'))
);

-- ============================================================
-- AUTO-CREATE PROFILE + WALLET ON SIGNUP
-- ============================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.email
  );
  insert into public.wallets (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- ATOMIC SLOT JOIN (prevents over-subscription)
-- ============================================================
create or replace function public.join_cycle(p_cycle_id uuid, p_user_id uuid)
returns jsonb language plpgsql security definer as $$
declare
  v_cycle funding_cycles;
  v_wallet wallets;
begin
  select * into v_cycle from funding_cycles where id = p_cycle_id for update;
  if v_cycle.status != 'open' then
    return jsonb_build_object('success', false, 'error', 'Cycle is not open');
  end if;
  if v_cycle.filled_slots >= v_cycle.total_slots then
    return jsonb_build_object('success', false, 'error', 'Cycle is full');
  end if;
  select * into v_wallet from wallets where user_id = p_user_id for update;
  if v_wallet.balance_usd < v_cycle.contribution_amount then
    return jsonb_build_object('success', false, 'error', 'Insufficient wallet balance');
  end if;
  -- Deduct wallet, lock amount
  update wallets set
    balance_usd   = balance_usd - v_cycle.contribution_amount,
    locked_amount = locked_amount + v_cycle.contribution_amount
  where user_id = p_user_id;
  -- Record participation
  insert into cycle_participations (cycle_id, user_id, amount)
  values (p_cycle_id, p_user_id, v_cycle.contribution_amount);
  -- Increment filled slots
  update funding_cycles set
    filled_slots = filled_slots + 1,
    status = case when filled_slots + 1 >= total_slots then 'full' else status end
  where id = p_cycle_id;
  -- Log transaction
  insert into transactions (user_id, type, amount, status)
  values (p_user_id, 'participation', v_cycle.contribution_amount, 'confirmed');
  return jsonb_build_object('success', true);
end;
$$;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.profiles           enable row level security;
alter table public.kyc_documents      enable row level security;
alter table public.wallets            enable row level security;
alter table public.funding_cycles     enable row level security;
alter table public.cycle_participations enable row level security;
alter table public.transactions       enable row level security;
alter table public.payouts            enable row level security;
alter table public.notifications      enable row level security;
alter table public.admin_users        enable row level security;

-- Profiles: users see only their own
create policy "users_own_profile" on public.profiles for all using (auth.uid() = id);

-- KYC: users see only their own
create policy "users_own_kyc" on public.kyc_documents for all using (auth.uid() = user_id);

-- Wallets: users see only their own
create policy "users_own_wallet" on public.wallets for all using (auth.uid() = user_id);

-- Cycles: everyone can read (for public display)
create policy "cycles_public_read" on public.funding_cycles for select using (true);

-- Participations: users see only their own
create policy "users_own_participations" on public.cycle_participations for all using (auth.uid() = user_id);

-- Transactions: users see only their own
create policy "users_own_transactions" on public.transactions for all using (auth.uid() = user_id);

-- Payouts: users see only their own
create policy "users_own_payouts" on public.payouts for all using (auth.uid() = user_id);

-- Notifications: users see only their own
create policy "users_own_notifications" on public.notifications for all using (auth.uid() = user_id);

-- Admin: only admins can read admin_users table
create policy "admins_only" on public.admin_users for all
  using (exists (select 1 from public.admin_users where user_id = auth.uid()));

-- ============================================================
-- STORAGE BUCKET FOR KYC DOCS
-- Run separately in Storage tab or via this SQL:
-- ============================================================
-- insert into storage.buckets (id, name, public) values ('kyc-documents', 'kyc-documents', false);
-- create policy "users_upload_own_kyc" on storage.objects for insert
--   with check (bucket_id = 'kyc-documents' and auth.uid()::text = (storage.foldername(name))[1]);
-- create policy "users_read_own_kyc" on storage.objects for select
--   using (bucket_id = 'kyc-documents' and auth.uid()::text = (storage.foldername(name))[1]);

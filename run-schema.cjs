const https = require('https')

const PAT     = 'sbp_45e1626f6761e5392683952beed4603894b05681'
const REF     = 'ojtkdylsgszzhkiglbrw'
const BASE    = 'api.supabase.com'

function query(sql) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: sql })
    const req = https.request({
      hostname: BASE,
      path: `/v1/projects/${REF}/database/query`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PAT}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = ''
      res.on('data', d => data += d)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, body: data }) }
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}

async function run() {
  console.log('Running Genesis360 schema on Supabase...\n')

  const statements = [
    // Profiles
    `create table if not exists public.profiles (
      id           uuid primary key references auth.users(id) on delete cascade,
      full_name    text not null default '',
      email        text not null default '',
      country      text,
      phone        text,
      kyc_status   text default 'pending' check (kyc_status in ('pending','approved','rejected')),
      risk_score   integer default 0 check (risk_score between 0 and 100),
      access_tier  text default 'standard' check (access_tier in ('standard','priority','restricted')),
      created_at   timestamptz default now()
    )`,

    // KYC Documents
    `create table if not exists public.kyc_documents (
      id              uuid primary key default gen_random_uuid(),
      user_id         uuid not null references public.profiles(id) on delete cascade,
      document_type   text not null check (document_type in ('passport','national_id','drivers_license')),
      file_url        text not null,
      status          text default 'pending' check (status in ('pending','approved','rejected')),
      reviewer_notes  text,
      reviewed_at     timestamptz,
      created_at      timestamptz default now()
    )`,

    // Wallets
    `create table if not exists public.wallets (
      id               uuid primary key default gen_random_uuid(),
      user_id          uuid not null unique references public.profiles(id) on delete cascade,
      balance_usd      numeric(12,2) default 0.00,
      locked_amount    numeric(12,2) default 0.00,
      total_deposited  numeric(12,2) default 0.00,
      total_withdrawn  numeric(12,2) default 0.00,
      updated_at       timestamptz default now()
    )`,

    // Funding Cycles
    `create table if not exists public.funding_cycles (
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
    )`,

    // Cycle Participations
    `create table if not exists public.cycle_participations (
      id         uuid primary key default gen_random_uuid(),
      cycle_id   uuid not null references public.funding_cycles(id) on delete cascade,
      user_id    uuid not null references public.profiles(id) on delete cascade,
      amount     numeric(12,2) not null,
      joined_at  timestamptz default now(),
      status     text default 'active' check (status in ('active','completed','withdrawn')),
      unique(cycle_id, user_id)
    )`,

    // Transactions
    `create table if not exists public.transactions (
      id               uuid primary key default gen_random_uuid(),
      user_id          uuid not null references public.profiles(id) on delete cascade,
      type             text not null check (type in ('deposit','withdrawal','participation','payout')),
      amount           numeric(12,2) not null,
      currency         text default 'USD',
      payment_provider text check (payment_provider in ('stripe','paystack','manual')),
      payment_ref      text,
      status           text default 'pending' check (status in ('pending','confirmed','failed')),
      created_at       timestamptz default now()
    )`,

    // Payouts
    `create table if not exists public.payouts (
      id             uuid primary key default gen_random_uuid(),
      cycle_id       uuid not null references public.funding_cycles(id) on delete cascade,
      user_id        uuid not null references public.profiles(id) on delete cascade,
      amount         numeric(12,2) not null,
      scheduled_date date,
      paid_date      date,
      status         text default 'pending' check (status in ('pending','sent','confirmed')),
      created_at     timestamptz default now()
    )`,

    // Notifications
    `create table if not exists public.notifications (
      id         uuid primary key default gen_random_uuid(),
      user_id    uuid not null references public.profiles(id) on delete cascade,
      title      text not null,
      message    text not null,
      read       boolean default false,
      created_at timestamptz default now()
    )`,

    // Admin Users
    `create table if not exists public.admin_users (
      id      uuid primary key default gen_random_uuid(),
      user_id uuid not null unique references public.profiles(id) on delete cascade,
      role    text default 'manager' check (role in ('super_admin','manager'))
    )`,

    // Auto-create profile + wallet trigger function
    `create or replace function public.handle_new_user()
    returns trigger language plpgsql security definer as $$
    begin
      insert into public.profiles (id, full_name, email)
      values (new.id, coalesce(new.raw_user_meta_data->>'full_name',''), new.email)
      on conflict (id) do nothing;
      insert into public.wallets (user_id) values (new.id)
      on conflict (user_id) do nothing;
      return new;
    end;
    $$`,

    // Drop trigger if exists then recreate
    `drop trigger if exists on_auth_user_created on auth.users`,
    `create trigger on_auth_user_created
      after insert on auth.users
      for each row execute procedure public.handle_new_user()`,

    // Atomic join_cycle function
    `create or replace function public.join_cycle(p_cycle_id uuid, p_user_id uuid)
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
      update wallets set
        balance_usd   = balance_usd - v_cycle.contribution_amount,
        locked_amount = locked_amount + v_cycle.contribution_amount
      where user_id = p_user_id;
      insert into cycle_participations (cycle_id, user_id, amount)
      values (p_cycle_id, p_user_id, v_cycle.contribution_amount);
      update funding_cycles set
        filled_slots = filled_slots + 1,
        status = case when filled_slots + 1 >= total_slots then 'full' else status end
      where id = p_cycle_id;
      insert into transactions (user_id, type, amount, status)
      values (p_user_id, 'participation', v_cycle.contribution_amount, 'confirmed');
      return jsonb_build_object('success', true);
    end;
    $$`,

    // RLS
    `alter table public.profiles            enable row level security`,
    `alter table public.kyc_documents       enable row level security`,
    `alter table public.wallets             enable row level security`,
    `alter table public.funding_cycles      enable row level security`,
    `alter table public.cycle_participations enable row level security`,
    `alter table public.transactions        enable row level security`,
    `alter table public.payouts             enable row level security`,
    `alter table public.notifications       enable row level security`,
    `alter table public.admin_users         enable row level security`,

    // Policies
    `do $$ begin
      create policy "users_own_profile" on public.profiles for all using (auth.uid() = id);
    exception when duplicate_object then null; end $$`,

    `do $$ begin
      create policy "users_own_kyc" on public.kyc_documents for all using (auth.uid() = user_id);
    exception when duplicate_object then null; end $$`,

    `do $$ begin
      create policy "users_own_wallet" on public.wallets for all using (auth.uid() = user_id);
    exception when duplicate_object then null; end $$`,

    `do $$ begin
      create policy "cycles_public_read" on public.funding_cycles for select using (true);
    exception when duplicate_object then null; end $$`,

    `do $$ begin
      create policy "users_own_participations" on public.cycle_participations for all using (auth.uid() = user_id);
    exception when duplicate_object then null; end $$`,

    `do $$ begin
      create policy "users_own_transactions" on public.transactions for all using (auth.uid() = user_id);
    exception when duplicate_object then null; end $$`,

    `do $$ begin
      create policy "users_own_payouts" on public.payouts for all using (auth.uid() = user_id);
    exception when duplicate_object then null; end $$`,

    `do $$ begin
      create policy "users_own_notifications" on public.notifications for all using (auth.uid() = user_id);
    exception when duplicate_object then null; end $$`,

    // Storage bucket
    `insert into storage.buckets (id, name, public)
     values ('kyc-documents', 'kyc-documents', false)
     on conflict (id) do nothing`,

    `do $$ begin
      create policy "users_upload_own_kyc" on storage.objects for insert
        with check (bucket_id = 'kyc-documents' and auth.uid()::text = (storage.foldername(name))[1]);
    exception when duplicate_object then null; end $$`,

    `do $$ begin
      create policy "users_read_own_kyc" on storage.objects for select
        using (bucket_id = 'kyc-documents' and auth.uid()::text = (storage.foldername(name))[1]);
    exception when duplicate_object then null; end $$`,
  ]

  let ok = 0, failed = 0
  for (const sql of statements) {
    const label = sql.trim().slice(0, 60).replace(/\s+/g, ' ')
    try {
      const res = await query(sql)
      if (res.status === 200 || res.status === 201) {
        console.log(`✓ ${label}`)
        ok++
      } else {
        const msg = res.body?.message || res.body?.error || JSON.stringify(res.body)
        if (msg && msg.includes('already exists')) {
          console.log(`  (exists) ${label}`)
          ok++
        } else {
          console.log(`✗ ${label}\n  → ${msg}`)
          failed++
        }
      }
    } catch (e) {
      console.log(`✗ ${label}\n  → ${e.message}`)
      failed++
    }
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Done: ${ok} succeeded, ${failed} failed`)
  if (failed === 0) console.log('✅ Genesis360 database is fully set up!')
}

run()

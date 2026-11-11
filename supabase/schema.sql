-- Lướt sóng CK — schema Supabase
-- Chạy toàn bộ file này một lần trong Supabase Dashboard → SQL Editor.
-- Chạy lại an toàn (idempotent).

-- ============ Bảng ============

-- Hồ sơ người dùng + cài đặt cảnh báo (1 dòng / tài khoản, tạo tự động khi đăng ký)
create table if not exists public.profiles (
  user_id               uuid primary key references auth.users (id) on delete cascade,
  email                 text,
  notify_email          boolean not null default true,
  notify_telegram       boolean not null default true,
  alert_buy             boolean not null default true,   -- mã trong danh mục chuyển sang MUA
  alert_sell            boolean not null default true,   -- chuyển sang BÁN / CHỐT LỜI
  alert_levels          boolean not null default true,   -- tín hiệu đang theo dõi chạm cắt lỗ / mục tiêu
  alert_setup           boolean not null default false,  -- xuất hiện setup "chờ thị trường xác nhận"
  alert_market          boolean not null default true,   -- VN-Index vượt lên / thủng MA50
  telegram_chat_id      bigint unique,
  telegram_link_code    text unique,
  telegram_link_expires timestamptz,
  created_at            timestamptz not null default now()
);

-- Danh mục theo dõi
create table if not exists public.watchlist (
  user_id  uuid not null references auth.users (id) on delete cascade default auth.uid(),
  symbol   text not null check (symbol ~ '^[A-Z0-9]{2,10}$'),
  added_at timestamptz not null default now(),
  primary key (user_id, symbol)
);

-- Ảnh chụp dữ liệu mỗi phiên (cùng cấu trúc window.DATA trong data.js)
create table if not exists public.snapshots (
  date       date primary key,
  data       jsonb not null,
  created_at timestamptz not null default now()
);

-- Theo dõi hiệu quả thực tế của từng tín hiệu
-- kind: 'MUA' = tín hiệu mua; 'CHỜ' = setup mua khi thị trường chưa xác nhận
create table if not exists public.trades (
  id          bigint generated always as identity primary key,
  signal_date date    not null,
  symbol      text    not null,
  kind        text    not null check (kind in ('MUA', 'CHỜ')),
  entry       numeric not null,
  stop        numeric not null,
  target      numeric not null,
  status      text    not null default 'open' check (status in ('open', 'target', 'stop', 'expired')),
  sessions    int     not null default 0,
  last_price  numeric,
  exit_price  numeric,
  exit_date   date,
  ret_pct     numeric,          -- lãi/lỗ % (đã trừ phí 0,3% khi đóng)
  max_ret_pct numeric,          -- lãi tối đa trong quá trình giữ (theo giá cao nhất)
  min_ret_pct numeric,          -- lỗ tối đa trong quá trình giữ (theo giá thấp nhất)
  updated_at  timestamptz not null default now(),
  unique (signal_date, symbol, kind)
);
create index if not exists trades_status_idx on public.trades (status);
create index if not exists trades_symbol_idx on public.trades (symbol);

-- Nhật ký cảnh báo đã gửi (tránh gửi trùng khi chạy lại)
create table if not exists public.alert_log (
  user_id  uuid not null references auth.users (id) on delete cascade,
  date     date not null,
  channels text[] not null default '{}',
  body     text,
  sent_at  timestamptz not null default now(),
  primary key (user_id, date)
);

-- ============ Tạo hồ sơ khi đăng ký ============

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email on auth.users
  for each row execute function public.handle_new_user();

-- Tạo hồ sơ cho tài khoản đã có trước khi chạy schema
insert into public.profiles (user_id, email)
select id, email from auth.users
on conflict (user_id) do nothing;

-- ============ Bảo mật theo dòng (RLS) ============

alter table public.profiles  enable row level security;
alter table public.watchlist enable row level security;
alter table public.snapshots enable row level security;
alter table public.trades    enable row level security;
alter table public.alert_log enable row level security;

-- profiles: chỉ đọc/sửa hồ sơ của chính mình
drop policy if exists "profiles: đọc của mình" on public.profiles;
create policy "profiles: đọc của mình" on public.profiles
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "profiles: sửa của mình" on public.profiles;
create policy "profiles: sửa của mình" on public.profiles
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Người dùng chỉ được đổi các cột cài đặt; email/telegram do hệ thống quản lý
revoke insert, update, delete on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (notify_email, notify_telegram, alert_buy, alert_sell, alert_levels, alert_setup, alert_market)
  on public.profiles to authenticated;

-- watchlist: của ai người nấy xem/thêm/xoá
drop policy if exists "watchlist: đọc của mình" on public.watchlist;
create policy "watchlist: đọc của mình" on public.watchlist
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "watchlist: thêm của mình" on public.watchlist;
create policy "watchlist: thêm của mình" on public.watchlist
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "watchlist: xoá của mình" on public.watchlist;
create policy "watchlist: xoá của mình" on public.watchlist
  for delete to authenticated using ((select auth.uid()) = user_id);
revoke update on public.watchlist from anon, authenticated;

-- snapshots, trades: ai cũng đọc được; chỉ script (service role) được ghi
drop policy if exists "snapshots: công khai" on public.snapshots;
create policy "snapshots: công khai" on public.snapshots for select to anon, authenticated using (true);
drop policy if exists "trades: công khai" on public.trades;
create policy "trades: công khai" on public.trades for select to anon, authenticated using (true);
revoke insert, update, delete on public.snapshots, public.trades from anon, authenticated;

-- alert_log: chỉ xem của mình
drop policy if exists "alert_log: đọc của mình" on public.alert_log;
create policy "alert_log: đọc của mình" on public.alert_log
  for select to authenticated using ((select auth.uid()) = user_id);
revoke insert, update, delete on public.alert_log from anon, authenticated;

-- ============ Liên kết Telegram ============

-- Tạo mã liên kết dùng một lần, hết hạn sau 15 phút
create or replace function public.create_telegram_link()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  code text := replace(gen_random_uuid()::text, '-', '');
begin
  if auth.uid() is null then raise exception 'Chưa đăng nhập'; end if;
  update public.profiles
     set telegram_link_code = code, telegram_link_expires = now() + interval '15 minutes'
   where user_id = auth.uid();
  return code;
end;
$$;

create or replace function public.unlink_telegram()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Chưa đăng nhập'; end if;
  update public.profiles
     set telegram_chat_id = null, telegram_link_code = null, telegram_link_expires = null
   where user_id = auth.uid();
end;
$$;

revoke execute on function public.create_telegram_link() from public, anon;
revoke execute on function public.unlink_telegram() from public, anon;
grant execute on function public.create_telegram_link() to authenticated;
grant execute on function public.unlink_telegram() to authenticated;

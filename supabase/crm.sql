-- SwipeJob 顧客管理（CRM）用テーブル
-- Supabase の SQL Editor に貼り付けて 1 回実行してください。何度実行しても安全です。
-- 既存のテーブル（users / jobs / job_swipes など）は変更しません。
-- 名前はすべて crm_ で始まります。

create table if not exists public.crm_staff (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  name          text not null,
  color         text not null default '#4f46e5',
  role          text not null default 'member' check (role in ('owner', 'member')),
  password_hash text not null,
  created_at    timestamptz not null default now()
);

create table if not exists public.crm_invites (
  token      text primary key,
  role       text not null default 'member' check (role in ('owner', 'member')),
  created_by uuid references public.crm_staff(id) on delete set null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  used_by    uuid references public.crm_staff(id) on delete set null,
  created_at timestamptz not null default now()
);

-- 候補者ごとの現在のステータスと担当者（user_id = users.id）
create table if not exists public.crm_candidates (
  user_id     text primary key,
  status      text not null default 'new',
  assignee_id uuid references public.crm_staff(id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- ステータスが変わった履歴（リードタイム分析用）
create table if not exists public.crm_status_history (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,
  from_status text,
  to_status   text not null,
  staff_id    uuid references public.crm_staff(id) on delete set null,
  changed_at  timestamptz not null default now()
);
create index if not exists crm_status_history_user_idx on public.crm_status_history (user_id, changed_at);

-- 架電・メモの記録
create table if not exists public.crm_activities (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,
  staff_id    uuid references public.crm_staff(id) on delete set null,
  type        text not null check (type in ('call', 'memo')),
  result      text,
  note        text,
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index if not exists crm_activities_user_idx on public.crm_activities (user_id, occurred_at);

-- 外部（publishable キー）からは読めないようにする。管理画面は secret キーで読み書きする。
alter table public.crm_staff          enable row level security;
alter table public.crm_invites        enable row level security;
alter table public.crm_candidates     enable row level security;
alter table public.crm_status_history enable row level security;
alter table public.crm_activities     enable row level security;

-- ───────── 提案求人・選考管理（2026/11 追加） ─────────
-- 候補者ごとの「提案した求人」「スワイプから選考に進める求人」「SwipeJob で応募した求人」
create table if not exists public.crm_candidate_jobs (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,
  source      text not null check (source in ('proposal', 'swipe', 'swipe_apply')),
  job_id      text,              -- jobs.id（求人 ID があるとき）
  company     text,
  title       text,
  pdf_path    text,              -- Storage（crm-job-pdfs）内のパス
  share_token text not null unique,
  stage       text not null default 'proposed',
  note        text,
  staff_id    uuid references public.crm_staff(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, job_id)
);
create index if not exists crm_candidate_jobs_user_idx on public.crm_candidate_jobs (user_id, created_at);
alter table public.crm_candidate_jobs enable row level security;

-- 求人 PDF の置き場所（非公開。共有リンクからだけ見られる）
insert into storage.buckets (id, name, public)
values ('crm-job-pdfs', 'crm-job-pdfs', false)
on conflict (id) do nothing;

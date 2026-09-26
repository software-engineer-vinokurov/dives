create table if not exists garmin_integrations (
  user_id            integer primary key references users(id) on delete cascade,
  email_hash         text not null,
  session_encrypted  text not null,
  token_expires_at   timestamptz,
  status             text not null check (status in ('connected', 'needs_reconnect')),
  connected_at       timestamptz not null default now(),
  last_fetch_at      timestamptz,
  needs_reconnect_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists garmin_login_attempts (
  id             serial primary key,
  user_id        integer not null references users(id) on delete cascade,
  email_hash     text not null,
  attempted_at   timestamptz not null default now()
);

create index if not exists idx_garmin_login_attempts_user
  on garmin_login_attempts (user_id, attempted_at desc);

create index if not exists idx_garmin_login_attempts_email
  on garmin_login_attempts (email_hash, attempted_at desc);

create table if not exists garmin_imports (
  id                   serial primary key,
  user_id              integer not null references users(id) on delete cascade,
  activity_id          text not null,
  activity_started_at  timestamptz,
  summary              jsonb not null default '{}'::jsonb,
  draft_dive           jsonb not null default '{}'::jsonb,
  compiled_profile     jsonb not null,
  original_fit         bytea not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (user_id, activity_id)
);

create index if not exists idx_garmin_imports_user_created
  on garmin_imports (user_id, created_at asc);

alter table dives
  add column if not exists garmin_activity_id text,
  add column if not exists garmin_profile jsonb,
  add column if not exists garmin_original_fit bytea;

create unique index if not exists idx_dives_garmin_activity
  on dives (user_id, garmin_activity_id)
  where garmin_activity_id is not null;

-- Update notification type constraint
alter table notification_queue drop constraint if exists notification_queue_notification_type_check;
alter table notification_queue add constraint notification_queue_notification_type_check 
  check (notification_type in ('new_user_signup', 'dive_backup', 'padi_reconnect', 'garmin_reconnect'));

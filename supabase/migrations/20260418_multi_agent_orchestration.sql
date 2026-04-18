create extension if not exists pgcrypto;
create extension if not exists vector;

create table if not exists public.world_objects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  object_type text not null,
  dimension text not null default 'overworld',
  coords jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(1536) null,
  last_updated_by text null,
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_status (
  agent_id text primary key,
  display_name text not null,
  role text not null,
  vm_name text null,
  status text not null,
  current_job_id uuid null,
  current_task text null,
  last_heartbeat timestamptz not null default now(),
  health numeric null,
  food integer null,
  dimension text null,
  x numeric null,
  y numeric null,
  z numeric null,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  sender text not null,
  message_type text not null,
  content text not null,
  source_chat text not null default 'group_chat',
  direction text not null default 'inbound',
  processing_status text not null default 'new',
  delivery_status text not null default 'skipped',
  delivered_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.jobs_history (
  id uuid primary key default gen_random_uuid(),
  job_id text not null unique,
  assigned_agent text null references public.agent_status(agent_id),
  status text not null,
  kind text not null,
  target text null,
  quantity integer null,
  priority numeric not null default 0,
  task_brief jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  result jsonb null,
  source text not null default 'system',
  release_reason text null,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz null
);

-- Upgrade an existing teammate-schema database in place. `create table if not exists`
-- preserves old tables, so add orchestration columns explicitly and non-destructively.
alter table public.world_objects add column if not exists dimension text not null default 'overworld';

alter table public.agent_status add column if not exists role text not null default 'worker';
alter table public.agent_status add column if not exists vm_name text null;
alter table public.agent_status add column if not exists current_job_id uuid null;
alter table public.agent_status add column if not exists health numeric null;
alter table public.agent_status add column if not exists food integer null;
alter table public.agent_status add column if not exists dimension text null;
alter table public.agent_status add column if not exists x numeric null;
alter table public.agent_status add column if not exists y numeric null;
alter table public.agent_status add column if not exists z numeric null;

alter table public.chat_messages add column if not exists source_chat text not null default 'group_chat';
alter table public.chat_messages add column if not exists direction text not null default 'inbound';
alter table public.chat_messages add column if not exists processing_status text not null default 'new';
alter table public.chat_messages add column if not exists delivery_status text not null default 'skipped';
alter table public.chat_messages add column if not exists delivered_at timestamptz null;

alter table public.jobs_history add column if not exists kind text not null default 'generic';
alter table public.jobs_history add column if not exists target text null;
alter table public.jobs_history add column if not exists quantity integer null;
alter table public.jobs_history add column if not exists priority numeric not null default 0;
alter table public.jobs_history add column if not exists task_brief jsonb not null default '{}'::jsonb;
alter table public.jobs_history add column if not exists source text not null default 'system';
alter table public.jobs_history add column if not exists release_reason text null;
alter table public.jobs_history add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agent_status_current_job_id_fkey'
  ) then
    alter table public.agent_status
      add constraint agent_status_current_job_id_fkey
      foreign key (current_job_id) references public.jobs_history(id) on delete set null;
  end if;
end;
$$;

create table if not exists public.agent_memory (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references public.agent_status(agent_id) on delete cascade,
  memory_type text not null,
  content jsonb not null,
  embedding vector(1536) null,
  created_at timestamptz not null default now()
);

create table if not exists public.stock_targets (
  item_name text primary key,
  target_count integer not null,
  min_count integer not null default 0,
  priority_weight numeric not null default 1
);

create table if not exists public.job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid null references public.jobs_history(id) on delete set null,
  agent_id text null references public.agent_status(agent_id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists world_objects_name_key
  on public.world_objects(name);

create unique index if not exists jobs_history_job_id_key
  on public.jobs_history(job_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_history_assigned_agent_fkey') then
    alter table public.jobs_history
      add constraint jobs_history_assigned_agent_fkey
      foreign key (assigned_agent) references public.agent_status(agent_id);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'agent_memory_agent_id_fkey') then
    alter table public.agent_memory
      add constraint agent_memory_agent_id_fkey
      foreign key (agent_id) references public.agent_status(agent_id) on delete cascade;
  end if;
end;
$$;

create index if not exists world_objects_type_updated_idx
  on public.world_objects(object_type, updated_at desc);

create index if not exists agent_status_last_heartbeat_idx
  on public.agent_status(last_heartbeat);

create index if not exists jobs_history_status_priority_started_idx
  on public.jobs_history(status, priority desc, started_at asc);

create index if not exists jobs_history_assigned_status_idx
  on public.jobs_history(assigned_agent, status);

create index if not exists chat_messages_direction_processing_created_idx
  on public.chat_messages(direction, processing_status, created_at);

create index if not exists chat_messages_delivery_created_idx
  on public.chat_messages(delivery_status, created_at);

create index if not exists agent_memory_agent_created_idx
  on public.agent_memory(agent_id, created_at desc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists world_objects_touch_updated_at on public.world_objects;
create trigger world_objects_touch_updated_at
before update on public.world_objects
for each row execute function public.touch_updated_at();

drop trigger if exists jobs_history_touch_updated_at on public.jobs_history;
create trigger jobs_history_touch_updated_at
before update on public.jobs_history
for each row execute function public.touch_updated_at();

create or replace function public.claim_job_history(
  p_job_id uuid,
  p_agent_id text,
  p_task_brief jsonb
)
returns public.jobs_history
language plpgsql
as $$
declare
  claimed public.jobs_history;
begin
  update public.jobs_history
  set
    status = 'active',
    assigned_agent = p_agent_id,
    task_brief = coalesce(p_task_brief, task_brief),
    release_reason = null
  where id = p_job_id
    and status = 'pending'
    and assigned_agent is null
  returning * into claimed;

  if claimed.id is null then
    raise exception 'job % is not pending or already assigned', p_job_id
      using errcode = 'P0001';
  end if;

  update public.agent_status
  set
    current_job_id = p_job_id,
    current_task = claimed.kind || coalesce(' ' || claimed.target, ''),
    status = 'busy',
    last_heartbeat = now()
  where agent_id = p_agent_id;

  insert into public.job_events(job_id, agent_id, event_type, payload)
  values (p_job_id, p_agent_id, 'assigned', jsonb_build_object('task_brief', p_task_brief));

  return claimed;
end;
$$;

create or replace function public.release_job_history(
  p_job_id uuid,
  p_agent_id text,
  p_release_reason text
)
returns public.jobs_history
language plpgsql
as $$
declare
  released public.jobs_history;
begin
  update public.jobs_history
  set
    status = 'pending',
    assigned_agent = null,
    release_reason = p_release_reason
  where id = p_job_id
    and assigned_agent = p_agent_id
    and status in ('active', 'blocked')
  returning * into released;

  update public.agent_status
  set current_job_id = null, current_task = null, status = 'idle', last_heartbeat = now()
  where agent_id = p_agent_id and current_job_id = p_job_id;

  insert into public.job_events(job_id, agent_id, event_type, payload)
  values (p_job_id, p_agent_id, 'released', jsonb_build_object('reason', p_release_reason));

  return released;
end;
$$;

alter table public.chat_messages replica identity full;
alter table public.jobs_history replica identity full;
alter table public.agent_status replica identity full;
alter table public.job_events replica identity full;
alter table public.world_objects replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.chat_messages;
    alter publication supabase_realtime add table public.jobs_history;
    alter publication supabase_realtime add table public.agent_status;
    alter publication supabase_realtime add table public.job_events;
    alter publication supabase_realtime add table public.world_objects;
  end if;
exception
  when duplicate_object then null;
end;
$$;

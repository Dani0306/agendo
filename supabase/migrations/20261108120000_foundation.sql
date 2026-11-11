-- Agendo foundation: schema, tables, RLS and grants (prompt 001, T03).
-- Touches only schema `agendo`. The exclusion constraint on bookings comes in T10.
--
-- Access model:
--   service_role  full table access; used by server code, bypasses RLS.
--   authenticated read-only, limited by policy to tenants the user belongs to.
--   anon          nothing, not even schema usage.

create schema if not exists agendo;

comment on schema agendo is 'Agendo: WhatsApp booking assistant for small clinics.';

create table agendo.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  business_type text not null,
  timezone text not null,
  language text not null default 'es' check (language in ('es', 'en')),
  currency text not null default 'COP' check (length(currency) = 3),
  monthly_budget_usd numeric(12, 4) check (monthly_budget_usd >= 0),
  receiving_number text not null unique,
  faq jsonb not null default '[]'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on column agendo.tenants.monthly_budget_usd is 'Null until open decision 4 sets a default.';

-- No foreign key to auth.users: the lab project's auth is shared and Agendo stays
-- in its own schema. A row for a user who no longer exists grants nothing.
create table agendo.tenant_members (
  tenant_id uuid not null references agendo.tenants (id) on delete cascade,
  user_id uuid not null,
  role text not null default 'owner' check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create index tenant_members_user_id_idx on agendo.tenant_members (user_id);

-- unique (tenant_id, id) on parents lets children use composite foreign keys, so
-- a row can never point at another tenant's row, even from server code.
create table agendo.services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references agendo.tenants (id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  duration_minutes integer not null check (duration_minutes > 0),
  price numeric(12, 2) not null check (price >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

comment on table agendo.services is 'The only source of prices.';

create table agendo.resources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references agendo.tenants (id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  kind text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

-- Weekly opening hours in the tenant's local time. weekday is ISO: 1 Monday, 7 Sunday.
create table agendo.availability_rules (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  resource_id uuid not null,
  weekday smallint not null check (weekday between 1 and 7),
  opens time not null,
  closes time not null,
  check (opens < closes),
  unique (resource_id, weekday, opens),
  foreign key (tenant_id, resource_id) references agendo.resources (tenant_id, id) on delete cascade
);

create index availability_rules_tenant_resource_idx on agendo.availability_rules (tenant_id, resource_id);

-- A null resource_id closes the whole clinic that day.
create table agendo.availability_exceptions (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references agendo.tenants (id) on delete cascade,
  resource_id uuid,
  closed_date date not null,
  unique nulls not distinct (tenant_id, resource_id, closed_date),
  foreign key (tenant_id, resource_id) references agendo.resources (tenant_id, id) on delete cascade
);

create index availability_exceptions_tenant_resource_idx on agendo.availability_exceptions (tenant_id, resource_id);

create table agendo.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references agendo.tenants (id) on delete cascade,
  phone_hash text not null,
  phone_encrypted text,
  display_name text,
  language text not null default 'es' check (language in ('es', 'en')),
  consent_status text not null default 'pending' check (consent_status in ('pending', 'granted', 'declined')),
  consent_at timestamptz,
  consent_version text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, phone_hash),
  check (consent_status <> 'granted' or (consent_at is not null and consent_version is not null))
);

comment on column agendo.customers.phone_hash is 'HMAC-SHA256 with a secret pepper, for lookups and logs.';
comment on column agendo.customers.phone_encrypted is 'AES-256-GCM, encrypted in app code. Needed to send reminders. Deleted if consent is declined.';

create table agendo.bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  resource_id uuid not null,
  service_id uuid not null,
  customer_id uuid not null,
  during tstzrange not null,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled', 'completed', 'no_show')),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (not isempty(during) and lower_inc(during) and not upper_inc(during)
    and not lower_inf(during) and not upper_inf(during)),
  foreign key (tenant_id, resource_id) references agendo.resources (tenant_id, id),
  foreign key (tenant_id, service_id) references agendo.services (tenant_id, id),
  foreign key (tenant_id, customer_id) references agendo.customers (tenant_id, id) on delete cascade
);

create index bookings_tenant_resource_idx on agendo.bookings (tenant_id, resource_id);
create index bookings_tenant_service_idx on agendo.bookings (tenant_id, service_id);
create index bookings_tenant_customer_idx on agendo.bookings (tenant_id, customer_id);

create table agendo.conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  customer_id uuid not null,
  channel text not null check (channel in ('whatsapp', 'web')),
  status text not null default 'open' check (status in ('open', 'handoff', 'closed')),
  last_customer_message_at timestamptz,
  processing_until timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, customer_id, channel),
  foreign key (tenant_id, customer_id) references agendo.customers (tenant_id, id) on delete cascade
);

comment on column agendo.conversations.processing_until is 'Lease that keeps one worker per conversation. An expired lease can be taken over.';

create table agendo.messages (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  conversation_id uuid not null,
  role text not null check (role in ('customer', 'assistant', 'tool')),
  content text,
  tool_calls jsonb,
  provider_message_id text unique,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, conversation_id) references agendo.conversations (tenant_id, id) on delete cascade
);

comment on column agendo.messages.content is 'Null for customer text received before consent was granted.';
comment on column agendo.messages.provider_message_id is 'Twilio MessageSid. Unique, so a webhook retry cannot be stored twice.';

create index messages_tenant_conversation_idx on agendo.messages (tenant_id, conversation_id, id);
create index messages_unprocessed_idx on agendo.messages (conversation_id, id)
  where role = 'customer' and processed_at is null;

create table agendo.model_calls (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references agendo.tenants (id) on delete cascade,
  conversation_id uuid,
  purpose text not null,
  model text not null,
  chain_step smallint not null default 0 check (chain_step >= 0),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
  cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cost_usd numeric(12, 8) not null default 0 check (cost_usd >= 0),
  latency_ms integer not null check (latency_ms >= 0),
  outcome text not null check (outcome in ('ok', 'error', 'timeout', 'invalid_output')),
  error text,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, conversation_id) references agendo.conversations (tenant_id, id) on delete set null (conversation_id)
);

comment on table agendo.model_calls is 'One row per model call, whatever the outcome. Tokens come from the SDK response.';

create index model_calls_tenant_created_at_idx on agendo.model_calls (tenant_id, created_at);
create index model_calls_tenant_conversation_idx on agendo.model_calls (tenant_id, conversation_id);

create table agendo.tenant_usage (
  tenant_id uuid not null references agendo.tenants (id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  reserved_usd numeric(12, 8) not null default 0 check (reserved_usd >= 0),
  settled_usd numeric(12, 8) not null default 0 check (settled_usd >= 0),
  refunded_usd numeric(12, 8) not null default 0 check (refunded_usd >= 0),
  primary key (tenant_id, month)
);

create table agendo.reminders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  booking_id uuid not null,
  send_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  provider_message_id text,
  template text,
  created_at timestamptz not null default now(),
  unique (booking_id, send_at),
  foreign key (tenant_id, booking_id) references agendo.bookings (tenant_id, id) on delete cascade
);

create index reminders_tenant_booking_idx on agendo.reminders (tenant_id, booking_id);
create index reminders_pending_send_at_idx on agendo.reminders (send_at) where status = 'pending';

-- RLS and read policies.
alter table agendo.tenants enable row level security;
alter table agendo.tenant_members enable row level security;

create policy tenants_member_read on agendo.tenants
  for select to authenticated
  using (id in (select m.tenant_id from agendo.tenant_members m where m.user_id = (select auth.uid())));

-- Only looks at the caller's own rows, so the policies below can read this table
-- without recursion and without a security definer function.
create policy tenant_members_self_read on agendo.tenant_members
  for select to authenticated
  using (user_id = (select auth.uid()));

do $$
declare
  t text;
begin
  foreach t in array array[
    'services', 'resources', 'availability_rules', 'availability_exceptions', 'customers',
    'bookings', 'conversations', 'messages', 'model_calls', 'tenant_usage', 'reminders'
  ]
  loop
    execute format('alter table agendo.%I enable row level security', t);
    execute format(
      'create policy %I on agendo.%I for select to authenticated using (tenant_id in (select m.tenant_id from agendo.tenant_members m where m.user_id = (select auth.uid())))',
      t || '_member_read', t
    );
  end loop;
end
$$;

-- Grants. Writes happen only through server code with the secret key.
grant usage on schema agendo to authenticated, service_role;
grant select, insert, update, delete on all tables in schema agendo to service_role;
grant usage, select on all sequences in schema agendo to service_role;

grant select on
  agendo.tenants, agendo.tenant_members, agendo.services, agendo.resources,
  agendo.availability_rules, agendo.availability_exceptions, agendo.bookings,
  agendo.conversations, agendo.messages, agendo.model_calls, agendo.tenant_usage,
  agendo.reminders
to authenticated;

-- Column grant: signed-in users can never read a phone hash or ciphertext.
-- A dashboard query on customers must name its columns; select * will be refused.
grant select (id, tenant_id, display_name, language, consent_status, consent_at, consent_version, created_at)
  on agendo.customers to authenticated;

-- T15: reminder claiming (prompt 003). Touches only schema `agendo`.
-- The schedule that calls the Edge Function is in the next migration.

alter table agendo.reminders add column error text;

comment on column agendo.reminders.error is 'Provider error code when status is failed. Never holds a phone number.';

-- Finds confirmed WhatsApp bookings that have entered the reminder lead, for customers
-- who consented and still have a stored number, and claims each one by inserting its
-- reminder row. `on conflict do nothing returning` means two overlapping runs get
-- disjoint rows, and a claimed row is never returned again: at most one send.
-- A rescheduled booking has a new start, so a new send_at, so a new reminder.
create function agendo.claim_due_reminders(p_lead interval, p_limit integer)
returns table (reminder_id uuid, starts_at timestamptz, timezone text, phone_encrypted text)
language sql
volatile
security invoker
set search_path = ''
as $$
  with due as (
    select b.tenant_id, b.id as booking_id, lower(b.during) - p_lead as send_at
    from agendo.bookings b
    join agendo.customers c on c.tenant_id = b.tenant_id and c.id = b.customer_id
    where b.status = 'confirmed'
      and lower(b.during) > now()
      and lower(b.during) - p_lead <= now()
      and c.consent_status = 'granted'
      and c.phone_encrypted is not null
      and exists (
        select 1 from agendo.conversations v
        where v.tenant_id = b.tenant_id and v.customer_id = b.customer_id and v.channel = 'whatsapp'
      )
      and not exists (
        select 1 from agendo.reminders r
        where r.booking_id = b.id and r.send_at = lower(b.during) - p_lead
      )
    order by lower(b.during)
    limit p_limit
  ),
  claimed as (
    insert into agendo.reminders (tenant_id, booking_id, send_at, template)
    select tenant_id, booking_id, send_at, 'twilio_sandbox_appointment_reminders' from due
    on conflict (booking_id, send_at) do nothing
    returning id, tenant_id, booking_id
  )
  select r.id, lower(b.during), t.timezone, c.phone_encrypted
  from claimed r
  join agendo.bookings b on b.tenant_id = r.tenant_id and b.id = r.booking_id
  join agendo.tenants t on t.id = r.tenant_id
  join agendo.customers c on c.tenant_id = b.tenant_id and c.id = b.customer_id;
$$;

-- `agendo` is exposed through the API, so only server code may call this.
revoke execute on function agendo.claim_due_reminders(interval, integer) from public, anon, authenticated;
grant execute on function agendo.claim_due_reminders(interval, integer) to service_role;

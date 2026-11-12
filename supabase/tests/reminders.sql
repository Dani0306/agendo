-- Proves reminder claiming (prompt 003, T15). Run as the postgres role after the
-- migrations. Synthetic rows, rolled back at the end. Any failed check stops the script.

begin;

insert into agendo.tenants (id, name, business_type, timezone, receiving_number) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Test A', 'test', 'America/Bogota', 'whatsapp:+10000000001');
insert into agendo.services (id, tenant_id, name, duration_minutes, price) values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', 'aaaaaaaa-0000-4000-8000-000000000001', 'Service', 60, 1000);
insert into agendo.resources (id, tenant_id, name, kind) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'One', 'test');

-- c1 consented on WhatsApp; c2 never consented; c3 is a web visitor with no phone.
insert into agendo.customers (id, tenant_id, phone_hash, phone_encrypted, consent_status, consent_at, consent_version) values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-000000000001', 'h1', 'v1:x:y:z', 'granted', now(), 'v1'),
  ('aaaaaaaa-0000-4000-8000-0000000000c2', 'aaaaaaaa-0000-4000-8000-000000000001', 'h2', 'v1:x:y:z', 'pending', null, null),
  ('aaaaaaaa-0000-4000-8000-0000000000c3', 'aaaaaaaa-0000-4000-8000-000000000001', 'h3', null, 'granted', now(), 'v1');
insert into agendo.conversations (tenant_id, customer_id, channel) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'whatsapp'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c2', 'whatsapp'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c3', 'web');

-- Each booking on its own hour so the exclusion constraint stays out of the way.
insert into agendo.bookings (id, tenant_id, resource_id, service_id, customer_id, during, status)
select id::uuid, 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000a1',
       'aaaaaaaa-0000-4000-8000-0000000000e1', customer::uuid,
       tstzrange(date_trunc('hour', now()) + make_interval(hours => h), date_trunc('hour', now()) + make_interval(hours => h + 1), '[)'),
       status
from (values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c1', 3, 'confirmed'),  -- due
  ('bbbbbbbb-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-0000000000c1', 30, 'confirmed'), -- too far ahead
  ('bbbbbbbb-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-0000000000c1', 4, 'cancelled'),  -- cancelled
  ('bbbbbbbb-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-0000000000c2', 5, 'confirmed'),  -- no consent
  ('bbbbbbbb-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-0000000000c3', 6, 'confirmed'),  -- web, no phone
  ('bbbbbbbb-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-0000000000c1', -2, 'confirmed')  -- already started
) as rows (id, customer, h, status);

do $$
declare
  n integer;
  claimed uuid;
begin
  select count(*), min(reminder_id::text)::uuid into n, claimed from agendo.claim_due_reminders('24 hours', 10);
  if n <> 1 then raise exception 'FAILED: first claim returned % reminders, expected 1', n; end if;
  if (select booking_id from agendo.reminders where id = claimed) <> 'bbbbbbbb-0000-4000-8000-000000000001' then
    raise exception 'FAILED: claimed the wrong booking';
  end if;

  select count(*) into n from agendo.claim_due_reminders('24 hours', 10);
  if n <> 0 then raise exception 'FAILED: a second run claimed % reminders, expected 0', n; end if;

  -- Rescheduling moves send_at, so the booking is due again under a new reminder.
  update agendo.bookings
  set during = tstzrange(date_trunc('hour', now()) + interval '8 hours', date_trunc('hour', now()) + interval '9 hours', '[)')
  where id = 'bbbbbbbb-0000-4000-8000-000000000001';
  select count(*) into n from agendo.claim_due_reminders('24 hours', 10);
  if n <> 1 then raise exception 'FAILED: a rescheduled booking was not claimed again (% rows)', n; end if;
  select count(*) into n from agendo.reminders where booking_id = 'bbbbbbbb-0000-4000-8000-000000000001';
  if n <> 2 then raise exception 'FAILED: expected 2 reminder rows for the rescheduled booking, found %', n; end if;

  -- Signed-in users and anonymous callers can't run it.
  set local role authenticated;
  begin
    perform agendo.claim_due_reminders('24 hours', 10);
    raise exception 'FAILED: authenticated ran claim_due_reminders';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  set local role anon;
  begin
    perform agendo.claim_due_reminders('24 hours', 10);
    raise exception 'FAILED: anon ran claim_due_reminders';
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end
$$;

rollback;

select 'Reminder claiming passed' as result;

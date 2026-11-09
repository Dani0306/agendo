-- Proves the exclusion constraint (prompt 002, T10). Run after the migrations, in the
-- SQL editor or with psql, as the postgres role. Synthetic rows, rolled back at the end.
-- Any failed check stops the script; the last line only runs if all of them passed.

begin;

insert into agendo.tenants (id, name, business_type, timezone, receiving_number) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Test A', 'test', 'America/Bogota', 'whatsapp:+10000000001');

insert into agendo.services (id, tenant_id, name, duration_minutes, price) values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', 'aaaaaaaa-0000-4000-8000-000000000001', 'Service', 60, 1000);

insert into agendo.resources (id, tenant_id, name, kind) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'One', 'test'),
  ('aaaaaaaa-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', 'Two', 'test');

insert into agendo.customers (id, tenant_id, phone_hash) values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-000000000001', 'hash-a');

create temporary table t (tenant_id uuid, resource_id uuid, service_id uuid, customer_id uuid) on commit drop;
insert into t values (
  'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000a1',
  'aaaaaaaa-0000-4000-8000-0000000000e1', 'aaaaaaaa-0000-4000-8000-0000000000c1'
);

insert into agendo.bookings (tenant_id, resource_id, service_id, customer_id, during)
select tenant_id, resource_id, service_id, customer_id, '[2030-01-07 15:00+00,2030-01-07 16:00+00)' from t;

do $$
begin
  -- An overlap on the same resource is refused.
  begin
    insert into agendo.bookings (tenant_id, resource_id, service_id, customer_id, during)
    select tenant_id, resource_id, service_id, customer_id, '[2030-01-07 15:30+00,2030-01-07 16:30+00)' from t;
    raise exception 'FAILED: an overlapping booking was accepted';
  exception when exclusion_violation then
    null;
  end;

  -- Back to back is allowed, because the upper bound is exclusive.
  insert into agendo.bookings (tenant_id, resource_id, service_id, customer_id, during)
  select tenant_id, resource_id, service_id, customer_id, '[2030-01-07 16:00+00,2030-01-07 17:00+00)' from t;

  -- The same time on another resource is allowed.
  insert into agendo.bookings (tenant_id, resource_id, service_id, customer_id, during)
  select tenant_id, 'aaaaaaaa-0000-4000-8000-0000000000a2', service_id, customer_id, '[2030-01-07 15:00+00,2030-01-07 16:00+00)' from t;

  -- Moving a booking onto another one is refused, and leaves it where it was.
  begin
    update agendo.bookings set during = '[2030-01-07 15:30+00,2030-01-07 16:30+00)'
    where during = '[2030-01-07 16:00+00,2030-01-07 17:00+00)';
    raise exception 'FAILED: an overlapping update was accepted';
  exception when exclusion_violation then
    null;
  end;

  -- Cancelling frees the slot.
  update agendo.bookings set status = 'cancelled'
  where resource_id = 'aaaaaaaa-0000-4000-8000-0000000000a1' and during = '[2030-01-07 15:00+00,2030-01-07 16:00+00)';

  insert into agendo.bookings (tenant_id, resource_id, service_id, customer_id, during)
  select tenant_id, resource_id, service_id, customer_id, '[2030-01-07 15:00+00,2030-01-07 16:00+00)' from t;
end
$$;

rollback;

select 'Booking exclusion passed' as result;

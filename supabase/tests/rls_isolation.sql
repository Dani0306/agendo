-- Proves tenant isolation (prompt 001, T03). Run after the migration, in the SQL
-- editor or with psql, as the postgres role. Synthetic fixtures, rolled back at the
-- end, so nothing is left behind. Any failed check stops the script with an error;
-- the last line only runs if all of them passed.

begin;

insert into agendo.tenants (id, name, business_type, timezone, receiving_number) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Test A', 'test', 'America/Bogota', 'whatsapp:+10000000001'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'Test B', 'test', 'America/Bogota', 'whatsapp:+10000000002');

insert into agendo.tenant_members (tenant_id, user_id) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b');

insert into agendo.services (tenant_id, name, duration_minutes, price) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Service A', 30, 1000),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'Service B', 30, 2000);

insert into agendo.resources (id, tenant_id, name, kind) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'Resource A', 'test'),
  ('bbbbbbbb-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000001', 'Resource B', 'test');

insert into agendo.customers (tenant_id, phone_hash, phone_encrypted) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'hash-a', 'cipher-a'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'hash-b', 'cipher-b');

do $$
declare
  n integer;
  seen text;
begin
  -- A composite foreign key refuses a resource from another tenant, even for the owner role.
  begin
    insert into agendo.availability_rules (tenant_id, resource_id, weekday, opens, closes)
    values ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-0000000000b1', 1, '08:00', '09:00');
    raise exception 'FAILED: a row in tenant A pointed at a resource in tenant B';
  exception when foreign_key_violation then
    null;
  end;

  -- Signed in as a member of tenant A.
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-00000000000a","role":"authenticated"}', true);
  set local role authenticated;

  select count(*) into n from agendo.tenants;
  if n <> 1 then raise exception 'FAILED: user A sees % tenants, expected 1', n; end if;

  select name into seen from agendo.services;
  if seen <> 'Service A' then raise exception 'FAILED: user A sees service %', seen; end if;

  select count(*) into n from agendo.customers;
  if n <> 1 then raise exception 'FAILED: user A sees % customers, expected 1', n; end if;

  select count(*) into n from agendo.tenant_members;
  if n <> 1 then raise exception 'FAILED: user A sees % memberships, expected 1', n; end if;

  begin
    perform phone_encrypted from agendo.customers;
    raise exception 'FAILED: user A read phone_encrypted';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform phone_hash from agendo.customers;
    raise exception 'FAILED: user A read phone_hash';
  exception when insufficient_privilege then
    null;
  end;

  begin
    insert into agendo.services (tenant_id, name, duration_minutes, price)
    values ('aaaaaaaa-0000-4000-8000-000000000001', 'Written by user', 30, 1);
    raise exception 'FAILED: user A wrote to services';
  exception when insufficient_privilege then
    null;
  end;

  begin
    update agendo.tenants set name = 'Changed';
    raise exception 'FAILED: user A updated tenants';
  exception when insufficient_privilege then
    null;
  end;

  reset role;

  -- Signed in as a member of tenant B.
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-00000000000b","role":"authenticated"}', true);
  set local role authenticated;

  select name into seen from agendo.services;
  if seen <> 'Service B' then raise exception 'FAILED: user B sees service %', seen; end if;

  reset role;

  -- Signed in, but a member of nothing (for example, a PaperTrail user).
  perform set_config('request.jwt.claims', '{"sub":"cccccccc-0000-4000-8000-00000000000c","role":"authenticated"}', true);
  set local role authenticated;

  select count(*) into n from agendo.tenants;
  if n <> 0 then raise exception 'FAILED: a non-member sees % tenants', n; end if;

  reset role;

  -- Not signed in.
  set local role anon;

  begin
    perform 1 from agendo.tenants;
    raise exception 'FAILED: anon reached agendo.tenants';
  exception when insufficient_privilege then
    null;
  end;

  reset role;
end
$$;

rollback;

select 'RLS isolation passed' as result;

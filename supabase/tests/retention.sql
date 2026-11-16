-- Proves the retention job (prompt 005, T25). Run as the postgres role after the
-- migrations. Synthetic rows, rolled back at the end. Any failed check stops the script.

begin;

insert into agendo.tenants (id, name, business_type, timezone, receiving_number) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Test A', 'test', 'America/Bogota', 'whatsapp:+10000000001');
insert into agendo.services (id, tenant_id, name, duration_minutes, price) values
  ('aaaaaaaa-0000-4000-8000-0000000000e1', 'aaaaaaaa-0000-4000-8000-000000000001', 'Service', 60, 1000);
insert into agendo.resources (id, tenant_id, name, kind) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'One', 'test');

-- c1: old and silent, delete. c2: old but wrote last week, keep. c3: old with a future
-- booking, keep. c4: new, keep.
insert into agendo.customers (id, tenant_id, phone_hash, created_at) values
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-000000000001', 'h1', now() - interval '2 years'),
  ('aaaaaaaa-0000-4000-8000-0000000000c2', 'aaaaaaaa-0000-4000-8000-000000000001', 'h2', now() - interval '2 years'),
  ('aaaaaaaa-0000-4000-8000-0000000000c3', 'aaaaaaaa-0000-4000-8000-000000000001', 'h3', now() - interval '2 years'),
  ('aaaaaaaa-0000-4000-8000-0000000000c4', 'aaaaaaaa-0000-4000-8000-000000000001', 'h4', now());

insert into agendo.conversations (id, tenant_id, customer_id, channel) values
  ('cccccccc-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c1', 'web'),
  ('cccccccc-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000c2', 'web');

insert into agendo.messages (tenant_id, conversation_id, role, content, tool_calls, created_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', 'customer', 'viejo de c1', null, now() - interval '400 days'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000002', 'customer', 'viejo de c2', null, now() - interval '100 days'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000002', 'assistant', 'respuesta vieja', '[{"name":"x","status":"y"}]', now() - interval '100 days'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000002', 'customer', 'reciente de c2', null, now() - interval '7 days');

insert into agendo.bookings (tenant_id, resource_id, service_id, customer_id, during) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-0000000000e1',
   'aaaaaaaa-0000-4000-8000-0000000000c3', tstzrange(now() + interval '3 days', now() + interval '3 days 1 hour', '[)'));

insert into agendo.model_calls (tenant_id, conversation_id, purpose, model, cost_usd, latency_ms, outcome) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', 'agent', 'm', 0.001, 1, 'ok');

do $$
declare
  result record;
  n integer;
begin
  select * into result from agendo.apply_retention();
  if result.customers_deleted <> 1 then raise exception 'FAILED: deleted % customers, expected 1', result.customers_deleted; end if;

  select count(*) into n from agendo.customers where id = 'aaaaaaaa-0000-4000-8000-0000000000c1';
  if n <> 0 then raise exception 'FAILED: the silent customer is still there'; end if;
  select count(*) into n from agendo.customers where tenant_id = 'aaaaaaaa-0000-4000-8000-000000000001';
  if n <> 3 then raise exception 'FAILED: % customers left, expected 3', n; end if;

  -- c2's old messages lost their text; the recent one kept it.
  select count(*) into n from agendo.messages
  where conversation_id = 'cccccccc-0000-4000-8000-000000000002' and content is null and tool_calls is null;
  if n <> 2 then raise exception 'FAILED: % old messages erased, expected 2', n; end if;
  if (select content from agendo.messages where content = 'reciente de c2') is null then
    raise exception 'FAILED: a recent message was erased';
  end if;

  -- The cost row stays, detached from the deleted conversation.
  select count(*) into n from agendo.model_calls where tenant_id = 'aaaaaaaa-0000-4000-8000-000000000001' and conversation_id is null;
  if n <> 1 then raise exception 'FAILED: the cost row was not kept'; end if;

  -- A second run finds nothing more to do.
  select * into result from agendo.apply_retention();
  if result.messages_erased <> 0 or result.customers_deleted <> 0 then raise exception 'FAILED: a second run changed rows'; end if;

  set local role authenticated;
  begin
    perform agendo.apply_retention();
    raise exception 'FAILED: authenticated ran apply_retention';
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end
$$;

rollback;

select 'Retention passed' as result;

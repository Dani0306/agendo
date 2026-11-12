-- Proves the budget functions (prompt 003, T17). Run as the postgres role after the
-- migrations. Synthetic rows, rolled back at the end. Any failed check stops the script.

begin;

insert into agendo.tenants (id, name, business_type, timezone, receiving_number, monthly_budget_usd) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Capped', 'test', 'America/Bogota', 'whatsapp:+10000000001', 1.00),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'Default', 'test', 'America/Bogota', 'whatsapp:+10000000002', null);

do $$
declare
  a constant uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  b constant uuid := 'bbbbbbbb-0000-4000-8000-000000000001';
  v_month date;
  row agendo.tenant_usage;
begin
  v_month := agendo.reserve_budget(a, 0.40, 5);
  if v_month is null then raise exception 'FAILED: a reservation within the limit was refused'; end if;
  if v_month <> (date_trunc('month', now() at time zone 'America/Bogota'))::date then
    raise exception 'FAILED: the month is not the tenant''s local month';
  end if;
  if agendo.reserve_budget(a, 0.40, 5) is null then raise exception 'FAILED: second reservation refused'; end if;

  -- 0.80 held; another 0.40 would pass the 1.00 limit.
  if agendo.reserve_budget(a, 0.40, 5) is not null then raise exception 'FAILED: the limit was exceeded'; end if;

  -- Settling at a lower real cost frees the difference.
  perform agendo.settle_budget(a, v_month, 0.40, 0.10);
  select * into row from agendo.tenant_usage where tenant_id = a and tenant_usage.month = v_month;
  if row.reserved_usd <> 0.40 or row.settled_usd <> 0.10 then
    raise exception 'FAILED: settle left reserved % and settled %', row.reserved_usd, row.settled_usd;
  end if;

  -- A failed call refunds its reservation.
  perform agendo.refund_budget(a, v_month, 0.40);
  select * into row from agendo.tenant_usage where tenant_id = a and tenant_usage.month = v_month;
  if row.reserved_usd <> 0 or row.refunded_usd <> 0.40 then
    raise exception 'FAILED: refund left reserved % and refunded %', row.reserved_usd, row.refunded_usd;
  end if;

  -- 0.10 settled, so 0.90 is left.
  if agendo.reserve_budget(a, 0.90, 5) is null then raise exception 'FAILED: the remaining budget was refused'; end if;
  if agendo.reserve_budget(a, 0.01, 5) is not null then raise exception 'FAILED: spent past the limit'; end if;

  -- A tenant with no limit uses the default passed by the app.
  if agendo.reserve_budget(b, 4.99, 5) is null then raise exception 'FAILED: the default limit was not applied'; end if;
  if agendo.reserve_budget(b, 0.02, 5) is not null then raise exception 'FAILED: the default limit was exceeded'; end if;

  -- A zero budget blocks everything.
  update agendo.tenants set monthly_budget_usd = 0 where id = a;
  if agendo.reserve_budget(a, 0.000001, 5) is not null then raise exception 'FAILED: a zero budget let a call through'; end if;

  -- Spend since a time, counted from model_calls.
  insert into agendo.model_calls (tenant_id, purpose, model, cost_usd, latency_ms, outcome, created_at) values
    (a, 'agent', 'm', 0.002, 1, 'ok', now() - interval '2 days'),
    (a, 'agent', 'm', 0.003, 1, 'ok', now());
  if agendo.model_spend_since(a, now() - interval '1 hour') <> 0.003 then
    raise exception 'FAILED: model_spend_since counted the wrong rows';
  end if;

  -- Only server code may call these.
  set local role authenticated;
  begin
    perform agendo.reserve_budget(a, 0, 5);
    raise exception 'FAILED: authenticated ran reserve_budget';
  exception when insufficient_privilege then
    null;
  end;
  reset role;

  set local role anon;
  begin
    perform agendo.model_spend_since(a, now());
    raise exception 'FAILED: anon ran model_spend_since';
  exception when insufficient_privilege then
    null;
  end;
  reset role;
end
$$;

rollback;

select 'Budget functions passed' as result;

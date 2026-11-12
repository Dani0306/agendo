-- T17: per-tenant monthly budget (prompt 003). Touches only schema `agendo`.
--
-- tenant_usage per tenant and local month:
--   reserved_usd  money held for calls in flight
--   settled_usd   real cost of finished calls
--   refunded_usd  reservations released by failed calls (a running total, for audit)
-- A reservation passes only if reserved + settled + amount stays within the limit, and
-- the check sits inside the UPDATE, so two concurrent calls can't both take the last
-- dollar: the second waits for the row lock and re-checks.

create function agendo.reserve_budget(p_tenant uuid, p_amount numeric, p_default_limit numeric)
returns date
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_month date;
  v_limit numeric;
begin
  if p_amount < 0 then
    raise exception 'reserve_budget: negative amount';
  end if;

  select (date_trunc('month', now() at time zone t.timezone))::date, coalesce(t.monthly_budget_usd, p_default_limit)
  into v_month, v_limit
  from agendo.tenants t
  where t.id = p_tenant;
  if not found then
    raise exception 'reserve_budget: unknown tenant';
  end if;

  insert into agendo.tenant_usage (tenant_id, month) values (p_tenant, v_month) on conflict do nothing;

  update agendo.tenant_usage
  set reserved_usd = reserved_usd + p_amount
  where tenant_id = p_tenant
    and month = v_month
    and reserved_usd + settled_usd + p_amount <= v_limit;

  if not found then
    return null;
  end if;
  return v_month;
end;
$$;

-- greatest(…, 0) keeps the check constraint safe if a reservation is settled twice.
create function agendo.settle_budget(p_tenant uuid, p_month date, p_reserved numeric, p_actual numeric)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  update agendo.tenant_usage
  set reserved_usd = greatest(reserved_usd - p_reserved, 0),
      settled_usd = settled_usd + p_actual
  where tenant_id = p_tenant and month = p_month;
$$;

create function agendo.refund_budget(p_tenant uuid, p_month date, p_reserved numeric)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  update agendo.tenant_usage
  set reserved_usd = greatest(reserved_usd - p_reserved, 0),
      refunded_usd = refunded_usd + p_reserved
  where tenant_id = p_tenant and month = p_month;
$$;

-- The web demo's daily cap is counted from model_calls, the record of real cost.
create function agendo.model_spend_since(p_tenant uuid, p_since timestamptz)
returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(sum(cost_usd), 0) from agendo.model_calls where tenant_id = p_tenant and created_at >= p_since;
$$;

-- `agendo` is exposed through the API, so only server code may call these.
revoke execute on function agendo.reserve_budget(uuid, numeric, numeric) from public, anon, authenticated;
revoke execute on function agendo.settle_budget(uuid, date, numeric, numeric) from public, anon, authenticated;
revoke execute on function agendo.refund_budget(uuid, date, numeric) from public, anon, authenticated;
revoke execute on function agendo.model_spend_since(uuid, timestamptz) from public, anon, authenticated;
grant execute on function agendo.reserve_budget(uuid, numeric, numeric) to service_role;
grant execute on function agendo.settle_budget(uuid, date, numeric, numeric) to service_role;
grant execute on function agendo.refund_budget(uuid, date, numeric) to service_role;
grant execute on function agendo.model_spend_since(uuid, timestamptz) to service_role;

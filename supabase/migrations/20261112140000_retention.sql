-- T25: retention (prompt 005). Owner decision, 12 Nov 2026: message text is erased 90
-- days after it was sent; customers with no activity for 12 months are deleted.
-- A lawyer must review these periods before a real clinic uses Agendo.
--
-- Deleting a customer cascades to their conversations, messages, bookings and
-- reminders. model_calls keeps its rows (cost history) with conversation_id set null.
-- Touches only schema `agendo`. The daily schedule is a separate migration, applied by
-- the owner when ready (20261112140100_retention_schedule.sql).

create function agendo.apply_retention(p_message_days integer default 90, p_customer_months integer default 12)
returns table (messages_erased bigint, customers_deleted bigint)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_messages bigint;
  v_customers bigint;
  v_message_cutoff timestamptz := now() - make_interval(days => p_message_days);
  v_customer_cutoff timestamptz := now() - make_interval(months => p_customer_months);
begin
  update agendo.messages
  set content = null, tool_calls = null
  where created_at < v_message_cutoff
    and (content is not null or tool_calls is not null);
  get diagnostics v_messages = row_count;

  delete from agendo.customers c
  where c.created_at < v_customer_cutoff
    and not exists (
      select 1
      from agendo.conversations v
      join agendo.messages m on m.tenant_id = v.tenant_id and m.conversation_id = v.id
      where v.tenant_id = c.tenant_id and v.customer_id = c.id and m.created_at >= v_customer_cutoff
    )
    and not exists (
      select 1 from agendo.bookings b
      where b.tenant_id = c.tenant_id and b.customer_id = c.id and upper(b.during) >= v_customer_cutoff
    );
  get diagnostics v_customers = row_count;

  return query select v_messages, v_customers;
end;
$$;

revoke execute on function agendo.apply_retention(integer, integer) from public, anon, authenticated;
grant execute on function agendo.apply_retention(integer, integer) to service_role;

-- T10: the database decides whether a slot is free (prompt 002).
-- btree_gist lets a GiST index compare a uuid with `=` next to a range with `&&`.
-- It goes in schema `extensions`, Supabase's convention; `agendo` is exposed through
-- the API and would publish the extension's functions.
create extension if not exists btree_gist with schema extensions;

-- Only confirmed bookings hold a slot, so a cancelled one frees it. The [) bounds
-- enforced on `during` let a booking start exactly when the previous one ends.
alter table agendo.bookings
  add constraint bookings_no_overlap
  exclude using gist (resource_id with =, during with &&)
  where (status = 'confirmed');

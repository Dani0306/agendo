-- T25: runs the retention job daily (prompt 005). NOT APPLIED YET: the owner decided on
-- 12 Nov 2026 to apply the function first and start the schedule later. Run this in the
-- SQL editor when ready. It is the only part of retention outside schema `agendo`.

-- 08:30 UTC is 03:30 in Bogotá, when no clinic is open.
select cron.schedule('agendo-retention', '30 8 * * *', $$select agendo.apply_retention()$$);

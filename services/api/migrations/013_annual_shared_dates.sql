-- Additive: historical one-off entries and receipts retain their exact identity.
CREATE FUNCTION valid_shared_date_schedule(local_date text, recurrence text, policy text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN recurrence = 'once' THEN policy IS NULL
    WHEN recurrence = 'annual' AND substring(local_date,6) = '02-29'
      THEN coalesce(policy IN ('leap_years_only','feb28','mar1'),false)
    WHEN recurrence = 'annual' THEN policy IS NULL
    ELSE false
  END;
$$;
ALTER TABLE shared_dates
  ADD COLUMN recurrence text NOT NULL DEFAULT 'once',
  ADD COLUMN leap_day_policy text,
  ADD COLUMN leap_day_policy_key text GENERATED ALWAYS AS (coalesce(leap_day_policy,'none')) STORED NOT NULL,
  ADD CONSTRAINT shared_dates_valid_schedule CHECK (valid_shared_date_schedule(local_date,recurrence,leap_day_policy)),
  ADD CONSTRAINT shared_dates_schedule_identity UNIQUE(couple_id,id,creator_id,membership_epoch,title,local_date,timezone,recurrence,leap_day_policy_key);
ALTER TABLE shared_date_commands
  ADD COLUMN recurrence text NOT NULL DEFAULT 'once',
  ADD COLUMN leap_day_policy text,
  ADD COLUMN leap_day_policy_key text GENERATED ALWAYS AS (coalesce(leap_day_policy,'none')) STORED NOT NULL,
  ADD CONSTRAINT shared_date_commands_valid_schedule CHECK (valid_shared_date_schedule(local_date,recurrence,leap_day_policy)),
  ADD CONSTRAINT shared_date_commands_schedule_identity
    FOREIGN KEY(couple_id,date_id,actor_user_id,membership_epoch,title,local_date,timezone,recurrence,leap_day_policy_key)
    REFERENCES shared_dates(couple_id,id,creator_id,membership_epoch,title,local_date,timezone,recurrence,leap_day_policy_key);
-- A non-null generated policy key prevents SQL's nullable-FK bypass. Existing
-- immutable UPDATE/DELETE triggers continue guarding both complete schedules.

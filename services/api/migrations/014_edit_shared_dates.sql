-- Receipts retain immutable submitted content independently of the current resource.
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT conname FROM pg_constraint
    WHERE conrelid='shared_date_commands'::regclass AND confrelid='shared_dates'::regclass
  LOOP EXECUTE format('ALTER TABLE shared_date_commands DROP CONSTRAINT %I',item.conname); END LOOP;
END $$;
ALTER TABLE shared_dates ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0),
  ADD CONSTRAINT shared_dates_scope_identity UNIQUE(couple_id,id,membership_epoch);
ALTER TABLE shared_date_commands
  ADD COLUMN operation text NOT NULL DEFAULT 'create' CHECK(operation IN ('create','edit')),
  ADD COLUMN expected_version integer,
  ADD CONSTRAINT shared_date_commands_version CHECK(
    (operation='create' AND expected_version IS NULL) OR (operation='edit' AND expected_version IS NOT NULL AND expected_version>0)),
  ADD CONSTRAINT shared_date_commands_resource FOREIGN KEY(couple_id,date_id,membership_epoch)
    REFERENCES shared_dates(couple_id,id,membership_epoch);
DROP TRIGGER immutable_shared_date ON shared_dates;
CREATE FUNCTION guard_shared_date_edit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable_shared_date' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.id,NEW.couple_id,NEW.creator_id,NEW.membership_epoch,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.couple_id,OLD.creator_id,OLD.membership_epoch,OLD.created_at)
    OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'invalid_shared_date_edit' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_shared_date_edit BEFORE UPDATE OR DELETE ON shared_dates
  FOR EACH ROW EXECUTE FUNCTION guard_shared_date_edit();
DROP TRIGGER guard_shared_date_zone ON shared_dates;
CREATE TRIGGER guard_shared_date_zone BEFORE INSERT OR UPDATE ON shared_dates
  FOR EACH ROW EXECUTE FUNCTION guard_shared_date_zone();
-- Validate the submitted snapshot once, not as a mutable-resource content FK.
CREATE FUNCTION guard_shared_date_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM shared_dates d WHERE d.couple_id=NEW.couple_id
    AND d.id=NEW.date_id AND d.membership_epoch=NEW.membership_epoch
    AND d.title=NEW.title AND d.local_date=NEW.local_date AND d.timezone=NEW.timezone
    AND d.recurrence=NEW.recurrence AND d.leap_day_policy IS NOT DISTINCT FROM NEW.leap_day_policy
    AND ((NEW.operation='create' AND d.creator_id=NEW.actor_user_id AND d.version=1)
      OR (NEW.operation='edit' AND d.version=NEW.expected_version+1))) THEN
    RAISE EXCEPTION 'invalid_shared_date_receipt' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_shared_date_receipt BEFORE INSERT ON shared_date_commands
  FOR EACH ROW EXECUTE FUNCTION guard_shared_date_receipt();

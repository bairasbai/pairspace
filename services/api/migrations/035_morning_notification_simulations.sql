-- Internal metadata-only observations, never delivery, readiness or opening receipts.
-- No backfill and no content/draft/opening access.
ALTER TABLE morning_slots ADD CONSTRAINT morning_notification_slot_identity
 UNIQUE(id,couple_id,recipient_id,membership_epoch);
CREATE TABLE morning_notification_simulations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid NOT NULL UNIQUE,
 couple_id uuid NOT NULL, recipient_id uuid NOT NULL,
 membership_epoch integer NOT NULL CHECK(membership_epoch>0),
 state text NOT NULL CHECK(state IN ('simulation_eligible','simulation_blocked')),
 reason text NOT NULL CHECK(reason IN ('allowed','disabled','quiet_hours','missed','unavailable')),
 evaluated_at timestamptz NOT NULL CHECK(isfinite(evaluated_at)), preference_version integer,
 FOREIGN KEY(slot_id,couple_id,recipient_id,membership_epoch)
   REFERENCES morning_slots(id,couple_id,recipient_id,membership_epoch),
 CHECK((state='simulation_eligible' AND reason='allowed') OR (state='simulation_blocked' AND reason<>'allowed')),
 CHECK((reason IN ('missed','unavailable') AND preference_version IS NULL)
   OR (reason IN ('allowed','disabled','quiet_hours') AND preference_version IS NOT NULL AND preference_version>=0))
);
CREATE FUNCTION guard_morning_notification_simulation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE release_time timestamptz; actual_time timestamptz;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'morning_simulation_immutable' USING ERRCODE='23514'; END IF;
 -- Slot identities/schedules are immutable. Read only the release metadata, never availability.
 SELECT release_at INTO release_time FROM morning_slots WHERE id=NEW.slot_id
   AND couple_id=NEW.couple_id AND recipient_id=NEW.recipient_id AND membership_epoch=NEW.membership_epoch;
 actual_time:=clock_timestamp();
 IF release_time IS NULL OR actual_time<release_time OR NEW.evaluated_at<release_time THEN
   RAISE EXCEPTION 'morning_simulation_not_released' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_morning_notification_simulation BEFORE INSERT OR UPDATE OR DELETE ON morning_notification_simulations
 FOR EACH ROW EXECUTE FUNCTION guard_morning_notification_simulation();

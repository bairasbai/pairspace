-- Durable care-only capture and terminal dry-run observations. Not delivery jobs.
-- No backfill: historical hearts must not acquire newly generated notification work.
ALTER TABLE care_signals ADD CONSTRAINT care_signal_epoch_identity UNIQUE(couple_id,id,membership_epoch);
ALTER TABLE outbox_events ADD COLUMN care_signal_id uuid;
ALTER TABLE outbox_events ADD COLUMN membership_epoch integer;
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_type_check;
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_event_type CHECK(type IN ('chat.message_created','couple.closed','care.signal_created'));
ALTER TABLE outbox_events ADD CONSTRAINT outbox_event_shape CHECK(
 (type='chat.message_created' AND message_id IS NOT NULL AND care_signal_id IS NULL AND membership_epoch IS NULL)
 OR (type='couple.closed' AND message_id IS NULL AND care_signal_id IS NULL AND membership_epoch IS NULL)
 OR (type='care.signal_created' AND message_id IS NULL AND care_signal_id IS NOT NULL AND membership_epoch IS NOT NULL AND membership_epoch>0)
);
ALTER TABLE outbox_events ADD CONSTRAINT care_outbox_source FOREIGN KEY(couple_id,care_signal_id,membership_epoch) REFERENCES care_signals(couple_id,id,membership_epoch);
CREATE UNIQUE INDEX one_care_signal_event ON outbox_events(care_signal_id) WHERE type='care.signal_created';
ALTER TABLE outbox_events ADD CONSTRAINT outbox_epoch_identity UNIQUE(id,couple_id,membership_epoch);

CREATE TABLE care_notification_simulations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL UNIQUE,
 couple_id uuid NOT NULL, recipient_id uuid NOT NULL, membership_epoch integer NOT NULL CHECK(membership_epoch>0),
 state text NOT NULL CHECK(state IN ('simulation_eligible','simulation_blocked')),
 reason text NOT NULL CHECK(reason IN ('allowed','disabled','quiet_hours','unavailable','expired')),
 evaluated_at timestamptz NOT NULL CHECK(isfinite(evaluated_at)), preference_version integer,
 FOREIGN KEY(event_id,couple_id,membership_epoch) REFERENCES outbox_events(id,couple_id,membership_epoch),
 FOREIGN KEY(couple_id,recipient_id) REFERENCES couple_members(couple_id,user_id),
 CHECK((state='simulation_eligible' AND reason='allowed') OR (state='simulation_blocked' AND reason<>'allowed')),
 CHECK((reason IN ('unavailable','expired') AND preference_version IS NULL)
   OR (reason IN ('allowed','disabled','quiet_hours') AND preference_version IS NOT NULL AND preference_version>=0))
);
CREATE FUNCTION guard_care_notification_simulation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'care_simulation_immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM outbox_events e JOIN care_signals s
   ON s.id=e.care_signal_id AND s.couple_id=e.couple_id AND s.membership_epoch=e.membership_epoch
   WHERE e.id=NEW.event_id AND e.couple_id=NEW.couple_id AND e.membership_epoch=NEW.membership_epoch
     AND e.type='care.signal_created' AND e.processed_at IS NULL AND s.recipient_id=NEW.recipient_id) THEN
   RAISE EXCEPTION 'care_simulation_source' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_care_notification_simulation BEFORE INSERT OR UPDATE OR DELETE ON care_notification_simulations
 FOR EACH ROW EXECUTE FUNCTION guard_care_notification_simulation();

CREATE FUNCTION guard_care_outbox_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 -- Do not change historical chat/closure event behavior.
 IF TG_OP='DELETE' THEN
   IF OLD.type='care.signal_created' THEN RAISE EXCEPTION 'care_event_immutable' USING ERRCODE='23514'; END IF;
   RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.type='care.signal_created' THEN
   IF ROW(NEW.id,NEW.couple_id,NEW.type,NEW.message_id,NEW.care_signal_id,NEW.membership_epoch,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.couple_id,OLD.type,OLD.message_id,OLD.care_signal_id,OLD.membership_epoch,OLD.created_at)
      OR OLD.processed_at IS NOT NULL OR NEW.processed_at IS NULL THEN
     RAISE EXCEPTION 'care_event_immutable' USING ERRCODE='23514';
   END IF;
   IF NOT EXISTS(SELECT 1 FROM care_notification_simulations r WHERE r.event_id=NEW.id AND r.evaluated_at=NEW.processed_at) THEN
     RAISE EXCEPTION 'care_event_requires_simulation' USING ERRCODE='23514';
   END IF;
 ELSIF NEW.type='care.signal_created' THEN
   IF TG_OP='UPDATE' OR NEW.processed_at IS NOT NULL OR NOT isfinite(NEW.created_at) THEN
     RAISE EXCEPTION 'care_event_shape' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_care_outbox_event BEFORE INSERT OR UPDATE OR DELETE ON outbox_events
 FOR EACH ROW EXECUTE FUNCTION guard_care_outbox_event();

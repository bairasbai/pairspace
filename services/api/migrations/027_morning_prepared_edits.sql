-- Author edits replace content, never copy historical plaintext into receipts.
ALTER TABLE morning_content ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483646);
DROP TRIGGER morning_content_immutable ON morning_content;
CREATE FUNCTION guard_morning_content_edit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s morning_slots;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable_morning_fact'; END IF;
  SELECT * INTO s FROM morning_slots WHERE id=OLD.slot_id FOR UPDATE;
  IF ROW(NEW.slot_id,NEW.filled_at) IS DISTINCT FROM ROW(OLD.slot_id,OLD.filled_at)
    OR NEW.version<>OLD.version+1 OR NEW.body=OLD.body THEN RAISE EXCEPTION 'immutable_morning_fact'; END IF;
  IF clock_timestamp()>=s.release_at THEN RAISE EXCEPTION 'morning_slot_closed'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER morning_content_edit_guard BEFORE UPDATE OR DELETE ON morning_content FOR EACH ROW EXECUTE FUNCTION guard_morning_content_edit();
CREATE TABLE morning_prepared_receipts (
  actor_id uuid NOT NULL REFERENCES users(id), command_id uuid NOT NULL,
  slot_id uuid NOT NULL REFERENCES morning_slots(id),
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY(actor_id,command_id)
);
CREATE TRIGGER morning_prepared_receipts_immutable BEFORE UPDATE OR DELETE ON morning_prepared_receipts FOR EACH ROW EXECUTE FUNCTION immutable_morning_fact();
CREATE FUNCTION guard_morning_prepared_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s morning_slots;
BEGIN
 SELECT * INTO s FROM morning_slots WHERE id=NEW.slot_id FOR UPDATE;
 IF NOT FOUND OR NEW.actor_id<>s.sender_id OR NOT EXISTS(SELECT 1 FROM morning_content WHERE slot_id=NEW.slot_id)
   THEN RAISE EXCEPTION 'invalid_morning_prepared_scope'; END IF;
 IF clock_timestamp()>=s.release_at THEN RAISE EXCEPTION 'morning_slot_closed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER morning_prepared_receipt_guard BEFORE INSERT ON morning_prepared_receipts FOR EACH ROW EXECUTE FUNCTION guard_morning_prepared_receipt();

CREATE FUNCTION guard_morning_content_initial_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.version<>1 THEN RAISE EXCEPTION 'invalid_morning_initial_version'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER morning_content_initial_version BEFORE INSERT ON morning_content FOR EACH ROW EXECUTE FUNCTION guard_morning_content_initial_version();

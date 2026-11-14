-- Separate private author draft: never used by recipient readiness/content queries.
CREATE TABLE morning_drafts (
 slot_id uuid PRIMARY KEY REFERENCES morning_slots(id),
 actor_id uuid NOT NULL REFERENCES users(id),
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 16000 AND btrim(body)<>''),
 version integer NOT NULL CHECK(version BETWEEN 1 AND 2147483646)
);
CREATE FUNCTION guard_morning_draft() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s morning_slots;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable_morning_draft_identity'; END IF;
 SELECT * INTO s FROM morning_slots WHERE id=NEW.slot_id FOR UPDATE;
 IF NOT FOUND OR NEW.actor_id<>s.sender_id THEN RAISE EXCEPTION 'invalid_morning_draft_scope'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR EXISTS(SELECT 1 FROM morning_content WHERE slot_id=NEW.slot_id)
   THEN RAISE EXCEPTION 'invalid_morning_draft_create'; END IF;
 ELSIF ROW(NEW.slot_id,NEW.actor_id) IS DISTINCT FROM ROW(OLD.slot_id,OLD.actor_id)
   OR NEW.version<>OLD.version+1 OR NEW.body=OLD.body
   THEN RAISE EXCEPTION 'immutable_morning_draft_identity';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER morning_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON morning_drafts FOR EACH ROW EXECUTE FUNCTION guard_morning_draft();
CREATE TABLE morning_draft_receipts (
 actor_id uuid NOT NULL REFERENCES users(id), command_id uuid NOT NULL,
 slot_id uuid NOT NULL REFERENCES morning_drafts(slot_id),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(actor_id,command_id)
);
CREATE FUNCTION guard_morning_draft_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM morning_drafts WHERE slot_id=NEW.slot_id AND actor_id=NEW.actor_id)
  THEN RAISE EXCEPTION 'invalid_morning_draft_scope'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER morning_draft_receipt_guard BEFORE INSERT ON morning_draft_receipts FOR EACH ROW EXECUTE FUNCTION guard_morning_draft_receipt();
CREATE TRIGGER morning_draft_receipt_immutable BEFORE UPDATE OR DELETE ON morning_draft_receipts FOR EACH ROW EXECUTE FUNCTION immutable_morning_fact();

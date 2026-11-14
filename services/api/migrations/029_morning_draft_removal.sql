-- Logical terminal removal, not a retention purge or backup erasure promise.
ALTER TABLE morning_drafts ALTER COLUMN body DROP NOT NULL;
ALTER TABLE morning_drafts ADD COLUMN state text NOT NULL DEFAULT 'live';
ALTER TABLE morning_drafts ADD CONSTRAINT morning_draft_state CHECK (
 (state='live' AND body IS NOT NULL) OR (state='deleted' AND body IS NULL));
CREATE OR REPLACE FUNCTION guard_morning_draft() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s morning_slots;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable_morning_draft_identity'; END IF;
 SELECT * INTO s FROM morning_slots WHERE id=NEW.slot_id FOR UPDATE;
 IF NOT FOUND OR NEW.actor_id<>s.sender_id THEN RAISE EXCEPTION 'invalid_morning_draft_scope'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.state<>'live' OR EXISTS(SELECT 1 FROM morning_content WHERE slot_id=NEW.slot_id)
   THEN RAISE EXCEPTION 'invalid_morning_draft_create'; END IF;
 ELSIF OLD.state='deleted' OR ROW(NEW.slot_id,NEW.actor_id) IS DISTINCT FROM ROW(OLD.slot_id,OLD.actor_id)
   OR NEW.version<>OLD.version+1 OR ROW(NEW.body,NEW.state) IS NOT DISTINCT FROM ROW(OLD.body,OLD.state)
   THEN RAISE EXCEPTION 'immutable_morning_draft_identity';
 END IF;
 RETURN NEW;
END $$;
CREATE TABLE morning_draft_delete_receipts (
 actor_id uuid NOT NULL REFERENCES users(id), command_id uuid NOT NULL,
 slot_id uuid NOT NULL REFERENCES morning_drafts(slot_id),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(actor_id,command_id)
);
CREATE FUNCTION guard_morning_draft_delete_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM morning_drafts WHERE slot_id=NEW.slot_id AND actor_id=NEW.actor_id AND state='deleted')
  THEN RAISE EXCEPTION 'invalid_morning_draft_scope'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER morning_draft_delete_receipt_guard BEFORE INSERT ON morning_draft_delete_receipts FOR EACH ROW EXECUTE FUNCTION guard_morning_draft_delete_receipt();
CREATE TRIGGER morning_draft_delete_receipt_immutable BEFORE UPDATE OR DELETE ON morning_draft_delete_receipts FOR EACH ROW EXECUTE FUNCTION immutable_morning_fact();
-- New saves cannot acquire receipts after the terminal transition; old receipts remain.
CREATE OR REPLACE FUNCTION guard_morning_draft_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM morning_drafts WHERE slot_id=NEW.slot_id AND actor_id=NEW.actor_id AND state='live')
  THEN RAISE EXCEPTION 'invalid_morning_draft_scope'; END IF;
 RETURN NEW;
END $$;

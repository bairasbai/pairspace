-- Additive candidate: original create receipts retain their immutable payload fingerprints.
ALTER TABLE morning_discussion_messages
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483646),
  ADD COLUMN edited_at timestamptz,
  ADD COLUMN deleted_at timestamptz,
  ALTER COLUMN body DROP NOT NULL;
ALTER TABLE morning_discussion_messages ADD CONSTRAINT morning_discussion_lifecycle CHECK (
  ((deleted_at IS NULL AND body IS NOT NULL) OR (deleted_at IS NOT NULL AND body IS NULL))
  AND (edited_at IS NULL OR (isfinite(edited_at) AND edited_at>=created_at))
  AND (deleted_at IS NULL OR (isfinite(deleted_at) AND deleted_at>=created_at AND (edited_at IS NULL OR deleted_at>=edited_at)))
);
DROP TRIGGER morning_discussion_immutable ON morning_discussion_messages;
CREATE FUNCTION guard_morning_discussion_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable_morning_discussion_identity'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.edited_at IS NOT NULL OR NEW.deleted_at IS NOT NULL OR NEW.body IS NULL
      THEN RAISE EXCEPTION 'invalid_morning_discussion_initial_version'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.slot_id,NEW.couple_id,NEW.membership_epoch,NEW.author_id,NEW.client_id,NEW.seq,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.slot_id,OLD.couple_id,OLD.membership_epoch,OLD.author_id,OLD.client_id,OLD.seq,OLD.created_at)
    THEN RAISE EXCEPTION 'immutable_morning_discussion_identity'; END IF;
  IF OLD.deleted_at IS NOT NULL OR NEW.version<>OLD.version+1
    THEN RAISE EXCEPTION 'invalid_morning_discussion_revision'; END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    IF NEW.body IS NOT NULL OR NEW.edited_at IS DISTINCT FROM OLD.edited_at
      THEN RAISE EXCEPTION 'invalid_morning_discussion_deletion'; END IF;
  ELSE
    IF NEW.body IS NOT DISTINCT FROM OLD.body OR NEW.edited_at IS NULL
      OR NEW.edited_at<COALESCE(OLD.edited_at,OLD.created_at)
      THEN RAISE EXCEPTION 'invalid_morning_discussion_edit'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER morning_discussion_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON morning_discussion_messages
  FOR EACH ROW EXECUTE FUNCTION guard_morning_discussion_revision();
CREATE TABLE morning_discussion_mutation_receipts (
  actor_id uuid NOT NULL REFERENCES users(id),
  command_id uuid NOT NULL,
  couple_id uuid NOT NULL REFERENCES couples(id),
  membership_epoch integer NOT NULL CHECK (membership_epoch>0),
  slot_id uuid NOT NULL REFERENCES morning_slots(id),
  message_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('edit','delete')),
  expected_version integer NOT NULL CHECK (expected_version BETWEEN 1 AND 2147483645),
  applied_version integer NOT NULL,
  is_noop boolean NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  body_digest text CHECK (body_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY(actor_id,command_id),
  CHECK (applied_version=expected_version+CASE WHEN is_noop THEN 0 ELSE 1 END),
  CHECK ((operation='edit' AND body_digest IS NOT NULL) OR (operation='delete' AND body_digest IS NULL AND NOT is_noop)),
  FOREIGN KEY(message_id,slot_id,couple_id,membership_epoch,actor_id)
    REFERENCES morning_discussion_messages(id,slot_id,couple_id,membership_epoch,author_id)
);
CREATE TRIGGER morning_discussion_mutation_receipt_immutable BEFORE UPDATE OR DELETE ON morning_discussion_mutation_receipts
  FOR EACH ROW EXECUTE FUNCTION immutable_morning_fact();
CREATE FUNCTION guard_morning_discussion_mutation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m morning_discussion_messages;
BEGIN
  SELECT * INTO m FROM morning_discussion_messages WHERE id=NEW.message_id;
  IF NOT FOUND OR m.version<>NEW.applied_version
    OR (NEW.operation='delete' AND m.deleted_at IS NULL)
    OR (NEW.operation='edit' AND (m.deleted_at IS NOT NULL OR encode(sha256(convert_to(m.body,'UTF8')),'hex')<>NEW.body_digest))
    THEN RAISE EXCEPTION 'invalid_morning_discussion_mutation_receipt'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER morning_discussion_mutation_receipt_guard BEFORE INSERT ON morning_discussion_mutation_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_morning_discussion_mutation_receipt();
-- Reuse scoped current participant/disclosure checks for raw UPDATE as well as INSERT.
-- API ordering remains pair -> slot -> target; raw SQL callers must follow the same order.
CREATE TRIGGER morning_discussion_update_scope_guard BEFORE UPDATE ON morning_discussion_messages
  FOR EACH ROW EXECUTE FUNCTION guard_morning_discussion();

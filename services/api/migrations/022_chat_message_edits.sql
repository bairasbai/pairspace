-- Run the whole migration in ONE transaction. DDL takes an exclusive relation lock.
-- Historical tombstones have no recoverable original body: keep their digest NULL.
LOCK TABLE chat_messages IN ACCESS EXCLUSIVE MODE;
DROP TRIGGER chat_reply_guard ON chat_messages;
ALTER TABLE chat_messages ADD COLUMN original_body_hash bytea;
UPDATE chat_messages SET original_body_hash=sha256(convert_to(body,'UTF8')) WHERE deleted_at IS NULL;
ALTER TABLE chat_messages ADD CONSTRAINT original_chat_hash_shape CHECK (
  (original_body_hash IS NULL AND deleted_at IS NOT NULL) OR (original_body_hash IS NOT NULL AND octet_length(original_body_hash)=32)
);
CREATE OR REPLACE FUNCTION guard_chat_reply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_seq bigint;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'immutable_chat_identity' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.couple_id,NEW.sender_id,NEW.client_message_id,NEW.seq,NEW.reply_to_id,NEW.created_at,NEW.original_body_hash)
      IS DISTINCT FROM ROW(OLD.id,OLD.couple_id,OLD.sender_id,OLD.client_message_id,OLD.seq,OLD.reply_to_id,OLD.created_at,OLD.original_body_hash) THEN
      RAISE EXCEPTION 'immutable_chat_identity' USING ERRCODE='23514';
    END IF;
    IF OLD.deleted_at IS NOT NULL OR OLD.version=2147483647 OR NEW.version<>OLD.version+1 THEN
      RAISE EXCEPTION 'invalid_chat_tombstone_transition' USING ERRCODE='23514';
    END IF;
    IF NEW.deleted_at IS NULL AND NEW.body IS NOT DISTINCT FROM OLD.body THEN
      RAISE EXCEPTION 'unchanged_chat_body' USING ERRCODE='23514';
    END IF;
    PERFORM 1 FROM couples WHERE id=NEW.couple_id FOR UPDATE;
    IF NEW.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM couples c JOIN couple_members m
      ON m.couple_id=c.id WHERE c.id=NEW.couple_id AND c.status='active'
      AND m.user_id=NEW.sender_id AND m.status='active') THEN
      RAISE EXCEPTION 'unavailable_chat_edit' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version<>1 THEN
    RAISE EXCEPTION 'new_chat_version_must_be_one' USING ERRCODE='23514';
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'new_chat_must_be_live' USING ERRCODE='23514';
  END IF;
  IF NEW.original_body_hash IS NOT NULL AND NEW.original_body_hash<>sha256(convert_to(NEW.body,'UTF8')) THEN
    RAISE EXCEPTION 'invalid_original_chat_hash' USING ERRCODE='23514';
  END IF;
  NEW.original_body_hash:=sha256(convert_to(NEW.body,'UTF8'));
  IF NEW.reply_to_id IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM couples WHERE id=NEW.couple_id AND status='active' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM couple_members WHERE couple_id=NEW.couple_id
    AND user_id=NEW.sender_id AND status='active') THEN
    RAISE EXCEPTION 'unavailable_chat_reply' USING ERRCODE='23514';
  END IF;
  SELECT m.seq INTO target_seq FROM chat_messages m JOIN couple_members member
    ON member.couple_id=m.couple_id AND member.user_id=m.sender_id AND member.status='active'
    WHERE m.couple_id=NEW.couple_id AND m.id=NEW.reply_to_id AND m.deleted_at IS NULL;
  IF target_seq IS NULL OR target_seq>=NEW.seq THEN
    RAISE EXCEPTION 'invalid_chat_reply_target' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chat_reply_guard BEFORE INSERT OR UPDATE OR DELETE ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION guard_chat_reply();

-- Edit keys have their own namespace, separate from send and deletion command keys.
CREATE TABLE chat_edit_receipts (
  actor_id uuid NOT NULL,
  command_id uuid NOT NULL,
  couple_id uuid NOT NULL,
  membership_epoch integer NOT NULL CHECK(membership_epoch>0 AND membership_epoch<2147483647),
  message_id uuid NOT NULL,
  expected_version integer NOT NULL CHECK(expected_version>0 AND expected_version<2147483647),
  operation text NOT NULL CHECK(operation='edit'),
  applied_version integer NOT NULL CHECK(applied_version>0),
  is_noop boolean NOT NULL,
  CHECK((is_noop AND applied_version=expected_version)
    OR (NOT is_noop AND applied_version=expected_version+1)),
  body_hash bytea NOT NULL CHECK(octet_length(body_hash)=32),
  PRIMARY KEY(actor_id,command_id),
  FOREIGN KEY(message_id,couple_id,actor_id) REFERENCES chat_messages(id,couple_id,sender_id),
  FOREIGN KEY(couple_id,actor_id) REFERENCES couple_members(couple_id,user_id)
);
CREATE FUNCTION guard_chat_edit_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'immutable_chat_edit_receipt' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM couples WHERE id=NEW.couple_id AND status='active'
    AND membership_epoch=NEW.membership_epoch FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM couple_members WHERE couple_id=NEW.couple_id
    AND user_id=NEW.actor_id AND status='active') THEN
    RAISE EXCEPTION 'invalid_chat_edit_scope' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM chat_messages WHERE id=NEW.message_id AND couple_id=NEW.couple_id
    AND sender_id=NEW.actor_id AND deleted_at IS NULL AND version=NEW.applied_version
    AND sha256(convert_to(body,'UTF8'))=NEW.body_hash) THEN
    RAISE EXCEPTION 'invalid_chat_edit_receipt' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chat_edit_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON chat_edit_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_chat_edit_receipt();

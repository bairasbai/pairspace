-- DELETE command identities are separate from legacy send client_message_id identities.
-- No plaintext or historical message snapshot is stored in these receipts.
ALTER TABLE chat_messages ADD CONSTRAINT chat_message_author_identity UNIQUE(id,couple_id,sender_id);
CREATE TABLE chat_deletion_receipts (
  actor_id uuid NOT NULL,
  command_id uuid NOT NULL,
  couple_id uuid NOT NULL,
  membership_epoch integer NOT NULL CHECK(membership_epoch>0 AND membership_epoch<2147483647),
  message_id uuid NOT NULL,
  expected_version integer NOT NULL CHECK(expected_version>0 AND expected_version<2147483647),
  operation text NOT NULL CHECK(operation='delete'),
  scope text NOT NULL CHECK(scope='everyone'),
  PRIMARY KEY(actor_id,command_id),
  FOREIGN KEY(message_id,couple_id,actor_id) REFERENCES chat_messages(id,couple_id,sender_id),
  FOREIGN KEY(couple_id,actor_id) REFERENCES couple_members(couple_id,user_id)
);
CREATE FUNCTION guard_chat_deletion_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'immutable_chat_deletion_receipt' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM couples WHERE id=NEW.couple_id AND status='active'
    AND membership_epoch=NEW.membership_epoch FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM couple_members WHERE couple_id=NEW.couple_id
    AND user_id=NEW.actor_id AND status='active') THEN
    RAISE EXCEPTION 'invalid_chat_deletion_scope' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM chat_messages WHERE id=NEW.message_id AND couple_id=NEW.couple_id
    AND sender_id=NEW.actor_id AND deleted_at IS NOT NULL AND body IS NULL
    AND version=NEW.expected_version+1) THEN
    RAISE EXCEPTION 'invalid_chat_deletion_receipt' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chat_deletion_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON chat_deletion_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_chat_deletion_receipt();

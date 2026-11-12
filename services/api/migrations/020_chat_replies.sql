-- Additive references only: no copied quotes and no rewrite of historical bodies.
ALTER TABLE chat_messages ADD COLUMN reply_to_id uuid;
ALTER TABLE chat_messages ADD COLUMN deleted_at timestamptz;
ALTER TABLE chat_messages ALTER COLUMN body DROP NOT NULL;
ALTER TABLE chat_messages ADD CONSTRAINT chat_tombstone_shape CHECK (
  (deleted_at IS NULL AND body IS NOT NULL) OR
  (deleted_at IS NOT NULL AND body IS NULL AND isfinite(deleted_at)
    AND deleted_at=date_trunc('milliseconds',deleted_at) AND deleted_at>=created_at)
);
ALTER TABLE chat_messages ADD CONSTRAINT chat_reply_same_pair
  FOREIGN KEY(couple_id,reply_to_id) REFERENCES chat_messages(couple_id,id) ON DELETE RESTRICT;
CREATE FUNCTION guard_chat_reply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_seq bigint;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'immutable_chat_identity' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.couple_id,NEW.sender_id,NEW.client_message_id,NEW.seq,NEW.reply_to_id,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.couple_id,OLD.sender_id,OLD.client_message_id,OLD.seq,OLD.reply_to_id,OLD.created_at) THEN
      RAISE EXCEPTION 'immutable_chat_identity' USING ERRCODE='23514';
    END IF;
    IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL OR NEW.body IS NOT NULL
      OR OLD.version=2147483647 OR NEW.version<>OLD.version+1 THEN
      RAISE EXCEPTION 'invalid_chat_tombstone_transition' USING ERRCODE='23514';
    END IF;
    -- Internal persistence transition only. There is no user deletion API/actor claim.
    PERFORM 1 FROM couples WHERE id=NEW.couple_id FOR UPDATE;
    RETURN NEW;
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'new_chat_must_be_live' USING ERRCODE='23514';
  END IF;
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
CREATE INDEX chat_reply_target ON chat_messages(couple_id,reply_to_id) WHERE reply_to_id IS NOT NULL;

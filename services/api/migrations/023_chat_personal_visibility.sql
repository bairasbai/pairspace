-- Personal visibility is a scoped view, not deletion or a partner-visible event.
CREATE TABLE chat_visibility_scopes (
  actor_id uuid NOT NULL REFERENCES users(id),
  couple_id uuid NOT NULL REFERENCES couples(id),
  membership_epoch integer NOT NULL CHECK (membership_epoch > 0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(actor_id,couple_id,membership_epoch),
  FOREIGN KEY(couple_id,actor_id) REFERENCES couple_members(couple_id,user_id)
);
CREATE TABLE chat_message_visibility (
  actor_id uuid NOT NULL,
  couple_id uuid NOT NULL,
  membership_epoch integer NOT NULL,
  message_id uuid NOT NULL REFERENCES chat_messages(id),
  hidden boolean NOT NULL,
  version integer NOT NULL CHECK(version > 0),
  PRIMARY KEY(actor_id,couple_id,membership_epoch,message_id),
  FOREIGN KEY(actor_id,couple_id,membership_epoch)
    REFERENCES chat_visibility_scopes(actor_id,couple_id,membership_epoch)
);
CREATE TABLE chat_visibility_receipts (
  actor_id uuid NOT NULL REFERENCES users(id),
  command_id uuid NOT NULL,
  couple_id uuid NOT NULL,
  membership_epoch integer NOT NULL,
  message_id uuid NOT NULL,
  expected_version integer NOT NULL CHECK(expected_version >= 0),
  hidden boolean NOT NULL,
  applied_version integer NOT NULL CHECK(applied_version >= 0),
  PRIMARY KEY(actor_id,command_id),
  FOREIGN KEY(actor_id,couple_id,membership_epoch)
    REFERENCES chat_visibility_scopes(actor_id,couple_id,membership_epoch),
  FOREIGN KEY(message_id) REFERENCES chat_messages(id)
);
CREATE FUNCTION guard_chat_visibility() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pair couples%ROWTYPE; old_version integer; old_hidden boolean;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable_visibility_fact'; END IF;
  SELECT * INTO pair FROM couples WHERE id=NEW.couple_id FOR UPDATE;
  IF pair.status IS DISTINCT FROM 'active' OR pair.membership_epoch<>NEW.membership_epoch
    OR NOT EXISTS(SELECT 1 FROM couple_members WHERE couple_id=NEW.couple_id
      AND user_id=NEW.actor_id AND status='active') THEN
    RAISE EXCEPTION 'visibility_scope_unavailable';
  END IF;
  IF TG_TABLE_NAME='chat_visibility_scopes' THEN
    IF TG_OP='INSERT' AND NEW.revision<>0 THEN RAISE EXCEPTION 'initial_visibility_revision'; END IF;
    IF TG_OP='UPDATE' AND ((NEW.actor_id,NEW.couple_id,NEW.membership_epoch)
      IS DISTINCT FROM (OLD.actor_id,OLD.couple_id,OLD.membership_epoch)
      OR NEW.revision<>OLD.revision+1) THEN RAISE EXCEPTION 'visibility_revision_transition'; END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM chat_messages m JOIN couple_members cm
    ON cm.couple_id=m.couple_id AND cm.user_id=m.sender_id AND cm.status='active'
    WHERE m.id=NEW.message_id AND m.couple_id=NEW.couple_id) THEN
    RAISE EXCEPTION 'visibility_message_scope';
  END IF;
  IF TG_TABLE_NAME='chat_visibility_receipts' THEN
    IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'immutable_visibility_receipt'; END IF;
    SELECT version,hidden INTO old_version,old_hidden FROM chat_message_visibility
      WHERE actor_id=NEW.actor_id AND couple_id=NEW.couple_id AND membership_epoch=NEW.membership_epoch
        AND message_id=NEW.message_id;
    IF COALESCE(old_version,0)<>NEW.applied_version OR COALESCE(old_hidden,false)<>NEW.hidden
      OR NEW.applied_version NOT IN (NEW.expected_version,NEW.expected_version+1) THEN
      RAISE EXCEPTION 'visibility_receipt_state';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NOT NEW.hidden THEN RAISE EXCEPTION 'initial_visibility_state'; END IF;
  ELSIF (NEW.actor_id,NEW.couple_id,NEW.membership_epoch,NEW.message_id)
    IS DISTINCT FROM (OLD.actor_id,OLD.couple_id,OLD.membership_epoch,OLD.message_id)
    OR NEW.version<>OLD.version+1 OR NEW.hidden=OLD.hidden THEN
    RAISE EXCEPTION 'visibility_state_transition';
  END IF;
  UPDATE chat_visibility_scopes SET revision=revision+1 WHERE actor_id=NEW.actor_id
    AND couple_id=NEW.couple_id AND membership_epoch=NEW.membership_epoch;
  RETURN NEW;
END $$;
CREATE TRIGGER chat_visibility_scope_guard BEFORE INSERT OR UPDATE OR DELETE ON chat_visibility_scopes
  FOR EACH ROW EXECUTE FUNCTION guard_chat_visibility();
CREATE TRIGGER chat_visibility_message_guard BEFORE INSERT OR UPDATE OR DELETE ON chat_message_visibility
  FOR EACH ROW EXECUTE FUNCTION guard_chat_visibility();
CREATE TRIGGER chat_visibility_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON chat_visibility_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_chat_visibility();

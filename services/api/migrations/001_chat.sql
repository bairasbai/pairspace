-- One-time migration, to be applied transactionally by a versioned migration runner.
-- No grants or production connection: private schema objects for a test-only API core.
CREATE TABLE users (
  id uuid PRIMARY KEY
);
CREATE TABLE couples (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('waiting_partner', 'active', 'closed')),
  membership_epoch integer NOT NULL DEFAULT 1 CHECK (membership_epoch > 0),
  next_chat_seq bigint NOT NULL DEFAULT 1 CHECK (next_chat_seq > 0 AND next_chat_seq <= 9007199254740991)
);
CREATE TABLE couple_members (
  couple_id uuid NOT NULL REFERENCES couples(id),
  user_id uuid NOT NULL REFERENCES users(id),
  slot smallint NOT NULL CHECK (slot IN (1, 2)),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  PRIMARY KEY (couple_id, user_id)
);
CREATE UNIQUE INDEX active_couple_slot ON couple_members(couple_id, slot) WHERE status = 'active';
CREATE UNIQUE INDEX one_active_couple_per_user ON couple_members(user_id) WHERE status = 'active';
CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id uuid NOT NULL REFERENCES couples(id),
  sender_id uuid NOT NULL,
  client_message_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0 AND seq <= 9007199254740991),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000 AND body = normalize(body, NFC) AND body !~ '^[[:space:]]*$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (couple_id, id),
  UNIQUE (couple_id, seq),
  UNIQUE (couple_id, sender_id, client_message_id),
  FOREIGN KEY (couple_id, sender_id) REFERENCES couple_members(couple_id, user_id)
);
CREATE INDEX chat_history ON chat_messages(couple_id, seq DESC);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id uuid NOT NULL REFERENCES couples(id),
  type text NOT NULL CHECK (type IN ('chat.message_created', 'couple.closed')),
  message_id uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at timestamptz,
  UNIQUE (type, message_id),
  FOREIGN KEY (couple_id, message_id) REFERENCES chat_messages(couple_id, id),
  CHECK ((type = 'chat.message_created' AND message_id IS NOT NULL)
      OR (type = 'couple.closed' AND message_id IS NULL))
);
CREATE UNIQUE INDEX one_close_event ON outbox_events(couple_id) WHERE type = 'couple.closed';
-- Intentionally no body/payload column in outbox. A future authorized worker loads current data by ID.

-- An active pair must actually have two active members, checked at transaction end.
CREATE FUNCTION enforce_active_pair_size() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  new_couple uuid;
  old_couple uuid;
BEGIN
  IF TG_TABLE_NAME = 'couples' THEN
    new_couple := NEW.id;
    old_couple := OLD.id;
  ELSE
    new_couple := NEW.couple_id;
    old_couple := OLD.couple_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM couples c WHERE c.id = ANY(ARRAY[new_couple, old_couple])
      AND c.status = 'active'
      AND (SELECT count(*) FROM couple_members m WHERE m.couple_id = c.id AND m.status = 'active') <> 2
  ) THEN
    RAISE EXCEPTION 'active_pair_requires_two_members' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER active_pair_size_on_couple
  AFTER INSERT OR UPDATE ON couples DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_active_pair_size();
CREATE CONSTRAINT TRIGGER active_pair_size_on_members
  AFTER INSERT OR UPDATE OR DELETE ON couple_members DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_active_pair_size();

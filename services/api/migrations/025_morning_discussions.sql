-- Immutable discussion messages. The original morning body is never copied here.
CREATE TABLE morning_discussion_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id uuid NOT NULL REFERENCES morning_slots(id),
  couple_id uuid NOT NULL REFERENCES couples(id),
  membership_epoch integer NOT NULL CHECK (membership_epoch > 0),
  author_id uuid NOT NULL REFERENCES users(id),
  client_id uuid NOT NULL,
  seq bigserial UNIQUE CHECK (seq BETWEEN 1 AND 9007199254740991),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000 AND btrim(body,E' \t\n')<>''
    AND body=normalize(body,NFC) AND position(E'\r' in body)=0),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  UNIQUE (author_id,client_id),
  UNIQUE (id,slot_id,couple_id,membership_epoch,author_id),
  FOREIGN KEY (couple_id,author_id) REFERENCES couple_members(couple_id,user_id)
);
CREATE INDEX morning_discussion_window ON morning_discussion_messages(slot_id,seq);
CREATE TABLE morning_discussion_receipts (
  actor_id uuid NOT NULL REFERENCES users(id),
  command_id uuid NOT NULL,
  couple_id uuid NOT NULL REFERENCES couples(id),
  membership_epoch integer NOT NULL CHECK (membership_epoch > 0),
  slot_id uuid NOT NULL REFERENCES morning_slots(id),
  message_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (actor_id,command_id),
  FOREIGN KEY (message_id,slot_id,couple_id,membership_epoch,actor_id)
    REFERENCES morning_discussion_messages(id,slot_id,couple_id,membership_epoch,author_id)
);
CREATE TRIGGER morning_discussion_immutable BEFORE UPDATE OR DELETE ON morning_discussion_messages
  FOR EACH ROW EXECUTE FUNCTION immutable_morning_fact();
CREATE TRIGGER morning_discussion_receipt_immutable BEFORE UPDATE OR DELETE ON morning_discussion_receipts
  FOR EACH ROW EXECUTE FUNCTION immutable_morning_fact();
CREATE FUNCTION guard_morning_discussion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s morning_slots;
BEGIN
  -- Raw INSERT constraints express scoped participant eligibility, not external session authentication.
  PERFORM 1 FROM couples WHERE id=NEW.couple_id AND status='active'
    AND membership_epoch=NEW.membership_epoch FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'morning_discussion_unavailable'; END IF;
  SELECT * INTO s FROM morning_slots WHERE id=NEW.slot_id FOR SHARE;
  IF NOT FOUND OR ROW(s.couple_id,s.membership_epoch) IS DISTINCT FROM ROW(NEW.couple_id,NEW.membership_epoch)
    OR NEW.author_id NOT IN(s.sender_id,s.recipient_id)
    OR NOT EXISTS(SELECT 1 FROM couple_members WHERE couple_id=s.couple_id AND user_id=s.sender_id AND status='active')
    OR NOT EXISTS(SELECT 1 FROM couple_members WHERE couple_id=s.couple_id AND user_id=s.recipient_id AND status='active')
    OR NOT EXISTS(SELECT 1 FROM morning_content WHERE slot_id=s.id)
    THEN RAISE EXCEPTION 'morning_discussion_unavailable'; END IF;
  IF NEW.author_id=s.sender_id AND (clock_timestamp()<s.release_at OR NEW.created_at<s.release_at)
    THEN RAISE EXCEPTION 'morning_discussion_unavailable'; END IF;
  IF NEW.author_id=s.recipient_id AND NOT EXISTS(SELECT 1 FROM morning_openings WHERE slot_id=s.id AND recipient_id=NEW.author_id)
    THEN RAISE EXCEPTION 'morning_discussion_unavailable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER morning_discussion_guard BEFORE INSERT ON morning_discussion_messages
  FOR EACH ROW EXECUTE FUNCTION guard_morning_discussion();
CREATE FUNCTION guard_morning_discussion_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM morning_discussion_messages WHERE id=NEW.message_id AND client_id=NEW.command_id)
    THEN RAISE EXCEPTION 'invalid_morning_discussion_receipt'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER morning_discussion_receipt_guard BEFORE INSERT ON morning_discussion_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_morning_discussion_receipt();

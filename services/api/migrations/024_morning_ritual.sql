-- Independent explicit morning slots. No legacy letters, delivery jobs or notifications.
CREATE TABLE morning_preferences (
  couple_id uuid NOT NULL REFERENCES couples(id),
  membership_epoch integer NOT NULL CHECK (membership_epoch > 0),
  user_id uuid NOT NULL,
  timezone text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 100),
  local_time text NOT NULL CHECK (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 2147483646),
  PRIMARY KEY (couple_id, membership_epoch, user_id),
  FOREIGN KEY (couple_id, user_id) REFERENCES couple_members(couple_id, user_id)
);
CREATE TABLE morning_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id uuid NOT NULL REFERENCES couples(id),
  membership_epoch integer NOT NULL CHECK (membership_epoch > 0),
  sender_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  local_date date NOT NULL CHECK (local_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
  local_time text NOT NULL CHECK (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone text NOT NULL,
  utc_offset text NOT NULL CHECK (utc_offset ~ '^[+-](0[0-9]|1[0-4]):[0-5][0-9]$' AND utc_offset <> '-00:00'),
  release_at timestamptz NOT NULL CHECK (isfinite(release_at) AND release_at=date_trunc('milliseconds',release_at)),
  preference_version integer NOT NULL CHECK (preference_version > 0),
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version=1),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
  CHECK (sender_id<>recipient_id AND created_at<release_at),
  UNIQUE (couple_id,membership_epoch,recipient_id,local_date),
  UNIQUE (id,couple_id,membership_epoch,sender_id),
  FOREIGN KEY (couple_id,sender_id) REFERENCES couple_members(couple_id,user_id),
  FOREIGN KEY (couple_id,recipient_id) REFERENCES couple_members(couple_id,user_id)
);
CREATE INDEX morning_history ON morning_slots(couple_id,membership_epoch,release_at DESC,id DESC);
CREATE TABLE morning_content (
  slot_id uuid PRIMARY KEY REFERENCES morning_slots(id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000 AND btrim(body,E' \t\n')<>''
    AND body=normalize(body,NFC) AND position(E'\r' in body)=0),
  filled_at timestamptz NOT NULL CHECK (isfinite(filled_at))
);
CREATE TABLE morning_command_receipts (
  actor_id uuid NOT NULL REFERENCES users(id),
  command_id uuid NOT NULL,
  couple_id uuid NOT NULL REFERENCES couples(id),
  membership_epoch integer NOT NULL CHECK (membership_epoch>0),
  operation text NOT NULL CHECK (operation IN ('preference','schedule','fill','open')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  slot_id uuid,
  PRIMARY KEY (actor_id,command_id),
  CHECK ((operation='preference' AND slot_id IS NULL) OR (operation<>'preference' AND slot_id IS NOT NULL)),
  FOREIGN KEY (couple_id,actor_id) REFERENCES couple_members(couple_id,user_id),
  FOREIGN KEY (slot_id) REFERENCES morning_slots(id)
);
CREATE FUNCTION immutable_morning_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_morning_fact';
END $$;
CREATE TRIGGER morning_slots_immutable BEFORE UPDATE OR DELETE ON morning_slots FOR EACH ROW EXECUTE FUNCTION immutable_morning_fact();
CREATE TRIGGER morning_content_immutable BEFORE UPDATE OR DELETE ON morning_content FOR EACH ROW EXECUTE FUNCTION immutable_morning_fact();
CREATE TRIGGER morning_receipts_immutable BEFORE UPDATE OR DELETE ON morning_command_receipts FOR EACH ROW EXECUTE FUNCTION immutable_morning_fact();
CREATE FUNCTION guard_morning_preference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable_morning_preference_identity'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone) THEN RAISE EXCEPTION 'invalid_morning_timezone'; END IF;
  IF TG_OP='INSERT' AND NEW.version<>1 THEN RAISE EXCEPTION 'invalid_morning_preference_version'; END IF;
  IF TG_OP='UPDATE' AND (ROW(NEW.couple_id,NEW.membership_epoch,NEW.user_id) IS DISTINCT FROM ROW(OLD.couple_id,OLD.membership_epoch,OLD.user_id)
    OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'invalid_morning_preference_version'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER morning_preference_guard BEFORE INSERT OR UPDATE OR DELETE ON morning_preferences FOR EACH ROW EXECUTE FUNCTION guard_morning_preference();
CREATE FUNCTION guard_morning_slot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p morning_preferences; wall timestamp;
BEGIN
  SELECT * INTO p FROM morning_preferences WHERE couple_id=NEW.couple_id AND membership_epoch=NEW.membership_epoch AND user_id=NEW.recipient_id FOR SHARE;
  IF NOT FOUND OR ROW(p.version,p.timezone,p.local_time) IS DISTINCT FROM ROW(NEW.preference_version,NEW.timezone,NEW.local_time)
    THEN RAISE EXCEPTION 'invalid_morning_preference_snapshot'; END IF;
  wall := NEW.local_date+NEW.local_time::time;
  IF NEW.release_at AT TIME ZONE NEW.timezone <> wall
    OR NEW.release_at <> (NEW.local_date::text||'T'||NEW.local_time||':00'||NEW.utc_offset)::timestamptz
    OR (substring(NEW.utc_offset,2,2)='14' AND right(NEW.utc_offset,2)<>'00')
    THEN RAISE EXCEPTION 'invalid_morning_snapshot'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER morning_slot_guard BEFORE INSERT ON morning_slots FOR EACH ROW EXECUTE FUNCTION guard_morning_slot();
CREATE FUNCTION guard_morning_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s morning_slots;
BEGIN
  SELECT * INTO s FROM morning_slots WHERE id=NEW.slot_id FOR UPDATE;
  IF NOT FOUND OR clock_timestamp()>=s.release_at OR NEW.filled_at>=s.release_at OR NEW.filled_at<s.created_at
    THEN RAISE EXCEPTION 'morning_slot_closed'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER morning_content_guard BEFORE INSERT ON morning_content FOR EACH ROW EXECUTE FUNCTION guard_morning_content();

CREATE TABLE morning_openings (
  slot_id uuid PRIMARY KEY REFERENCES morning_slots(id),
  recipient_id uuid NOT NULL REFERENCES users(id),
  opened_at timestamptz NOT NULL CHECK (isfinite(opened_at))
);
CREATE TRIGGER morning_openings_immutable BEFORE UPDATE OR DELETE ON morning_openings FOR EACH ROW EXECUTE FUNCTION immutable_morning_fact();
CREATE FUNCTION guard_morning_opening() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s morning_slots;
BEGIN
  SELECT * INTO s FROM morning_slots WHERE id=NEW.slot_id FOR UPDATE;
  IF NOT FOUND OR NEW.recipient_id<>s.recipient_id OR NEW.opened_at<s.release_at OR clock_timestamp()<s.release_at
    OR NOT EXISTS(SELECT 1 FROM morning_content WHERE slot_id=NEW.slot_id)
    THEN RAISE EXCEPTION 'morning_open_unavailable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER morning_opening_guard BEFORE INSERT ON morning_openings FOR EACH ROW EXECUTE FUNCTION guard_morning_opening();
CREATE FUNCTION guard_morning_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s morning_slots;
BEGIN
  IF NEW.slot_id IS NOT NULL THEN
    SELECT * INTO s FROM morning_slots WHERE id=NEW.slot_id;
    IF NOT FOUND OR ROW(s.couple_id,s.membership_epoch) IS DISTINCT FROM ROW(NEW.couple_id,NEW.membership_epoch)
      OR (NEW.operation='open' AND NEW.actor_id<>s.recipient_id)
      OR (NEW.operation<>'open' AND NEW.actor_id<>s.sender_id)
      THEN RAISE EXCEPTION 'invalid_morning_receipt_scope'; END IF;
    IF NEW.operation='open' AND NOT EXISTS(SELECT 1 FROM morning_openings WHERE slot_id=NEW.slot_id AND recipient_id=NEW.actor_id)
      THEN RAISE EXCEPTION 'invalid_morning_receipt_fact'; END IF;
    IF NEW.operation='fill' AND NOT EXISTS(SELECT 1 FROM morning_content WHERE slot_id=NEW.slot_id)
      THEN RAISE EXCEPTION 'invalid_morning_receipt_fact'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM morning_preferences WHERE couple_id=NEW.couple_id AND membership_epoch=NEW.membership_epoch AND user_id=NEW.actor_id)
    THEN RAISE EXCEPTION 'invalid_morning_receipt_fact';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER morning_receipt_guard BEFORE INSERT ON morning_command_receipts FOR EACH ROW EXECUTE FUNCTION guard_morning_receipt();

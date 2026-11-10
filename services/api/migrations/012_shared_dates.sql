-- All-day one-off labels are text, never a timestamp interpreted in a session zone.
CREATE FUNCTION valid_shared_local_date(value text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE y integer; m integer; d integer; days integer[];
BEGIN
  IF value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false; END IF;
  y := substring(value,1,4)::integer;
  m := substring(value,6,2)::integer;
  d := substring(value,9,2)::integer;
  IF y<1 OR m<1 OR m>12 OR d<1 THEN RETURN false; END IF;
  days := ARRAY[31,28,31,30,31,30,31,31,30,31,30,31];
  IF y%4=0 AND (y%100<>0 OR y%400=0) THEN days[2] := 29; END IF;
  RETURN d<=days[m];
END;
$$;
CREATE TABLE shared_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id uuid NOT NULL REFERENCES couples(id),
  creator_id uuid NOT NULL,
  membership_epoch integer NOT NULL CHECK (membership_epoch>0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND octet_length(title)<=800
    AND title=normalize(title,NFC) AND title=btrim(title) AND title !~ '[[:cntrl:]]' AND title !~ '  '),
  local_date text NOT NULL CHECK (valid_shared_local_date(local_date)),
  timezone text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 100 AND timezone ~ '^[A-Za-z][A-Za-z0-9_+/-]*$'),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
  UNIQUE(couple_id,id),
  UNIQUE(couple_id,id,creator_id,membership_epoch,title,local_date,timezone),
  FOREIGN KEY(couple_id,creator_id) REFERENCES couple_members(couple_id,user_id)
);
CREATE INDEX shared_dates_latest ON shared_dates(couple_id,membership_epoch,created_at DESC,id DESC);
CREATE FUNCTION guard_shared_date_zone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone) THEN
    RAISE EXCEPTION 'invalid_shared_date_zone' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_shared_date_zone BEFORE INSERT ON shared_dates
  FOR EACH ROW EXECUTE FUNCTION guard_shared_date_zone();
CREATE TABLE shared_date_commands (
  actor_user_id uuid NOT NULL,
  command_id uuid NOT NULL,
  couple_id uuid NOT NULL,
  membership_epoch integer NOT NULL CHECK (membership_epoch>0),
  date_id uuid NOT NULL,
  title text NOT NULL,
  local_date text NOT NULL,
  timezone text NOT NULL,
  PRIMARY KEY(actor_user_id,command_id),
  FOREIGN KEY(couple_id,actor_user_id) REFERENCES couple_members(couple_id,user_id),
  FOREIGN KEY(couple_id,date_id,actor_user_id,membership_epoch,title,local_date,timezone)
    REFERENCES shared_dates(couple_id,id,creator_id,membership_epoch,title,local_date,timezone)
);
-- Retained on pair closure; no deletion/archive policy is introduced by this slice.
CREATE FUNCTION immutable_shared_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_shared_date' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER immutable_shared_date BEFORE UPDATE OR DELETE ON shared_dates
  FOR EACH ROW EXECUTE FUNCTION immutable_shared_date();
CREATE TRIGGER immutable_shared_date_command BEFORE UPDATE OR DELETE ON shared_date_commands
  FOR EACH ROW EXECUTE FUNCTION immutable_shared_date();

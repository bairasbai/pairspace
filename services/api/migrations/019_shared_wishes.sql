-- Synthetic-only shared wishes. Titles stay private to the current active pair.
CREATE TABLE shared_wishes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id uuid NOT NULL REFERENCES couples(id),
  creator_id uuid NOT NULL,
  membership_epoch integer NOT NULL CHECK (membership_epoch > 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND octet_length(title) <= 800
    AND title = normalize(title, NFC) AND title = btrim(title) AND title !~ '[[:cntrl:]]' AND title !~ '  '),
  explanation text NOT NULL CHECK (char_length(explanation)<=600 AND octet_length(explanation)<=2400
    AND explanation=normalize(explanation,NFC) AND explanation=btrim(explanation,E' \n\t\r')
    AND translate(explanation,E'\n','') !~ '[[:cntrl:]]'),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','fulfilled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
  updated_at timestamptz NOT NULL CHECK (isfinite(updated_at) AND updated_at=date_trunc('milliseconds',updated_at) AND updated_at>=created_at),
  UNIQUE (couple_id, id, membership_epoch),
  FOREIGN KEY (couple_id,creator_id) REFERENCES couple_members(couple_id,user_id)
);
CREATE INDEX shared_wishes_latest ON shared_wishes(couple_id,membership_epoch,created_at DESC,id DESC);
CREATE TABLE shared_wish_commands (
  actor_user_id uuid NOT NULL,
  command_id uuid NOT NULL,
  couple_id uuid NOT NULL,
  membership_epoch integer NOT NULL CHECK (membership_epoch > 0),
  wish_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('create','fulfill','reopen')),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  title text,
  explanation text,
  applied_version integer NOT NULL CHECK (applied_version > 0),
  PRIMARY KEY (actor_user_id,command_id),
  FOREIGN KEY (couple_id,actor_user_id) REFERENCES couple_members(couple_id,user_id),
  FOREIGN KEY (couple_id,wish_id,membership_epoch) REFERENCES shared_wishes(couple_id,id,membership_epoch),
  CHECK ((operation='create' AND expected_version=0 AND applied_version=1 AND title IS NOT NULL AND explanation IS NOT NULL)
    OR (operation<>'create' AND expected_version>0 AND applied_version=expected_version+1 AND title IS NULL AND explanation IS NULL))
);
CREATE FUNCTION immutable_shared_wish_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_shared_wish_command' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER immutable_shared_wish_command BEFORE UPDATE OR DELETE ON shared_wish_commands
  FOR EACH ROW EXECUTE FUNCTION immutable_shared_wish_command();
CREATE FUNCTION guard_shared_wish_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.couple_id<>OLD.couple_id OR NEW.creator_id<>OLD.creator_id
    OR NEW.membership_epoch<>OLD.membership_epoch OR NEW.title<>OLD.title OR NEW.explanation<>OLD.explanation OR NEW.created_at<>OLD.created_at
    OR NEW.updated_at<OLD.updated_at OR NEW.version<>OLD.version+1 OR NEW.state=OLD.state THEN
    RAISE EXCEPTION 'invalid_shared_wish_change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_shared_wish_change BEFORE UPDATE ON shared_wishes
  FOR EACH ROW EXECUTE FUNCTION guard_shared_wish_change();

CREATE TRIGGER forbid_shared_wish_delete BEFORE DELETE ON shared_wishes
  FOR EACH ROW EXECUTE FUNCTION immutable_shared_wish_command();

-- Immutable historical receipts bind the current application result at INSERT only.
CREATE FUNCTION guard_shared_wish_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wish shared_wishes;
BEGIN
  SELECT * INTO wish FROM shared_wishes WHERE couple_id=NEW.couple_id AND id=NEW.wish_id;
  IF wish.id IS NULL OR NEW.applied_version<>wish.version
    OR (NEW.operation='create' AND (NEW.actor_user_id<>wish.creator_id
      OR NEW.title<>wish.title OR NEW.explanation<>wish.explanation OR wish.state<>'open'))
    OR (NEW.operation='fulfill' AND wish.state<>'fulfilled')
    OR (NEW.operation='reopen' AND wish.state<>'open') THEN
    RAISE EXCEPTION 'invalid_shared_wish_receipt' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_shared_wish_receipt BEFORE INSERT ON shared_wish_commands
  FOR EACH ROW EXECUTE FUNCTION guard_shared_wish_receipt();

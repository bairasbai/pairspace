CREATE FUNCTION valid_stem_text(value text, maximum integer) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT char_length(value) BETWEEN 1 AND maximum

    AND value=normalize(value,NFC)
    AND value=btrim(value,E' \n')

    AND value !~ U&'[\0080-\009F]'
    AND value !~ E'[\\x01-\\x09\\x0B-\\x1F\\x7F]'
$$;
CREATE TABLE stems (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), couple_id uuid NOT NULL REFERENCES couples(id),
 author_id uuid NOT NULL, recipient_id uuid NOT NULL CHECK(recipient_id<>author_id),
 membership_epoch integer NOT NULL CHECK(membership_epoch>0),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 100), version integer NOT NULL CHECK(version BETWEEN 1 AND 4),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)), completed_at timestamptz,
 phase text NOT NULL CHECK(phase IN ('waiting','completed','skipped','withdrawn')),
 author_text_state text NOT NULL CHECK(author_text_state IN ('active','removed')),
 recipient_text_state text NOT NULL CHECK(recipient_text_state IN ('absent','active','removed')),
 beginning text, author_continuation text, recipient_continuation text,
 UNIQUE(couple_id,membership_epoch,sequence), UNIQUE(couple_id,id,membership_epoch),
 FOREIGN KEY(couple_id,author_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,recipient_id) REFERENCES couple_members(couple_id,user_id),
 CHECK((author_text_state='active'
    AND beginning IS NOT NULL
    AND author_continuation IS NOT NULL
    AND valid_stem_text(beginning,500)
    AND valid_stem_text(author_continuation,2000)) OR
  (author_text_state='removed'
    AND beginning IS NULL
    AND author_continuation IS NULL)),
 CHECK((recipient_text_state='active'
    AND recipient_continuation IS NOT NULL
    AND valid_stem_text(recipient_continuation,2000)) OR
  (recipient_text_state<>'active'
    AND recipient_continuation IS NULL)),
 CHECK((phase='completed'
    AND completed_at IS NOT NULL
    AND isfinite(completed_at)
    AND completed_at>=created_at
    AND recipient_text_state<>'absent'

    AND version=2+(author_text_state='removed')::int+(recipient_text_state='removed')::int) OR
  (phase<>'completed'
    AND completed_at IS NULL
    AND recipient_text_state='absent' AND
   ((phase='waiting'
    AND author_text_state='active'
    AND version=1)
    OR (phase='withdrawn'
    AND author_text_state='removed'
    AND version=2) OR
    (phase='skipped'
    AND version=2+(author_text_state='removed')::int))))
);
CREATE FUNCTION guard_stem() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'stem_physical_delete_unsupported' USING ERRCODE='23514';
  END IF;
 PERFORM id FROM couples WHERE id=NEW.couple_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.phase<>'waiting'
    OR NEW.sequence<>(SELECT count(*)+1 FROM stems WHERE couple_id=NEW.couple_id
    AND membership_epoch=NEW.membership_epoch) THEN
    RAISE EXCEPTION 'stem_create_shape' USING ERRCODE='23514';
  END IF;
 ELSE
  IF ROW(NEW.id,NEW.couple_id,NEW.author_id,NEW.recipient_id,NEW.membership_epoch,NEW.sequence,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.couple_id,OLD.author_id,OLD.recipient_id,OLD.membership_epoch,OLD.sequence,OLD.created_at)

    OR NEW.version<>OLD.version+1
    OR (OLD.completed_at IS NOT NULL
    AND NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'stem_identity' USING ERRCODE='23514';
  END IF;
  IF NOT (
   (OLD.phase='waiting'
    AND NEW.phase IN ('completed','skipped')
    AND NEW.author_text_state=OLD.author_text_state
    AND NEW.beginning IS NOT DISTINCT FROM OLD.beginning
    AND NEW.author_continuation IS NOT DISTINCT FROM OLD.author_continuation)

    OR (OLD.author_text_state='active'
    AND NEW.author_text_state='removed'
    AND NEW.beginning IS NULL
    AND NEW.author_continuation IS NULL
    AND NEW.phase=CASE WHEN OLD.phase='waiting' THEN 'withdrawn' ELSE OLD.phase END
    AND NEW.recipient_text_state=OLD.recipient_text_state
    AND NEW.recipient_continuation IS NOT DISTINCT FROM OLD.recipient_continuation)

    OR (OLD.phase='completed'
    AND NEW.phase='completed'
    AND OLD.recipient_text_state='active'
    AND NEW.recipient_text_state='removed'
    AND NEW.recipient_continuation IS NULL
    AND NEW.author_text_state=OLD.author_text_state
    AND NEW.beginning IS NOT DISTINCT FROM OLD.beginning
    AND NEW.author_continuation IS NOT DISTINCT FROM OLD.author_continuation)
  ) THEN
    RAISE EXCEPTION 'stem_transition' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_stem
  BEFORE INSERT OR UPDATE OR DELETE ON stems
  FOR EACH ROW EXECUTE FUNCTION guard_stem();
CREATE TABLE stem_commands (
 actor_user_id uuid NOT NULL,command_id uuid NOT NULL,couple_id uuid NOT NULL,membership_epoch integer NOT NULL,
 round_id uuid NOT NULL,fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(actor_user_id,command_id),FOREIGN KEY(couple_id,actor_user_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,round_id,membership_epoch) REFERENCES stems(couple_id,id,membership_epoch)
);
CREATE TRIGGER immutable_stem_command
  BEFORE UPDATE OR DELETE ON stem_commands
  FOR EACH ROW EXECUTE FUNCTION immutable_shared_date();

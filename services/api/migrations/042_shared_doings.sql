CREATE TABLE shared_doings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), couple_id uuid NOT NULL REFERENCES couples(id),
 author_id uuid NOT NULL, recipient_id uuid NOT NULL CHECK(author_id<>recipient_id),
 membership_epoch integer NOT NULL CHECK(membership_epoch>0),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 100), version integer NOT NULL CHECK(version BETWEEN 1 AND 2004),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
 content_state text NOT NULL CHECK(content_state IN ('active','removed')),
 decision_state text NOT NULL CHECK(decision_state IN ('invited','joined','declined','withdrawn')),
 title text, kind text, parts integer, author_at integer, recipient_at integer,
 UNIQUE(couple_id,membership_epoch,sequence), UNIQUE(couple_id,id,membership_epoch),
 FOREIGN KEY(couple_id,author_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,recipient_id) REFERENCES couple_members(couple_id,user_id),
 CHECK((content_state='active' AND title IS NOT NULL AND char_length(title) BETWEEN 1 AND 200
  AND title=normalize(title,NFC)
  AND title=btrim(title,U&'\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
  AND title !~ U&'[\0080-\009F]' AND title !~ E'[\\x01-\\x1F\\x7F]'
  AND kind IS NOT NULL AND kind IN ('book','series','course','other')
  AND parts IS NOT NULL AND parts BETWEEN 1 AND 1000 AND author_at IS NOT NULL AND author_at BETWEEN 0 AND parts
  AND ((decision_state='joined' AND recipient_at IS NOT NULL AND recipient_at BETWEEN 0 AND parts)
   OR (decision_state IN ('invited','declined') AND recipient_at IS NULL)))
  OR (content_state='removed' AND decision_state IN ('withdrawn','joined','declined')
   AND title IS NULL AND kind IS NULL AND parts IS NULL AND author_at IS NULL AND recipient_at IS NULL))
);
CREATE FUNCTION guard_shared_doing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'shared_doing_physical_delete_unsupported' USING ERRCODE='23514'; END IF;
 PERFORM id FROM couples WHERE id=NEW.couple_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.content_state<>'active' OR NEW.decision_state<>'invited'
   OR NEW.author_at<>0 OR NEW.recipient_at IS NOT NULL
   OR NEW.sequence<>(SELECT count(*)+1 FROM shared_doings WHERE couple_id=NEW.couple_id AND membership_epoch=NEW.membership_epoch)
   THEN RAISE EXCEPTION 'shared_doing_create_shape' USING ERRCODE='23514'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.couple_id,NEW.author_id,NEW.recipient_id,NEW.membership_epoch,NEW.sequence,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.couple_id,OLD.author_id,OLD.recipient_id,OLD.membership_epoch,OLD.sequence,OLD.created_at)
   OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'shared_doing_identity' USING ERRCODE='23514'; END IF;
  IF NOT (
   (OLD.content_state='active' AND NEW.content_state='removed'
    AND NEW.decision_state=CASE WHEN OLD.decision_state='invited' THEN 'withdrawn' ELSE OLD.decision_state END)
   OR (OLD.content_state='active' AND NEW.content_state='active'
    AND ROW(NEW.title,NEW.kind,NEW.parts) IS NOT DISTINCT FROM ROW(OLD.title,OLD.kind,OLD.parts)
    AND ((OLD.decision_state='invited' AND NEW.decision_state='joined'
      AND NEW.author_at=OLD.author_at AND NEW.recipient_at=0)
     OR (OLD.decision_state IN ('invited','joined') AND NEW.decision_state='declined'
      AND NEW.author_at=OLD.author_at AND NEW.recipient_at IS NULL)
     OR (OLD.decision_state IN ('invited','joined') AND NEW.decision_state=OLD.decision_state
      AND ((NEW.author_at>OLD.author_at AND NEW.recipient_at IS NOT DISTINCT FROM OLD.recipient_at)
       OR (OLD.decision_state='joined' AND NEW.recipient_at>OLD.recipient_at AND NEW.author_at=OLD.author_at)))))
  ) THEN RAISE EXCEPTION 'shared_doing_transition' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_shared_doing BEFORE INSERT OR UPDATE OR DELETE ON shared_doings FOR EACH ROW EXECUTE FUNCTION guard_shared_doing();
CREATE TABLE shared_doing_commands (
 actor_user_id uuid NOT NULL, command_id uuid NOT NULL, couple_id uuid NOT NULL, membership_epoch integer NOT NULL,
 doing_id uuid NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(actor_user_id,command_id),
 FOREIGN KEY(couple_id,actor_user_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,doing_id,membership_epoch) REFERENCES shared_doings(couple_id,id,membership_epoch)
);
CREATE FUNCTION immutable_shared_doing_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'shared_doing_command_immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_shared_doing_command BEFORE UPDATE OR DELETE ON shared_doing_commands FOR EACH ROW EXECUTE FUNCTION immutable_shared_doing_command();

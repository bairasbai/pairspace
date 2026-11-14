CREATE TABLE hard_questions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), couple_id uuid NOT NULL REFERENCES couples(id),
 author_id uuid NOT NULL, recipient_id uuid NOT NULL CHECK(author_id<>recipient_id),
 membership_epoch integer NOT NULL CHECK(membership_epoch>0),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 100), version integer NOT NULL CHECK(version>0),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
 content_state text NOT NULL CHECK(content_state IN ('active','removed')),
 decision_state text NOT NULL CHECK(decision_state IN ('sealed','opened','declined','withdrawn')),
 body text, opened_at timestamptz,
 UNIQUE(couple_id,membership_epoch,sequence), UNIQUE(couple_id,id,membership_epoch),
 FOREIGN KEY(couple_id,author_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,recipient_id) REFERENCES couple_members(couple_id,user_id),
 CHECK((content_state='active' AND body IS NOT NULL AND char_length(body) BETWEEN 1 AND 2000
  AND body=normalize(body,NFC)
  AND body=btrim(body,U&'\000A\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
  AND body !~ U&'[\0080-\009F]' AND body !~ E'[\\x01-\\x09\\x0B-\\x1F\\x7F]')
  OR (content_state='removed' AND body IS NULL)),
 CHECK((decision_state='opened' AND opened_at IS NOT NULL AND isfinite(opened_at) AND opened_at>=created_at)
  OR (decision_state<>'opened' AND opened_at IS NULL)),
 CHECK(decision_state<>'sealed' OR content_state='active'),
 CHECK(decision_state<>'withdrawn' OR content_state='removed')
);
CREATE FUNCTION guard_hard_question() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'hard_question_physical_delete_unsupported' USING ERRCODE='23514'; END IF;
 PERFORM id FROM couples WHERE id=NEW.couple_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.content_state<>'active' OR NEW.decision_state<>'sealed'
   OR NEW.sequence<>(SELECT count(*)+1 FROM hard_questions WHERE couple_id=NEW.couple_id AND membership_epoch=NEW.membership_epoch)
   THEN RAISE EXCEPTION 'hard_question_create_shape' USING ERRCODE='23514'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.couple_id,NEW.author_id,NEW.recipient_id,NEW.membership_epoch,NEW.sequence,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.couple_id,OLD.author_id,OLD.recipient_id,OLD.membership_epoch,OLD.sequence,OLD.created_at)
   OR NEW.version<>OLD.version+1 OR (OLD.opened_at IS NOT NULL AND NEW.opened_at IS DISTINCT FROM OLD.opened_at)
   THEN RAISE EXCEPTION 'hard_question_identity' USING ERRCODE='23514'; END IF;
  IF NOT (
   (OLD.content_state='active' AND NEW.content_state='removed' AND NEW.body IS NULL
    AND NEW.decision_state=CASE WHEN OLD.decision_state='sealed' THEN 'withdrawn' ELSE OLD.decision_state END
    AND NEW.opened_at IS NOT DISTINCT FROM OLD.opened_at)
   OR (OLD.content_state='active' AND NEW.content_state='active' AND OLD.decision_state='sealed'
    AND NEW.decision_state IN ('opened','declined') AND NEW.body IS NOT DISTINCT FROM OLD.body)
  ) THEN RAISE EXCEPTION 'hard_question_transition' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_hard_question BEFORE INSERT OR UPDATE OR DELETE ON hard_questions FOR EACH ROW EXECUTE FUNCTION guard_hard_question();
CREATE TABLE hard_question_commands (
 actor_user_id uuid NOT NULL, command_id uuid NOT NULL, couple_id uuid NOT NULL, membership_epoch integer NOT NULL,
 question_id uuid NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(actor_user_id,command_id),
 FOREIGN KEY(couple_id,actor_user_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,question_id,membership_epoch) REFERENCES hard_questions(couple_id,id,membership_epoch)
);
CREATE FUNCTION immutable_hard_question_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'hard_question_command_immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_hard_question_command BEFORE UPDATE OR DELETE ON hard_question_commands FOR EACH ROW EXECUTE FUNCTION immutable_hard_question_command();

CREATE TABLE asks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), couple_id uuid NOT NULL REFERENCES couples(id),
 author_id uuid NOT NULL, recipient_id uuid NOT NULL CHECK(recipient_id<>author_id),
 membership_epoch integer NOT NULL CHECK(membership_epoch>0),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 100), version integer NOT NULL CHECK(version>0),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
 question_state text NOT NULL CHECK(question_state IN ('active','removed')),
 response_state text NOT NULL CHECK(response_state IN ('waiting','answered','skipped','withdrawn','answer_removed')),
 question text, answer text, answered_at timestamptz,
 UNIQUE(couple_id,membership_epoch,sequence), UNIQUE(couple_id,id,membership_epoch),
 FOREIGN KEY(couple_id,author_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,recipient_id) REFERENCES couple_members(couple_id,user_id),
 CHECK((question_state='active' AND question IS NOT NULL AND char_length(question) BETWEEN 1 AND 2000 AND question=normalize(question,NFC) AND question=btrim(question,E' \n') AND question !~ U&'[\0080-\009F]' AND question !~ E'[\\x01-\\x09\\x0B-\\x1F\\x7F]') OR (question_state='removed' AND question IS NULL)),
 CHECK((response_state='answered' AND answer IS NOT NULL AND char_length(answer) BETWEEN 1 AND 2000 AND answer=normalize(answer,NFC) AND answer=btrim(answer,E' \n') AND answer !~ U&'[\0080-\009F]' AND answer !~ E'[\\x01-\\x09\\x0B-\\x1F\\x7F]') OR (response_state<>'answered' AND answer IS NULL)),
 CHECK((response_state IN ('answered','answer_removed') AND answered_at IS NOT NULL AND isfinite(answered_at) AND answered_at>=created_at) OR (response_state NOT IN ('answered','answer_removed') AND answered_at IS NULL)),
 CHECK(response_state<>'waiting' OR question_state='active'),
 CHECK(response_state<>'withdrawn' OR question_state='removed')
);
CREATE FUNCTION guard_ask() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ask_physical_delete_unsupported' USING ERRCODE='23514'; END IF;
 PERFORM id FROM couples WHERE id=NEW.couple_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.question_state<>'active' OR NEW.response_state<>'waiting' OR NEW.sequence<>(SELECT count(*)+1 FROM asks WHERE couple_id=NEW.couple_id AND membership_epoch=NEW.membership_epoch) THEN RAISE EXCEPTION 'ask_create_shape' USING ERRCODE='23514'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.couple_id,NEW.author_id,NEW.recipient_id,NEW.membership_epoch,NEW.sequence,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.couple_id,OLD.author_id,OLD.recipient_id,OLD.membership_epoch,OLD.sequence,OLD.created_at)
   OR NEW.version<>OLD.version+1 OR (OLD.answered_at IS NOT NULL AND NEW.answered_at IS DISTINCT FROM OLD.answered_at) THEN RAISE EXCEPTION 'ask_identity' USING ERRCODE='23514'; END IF;
  IF NOT (
   (OLD.question_state='active' AND NEW.question_state='removed' AND NEW.question IS NULL AND NEW.answer IS NOT DISTINCT FROM OLD.answer AND NEW.response_state=CASE WHEN OLD.response_state='waiting' THEN 'withdrawn' ELSE OLD.response_state END)
   OR (NEW.question_state=OLD.question_state AND NEW.question IS NOT DISTINCT FROM OLD.question AND
    ((OLD.response_state='waiting' AND NEW.response_state IN ('answered','skipped')) OR (OLD.response_state='answered' AND NEW.response_state='answer_removed')))
  ) THEN RAISE EXCEPTION 'ask_transition' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_ask BEFORE INSERT OR UPDATE OR DELETE ON asks FOR EACH ROW EXECUTE FUNCTION guard_ask();
CREATE TABLE ask_commands (
 actor_user_id uuid NOT NULL, command_id uuid NOT NULL, couple_id uuid NOT NULL, membership_epoch integer NOT NULL,
 question_id uuid NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(actor_user_id,command_id),
 FOREIGN KEY(couple_id,actor_user_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,question_id,membership_epoch) REFERENCES asks(couple_id,id,membership_epoch)
);
CREATE TRIGGER immutable_ask_command BEFORE UPDATE OR DELETE ON ask_commands FOR EACH ROW EXECUTE FUNCTION immutable_shared_date();

CREATE TABLE love_words (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), couple_id uuid NOT NULL REFERENCES couples(id),
 author_id uuid NOT NULL, membership_epoch integer NOT NULL CHECK(membership_epoch>0),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 100), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)), state text NOT NULL CHECK(state IN ('active','deleted')),
 word text, meaning text, said_when text, edited boolean,
 UNIQUE(couple_id,membership_epoch,sequence), UNIQUE(couple_id,id,membership_epoch),
 FOREIGN KEY(couple_id,author_id) REFERENCES couple_members(couple_id,user_id),
 CHECK((state='deleted' AND word IS NULL AND meaning IS NULL AND said_when IS NULL AND edited IS NULL) OR
 (state='active' AND word IS NOT NULL AND meaning IS NOT NULL AND said_when IS NOT NULL AND edited IS NOT NULL
 AND char_length(word) BETWEEN 1 AND 120 AND word=normalize(word,NFC) AND word=btrim(word) AND word !~ '[[:cntrl:]]' AND word !~ '  '
 AND char_length(meaning)<=1000 AND meaning=normalize(meaning,NFC) AND meaning=btrim(meaning,E' \n') AND meaning !~ E'[\\x01-\\x09\\x0B-\\x1F\\x7F]'
 AND char_length(said_when)<=1000 AND said_when=normalize(said_when,NFC) AND said_when=btrim(said_when,E' \n') AND said_when !~ E'[\\x01-\\x09\\x0B-\\x1F\\x7F]'))
);
CREATE FUNCTION guard_love_word() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'word_physical_delete_unsupported' USING ERRCODE='23514'; END IF;
 PERFORM id FROM couples WHERE id=NEW.couple_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.state<>'active' OR NEW.edited OR NEW.sequence<>(SELECT count(*)+1 FROM love_words WHERE couple_id=NEW.couple_id AND membership_epoch=NEW.membership_epoch) THEN RAISE EXCEPTION 'word_create_shape' USING ERRCODE='23514'; END IF;
 ELSE
  IF OLD.state='deleted' OR ROW(NEW.id,NEW.couple_id,NEW.author_id,NEW.membership_epoch,NEW.sequence,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.couple_id,OLD.author_id,OLD.membership_epoch,OLD.sequence,OLD.created_at)
   OR NEW.version<>OLD.version+1 OR (NEW.state='active' AND NOT NEW.edited) THEN RAISE EXCEPTION 'word_identity' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_love_word BEFORE INSERT OR UPDATE OR DELETE ON love_words FOR EACH ROW EXECUTE FUNCTION guard_love_word();
CREATE TABLE love_word_commands (
 actor_user_id uuid NOT NULL, command_id uuid NOT NULL, couple_id uuid NOT NULL, membership_epoch integer NOT NULL,
 word_id uuid NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(actor_user_id,command_id),
 FOREIGN KEY(couple_id,actor_user_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,word_id,membership_epoch) REFERENCES love_words(couple_id,id,membership_epoch)
);
CREATE TRIGGER immutable_love_word_command BEFORE UPDATE OR DELETE ON love_word_commands FOR EACH ROW EXECUTE FUNCTION immutable_shared_date();

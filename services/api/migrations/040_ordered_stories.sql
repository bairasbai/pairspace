CREATE TABLE ordered_stories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), couple_id uuid NOT NULL REFERENCES couples(id),
 topic_author_id uuid NOT NULL, story_author_id uuid NOT NULL CHECK(story_author_id<>topic_author_id),
 membership_epoch integer NOT NULL CHECK(membership_epoch>0),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 100), version integer NOT NULL CHECK(version>0),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
 topic_state text NOT NULL CHECK(topic_state IN ('active','removed')),
 story_state text NOT NULL CHECK(story_state IN ('waiting','told','declined','withdrawn','story_removed')),
 topic text, body text, told_at timestamptz,
 UNIQUE(couple_id,membership_epoch,sequence), UNIQUE(couple_id,id,membership_epoch),
 FOREIGN KEY(couple_id,topic_author_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,story_author_id) REFERENCES couple_members(couple_id,user_id),
 CHECK((topic_state='active' AND topic IS NOT NULL AND char_length(topic) BETWEEN 1 AND 300
  AND topic=normalize(topic,NFC) AND topic=btrim(topic,E' \n') AND topic !~ U&'[\0080-\009F]'
  AND topic !~ E'[\\x01-\\x09\\x0B-\\x1F\\x7F]') OR (topic_state='removed' AND topic IS NULL)),
 CHECK((story_state='told' AND body IS NOT NULL AND char_length(body) BETWEEN 1 AND 8000
  AND body=normalize(body,NFC) AND body=btrim(body,E' \n') AND body !~ U&'[\0080-\009F]'
  AND body !~ E'[\\x01-\\x09\\x0B-\\x1F\\x7F]') OR (story_state<>'told' AND body IS NULL)),
 CHECK((story_state IN ('told','story_removed') AND told_at IS NOT NULL AND isfinite(told_at) AND told_at>=created_at)
  OR (story_state NOT IN ('told','story_removed') AND told_at IS NULL)),
 CHECK(story_state<>'waiting' OR topic_state='active'),
 CHECK(story_state<>'withdrawn' OR topic_state='removed')
);
CREATE FUNCTION guard_ordered_story() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'story_physical_delete_unsupported' USING ERRCODE='23514'; END IF;
 PERFORM id FROM couples WHERE id=NEW.couple_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.topic_state<>'active' OR NEW.story_state<>'waiting'
   OR NEW.sequence<>(SELECT count(*)+1 FROM ordered_stories WHERE couple_id=NEW.couple_id AND membership_epoch=NEW.membership_epoch)
   THEN RAISE EXCEPTION 'story_create_shape' USING ERRCODE='23514'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.couple_id,NEW.topic_author_id,NEW.story_author_id,NEW.membership_epoch,NEW.sequence,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.couple_id,OLD.topic_author_id,OLD.story_author_id,OLD.membership_epoch,OLD.sequence,OLD.created_at)
   OR NEW.version<>OLD.version+1 OR (OLD.told_at IS NOT NULL AND NEW.told_at IS DISTINCT FROM OLD.told_at)
   THEN RAISE EXCEPTION 'story_identity' USING ERRCODE='23514'; END IF;
  IF NOT (
   (OLD.topic_state='active' AND NEW.topic_state='removed' AND NEW.topic IS NULL AND NEW.body IS NOT DISTINCT FROM OLD.body
    AND NEW.story_state=CASE WHEN OLD.story_state='waiting' THEN 'withdrawn' ELSE OLD.story_state END)
   OR (NEW.topic_state=OLD.topic_state AND NEW.topic IS NOT DISTINCT FROM OLD.topic AND
    ((OLD.story_state='waiting' AND NEW.story_state IN ('told','declined')) OR (OLD.story_state='told' AND NEW.story_state='story_removed')))
  ) THEN RAISE EXCEPTION 'story_transition' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_ordered_story BEFORE INSERT OR UPDATE OR DELETE ON ordered_stories FOR EACH ROW EXECUTE FUNCTION guard_ordered_story();
CREATE TABLE story_commands (
 actor_user_id uuid NOT NULL, command_id uuid NOT NULL, couple_id uuid NOT NULL, membership_epoch integer NOT NULL,
 story_id uuid NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(actor_user_id,command_id),
 FOREIGN KEY(couple_id,actor_user_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,story_id,membership_epoch) REFERENCES ordered_stories(couple_id,id,membership_epoch)
);
CREATE FUNCTION immutable_story_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'story_command_immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_story_command BEFORE UPDATE OR DELETE ON story_commands FOR EACH ROW EXECUTE FUNCTION immutable_story_command();

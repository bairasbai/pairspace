-- Preserve immutable original create snapshots before making song content editable.
ALTER TABLE shared_songs ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0),
  ADD CONSTRAINT shared_songs_scope_identity UNIQUE(couple_id,id,membership_epoch);
CREATE TABLE shared_song_commands (
  actor_user_id uuid NOT NULL,
  command_id uuid NOT NULL,
  couple_id uuid NOT NULL,
  membership_epoch integer NOT NULL CHECK(membership_epoch>0),
  song_id uuid NOT NULL,
  title text NOT NULL,
  explanation text NOT NULL,
  music_url text,
  operation text NOT NULL CHECK(operation IN ('create','edit')),
  expected_version integer,
  PRIMARY KEY(actor_user_id,command_id),
  CHECK((operation='create' AND expected_version IS NULL) OR
    (operation='edit' AND expected_version IS NOT NULL AND expected_version BETWEEN 1 AND 2147483646)),
  FOREIGN KEY(couple_id,actor_user_id) REFERENCES couple_members(couple_id,user_id),
  FOREIGN KEY(couple_id,song_id,membership_epoch) REFERENCES shared_songs(couple_id,id,membership_epoch)
);
INSERT INTO shared_song_commands(actor_user_id,command_id,couple_id,membership_epoch,song_id,title,explanation,music_url,operation)
  SELECT creator_id,command_id,couple_id,membership_epoch,id,title,explanation,music_url,'create' FROM shared_songs;
CREATE TRIGGER immutable_shared_song_command BEFORE UPDATE OR DELETE ON shared_song_commands
  FOR EACH ROW EXECUTE FUNCTION immutable_shared_song();
DROP TRIGGER immutable_shared_song ON shared_songs;
CREATE FUNCTION guard_shared_song_edit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable_shared_song' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.id,NEW.couple_id,NEW.creator_id,NEW.membership_epoch,NEW.command_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.couple_id,OLD.creator_id,OLD.membership_epoch,OLD.command_id,OLD.created_at)
    OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'invalid_shared_song_edit' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_shared_song_edit BEFORE UPDATE OR DELETE ON shared_songs
  FOR EACH ROW EXECUTE FUNCTION guard_shared_song_edit();
CREATE FUNCTION guard_shared_song_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM shared_songs s WHERE s.couple_id=NEW.couple_id AND s.id=NEW.song_id
    AND s.membership_epoch=NEW.membership_epoch AND s.creator_id=NEW.actor_user_id
    AND s.title=NEW.title AND s.explanation=NEW.explanation AND s.music_url IS NOT DISTINCT FROM NEW.music_url
    AND ((NEW.operation='create' AND s.version=1 AND s.command_id=NEW.command_id)
      OR (NEW.operation='edit' AND s.version=NEW.expected_version+1))) THEN
    RAISE EXCEPTION 'invalid_shared_song_receipt' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_shared_song_receipt BEFORE INSERT ON shared_song_commands
  FOR EACH ROW EXECUTE FUNCTION guard_shared_song_receipt();

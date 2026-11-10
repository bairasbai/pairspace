-- Synthetic-only shared tasks. Titles stay private to the current active pair.
CREATE TABLE shared_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id uuid NOT NULL REFERENCES couples(id),
  creator_id uuid NOT NULL,
  membership_epoch integer NOT NULL CHECK (membership_epoch > 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND octet_length(title) <= 800
    AND title = normalize(title, NFC) AND title = btrim(title) AND title !~ '[[:cntrl:]]' AND title !~ '  '),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','completed')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
  updated_at timestamptz NOT NULL CHECK (isfinite(updated_at) AND updated_at=date_trunc('milliseconds',updated_at) AND updated_at>=created_at),
  UNIQUE (couple_id, id),
  FOREIGN KEY (couple_id,creator_id) REFERENCES couple_members(couple_id,user_id)
);
CREATE INDEX shared_tasks_latest ON shared_tasks(couple_id,membership_epoch,created_at DESC,id DESC);
CREATE TABLE shared_task_commands (
  actor_user_id uuid NOT NULL,
  command_id uuid NOT NULL,
  couple_id uuid NOT NULL,
  membership_epoch integer NOT NULL CHECK (membership_epoch > 0),
  task_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('create','complete','reopen')),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  title text,
  applied_version integer NOT NULL CHECK (applied_version > 0),
  PRIMARY KEY (actor_user_id,command_id),
  FOREIGN KEY (couple_id,actor_user_id) REFERENCES couple_members(couple_id,user_id),
  FOREIGN KEY (couple_id,task_id) REFERENCES shared_tasks(couple_id,id),
  CHECK ((operation='create' AND expected_version=0 AND applied_version=1 AND title IS NOT NULL)
    OR (operation<>'create' AND expected_version>0 AND applied_version=expected_version+1 AND title IS NULL))
);
CREATE FUNCTION immutable_shared_task_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_shared_task_command' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER immutable_shared_task_command BEFORE UPDATE OR DELETE ON shared_task_commands
  FOR EACH ROW EXECUTE FUNCTION immutable_shared_task_command();
CREATE FUNCTION guard_shared_task_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.couple_id<>OLD.couple_id OR NEW.creator_id<>OLD.creator_id
    OR NEW.membership_epoch<>OLD.membership_epoch OR NEW.title<>OLD.title OR NEW.created_at<>OLD.created_at
    OR NEW.updated_at<OLD.updated_at OR NEW.version<>OLD.version+1 OR NEW.state=OLD.state THEN
    RAISE EXCEPTION 'invalid_shared_task_change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_shared_task_change BEFORE UPDATE ON shared_tasks
  FOR EACH ROW EXECUTE FUNCTION guard_shared_task_change();

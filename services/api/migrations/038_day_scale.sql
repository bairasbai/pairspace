CREATE TABLE day_scale (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id uuid NOT NULL REFERENCES couples(id),
  author_id uuid NOT NULL,
  membership_epoch integer NOT NULL CHECK(membership_epoch > 0),
  local_date text NOT NULL CHECK(
    valid_shared_local_date(local_date)
    AND local_date >= '2000-01-01'
    AND local_date <= '2100-12-31'
  ),
  timezone text NOT NULL CHECK(char_length(timezone) BETWEEN 1 AND 100),
  version integer NOT NULL CHECK(version > 0),
  created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
  state text NOT NULL CHECK(state IN ('active', 'removed')),
  value integer,
  CHECK(
    (state = 'active' AND value IS NOT NULL AND value BETWEEN 0 AND 100)
    OR (state = 'removed' AND value IS NULL)
  ),
  UNIQUE(couple_id, membership_epoch, author_id, local_date),
  UNIQUE(couple_id, id, membership_epoch),
  FOREIGN KEY(couple_id, author_id) REFERENCES couple_members(couple_id, user_id)
);

CREATE FUNCTION guard_day_scale() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'scale_physical_delete_unsupported' USING ERRCODE = '23514';
  END IF;

  PERFORM id FROM couples WHERE id = NEW.couple_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'scale_timezone' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1
      OR NEW.state <> 'active'
      OR (
        SELECT count(*) FROM day_scale
        WHERE couple_id = NEW.couple_id
          AND membership_epoch = NEW.membership_epoch
          AND author_id = NEW.author_id
      ) >= 100
    THEN
      RAISE EXCEPTION 'scale_create_shape' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(
      NEW.id, NEW.couple_id, NEW.author_id, NEW.membership_epoch,
      NEW.local_date, NEW.timezone, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.id, OLD.couple_id, OLD.author_id, OLD.membership_epoch,
      OLD.local_date, OLD.timezone, OLD.created_at
    )
      OR NEW.version <> OLD.version + 1
      OR ROW(NEW.state, NEW.value) IS NOT DISTINCT FROM ROW(OLD.state, OLD.value)
    THEN
      RAISE EXCEPTION 'scale_identity_or_noop' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER guard_day_scale
  BEFORE INSERT OR UPDATE OR DELETE ON day_scale
  FOR EACH ROW EXECUTE FUNCTION guard_day_scale();

CREATE TABLE day_scale_commands (
  actor_user_id uuid NOT NULL,
  command_id uuid NOT NULL,
  couple_id uuid NOT NULL,
  membership_epoch integer NOT NULL,
  slot_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY(actor_user_id, command_id),
  FOREIGN KEY(couple_id, actor_user_id) REFERENCES couple_members(couple_id, user_id),
  FOREIGN KEY(couple_id, slot_id, membership_epoch)
    REFERENCES day_scale(couple_id, id, membership_epoch)
);

CREATE TRIGGER immutable_day_scale_command
  BEFORE UPDATE OR DELETE ON day_scale_commands
  FOR EACH ROW EXECUTE FUNCTION immutable_shared_date();

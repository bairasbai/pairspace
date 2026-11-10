-- Synthetic-only closure receipts; no deletion or production archive-access policy.
CREATE TABLE pair_leave_commands (
  actor_user_id uuid NOT NULL,
  command_id uuid NOT NULL,
  couple_id uuid NOT NULL,
  membership_epoch integer NOT NULL CHECK (membership_epoch > 0 AND membership_epoch < 2147483647),
  -- Exact original couple.closed event time, including delayed/legacy acknowledgements.
  closed_at timestamptz NOT NULL CHECK (isfinite(closed_at)),
  PRIMARY KEY (actor_user_id, command_id),
  FOREIGN KEY (couple_id, actor_user_id) REFERENCES couple_members(couple_id,user_id)
);
-- Receipt rows are append-only. An old confirmation can never be repointed to a new pair.
CREATE FUNCTION immutable_pair_leave_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_pair_leave_receipt' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER immutable_pair_leave_receipt BEFORE UPDATE OR DELETE ON pair_leave_commands
  FOR EACH ROW EXECUTE FUNCTION immutable_pair_leave_receipt();

CREATE FUNCTION enforce_closed_pair_size() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; old_target uuid;
BEGIN
  IF TG_TABLE_NAME = 'couples' THEN target := NEW.id; old_target := OLD.id;
  ELSE target := NEW.couple_id; old_target := OLD.couple_id;
  END IF;
  IF EXISTS (SELECT 1 FROM couples c JOIN couple_members m ON m.couple_id=c.id
    WHERE c.status='closed' AND m.status='active'
      AND (c.id=target OR c.id=old_target)) THEN
    RAISE EXCEPTION 'closed_pair_has_active_members' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER closed_pair_size_on_couple AFTER INSERT OR UPDATE ON couples
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_closed_pair_size();
CREATE CONSTRAINT TRIGGER closed_pair_size_on_members AFTER INSERT OR UPDATE OR DELETE ON couple_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_closed_pair_size();

CREATE FUNCTION prevent_pair_reopening() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='closed' AND (NEW.status<>OLD.status OR NEW.membership_epoch<>OLD.membership_epoch) THEN
    RAISE EXCEPTION 'closed_pair_is_final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER prevent_pair_reopening BEFORE UPDATE ON couples
  FOR EACH ROW EXECUTE FUNCTION prevent_pair_reopening();

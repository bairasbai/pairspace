-- Forward-only extension: existing immutable records and receipts remain unchanged.
ALTER TABLE blind_rounds DROP CONSTRAINT blind_rounds_couple_id_membership_epoch_key;
ALTER TABLE blind_rounds DROP CONSTRAINT blind_rounds_question_id_check;
ALTER TABLE blind_rounds ADD CONSTRAINT blind_rounds_question_id_check
  CHECK (question_id IN ('small-joy','shared-plan','kind-memory'));
ALTER TABLE blind_rounds ADD COLUMN predecessor_round_id uuid REFERENCES blind_rounds(id);
CREATE UNIQUE INDEX blind_initial_round ON blind_rounds(couple_id,membership_epoch)
  WHERE predecessor_round_id IS NULL;
CREATE UNIQUE INDEX blind_successor_round ON blind_rounds(predecessor_round_id)
  WHERE predecessor_round_id IS NOT NULL;
ALTER TABLE blind_commands DROP CONSTRAINT blind_commands_operation_check;
ALTER TABLE blind_commands ADD CONSTRAINT blind_commands_operation_check CHECK (operation IN ('open','answer','next'));
CREATE FUNCTION guard_blind_round_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pair couples%ROWTYPE; previous blind_rounds%ROWTYPE; active_ids uuid[];
BEGIN
  SELECT * INTO pair FROM couples WHERE id=NEW.couple_id FOR UPDATE;
  SELECT array_agg(user_id ORDER BY user_id) INTO active_ids FROM couple_members
    WHERE couple_id=NEW.couple_id AND status='active';
  IF pair.status IS DISTINCT FROM 'active' OR pair.membership_epoch IS DISTINCT FROM NEW.membership_epoch
    OR active_ids IS DISTINCT FROM ARRAY[NEW.participant_one,NEW.participant_two] THEN
    RAISE EXCEPTION 'invalid_blind_snapshot' USING ERRCODE='23514';
  END IF;
  SELECT r.* INTO previous FROM blind_rounds r WHERE r.couple_id=NEW.couple_id
    AND r.membership_epoch=NEW.membership_epoch
    AND NOT EXISTS (SELECT 1 FROM blind_rounds child WHERE child.predecessor_round_id=r.id);
  IF NEW.predecessor_round_id IS DISTINCT FROM previous.id THEN
    RAISE EXCEPTION 'invalid_blind_predecessor' USING ERRCODE='23514';
  END IF;
  IF previous.id IS NOT NULL AND (previous.participant_one<>NEW.participant_one
    OR previous.participant_two<>NEW.participant_two
    OR (SELECT count(*) FROM blind_answers WHERE round_id=previous.id
      AND author_id IN (previous.participant_one,previous.participant_two))<>2) THEN
    RAISE EXCEPTION 'incomplete_blind_predecessor' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_blind_round BEFORE INSERT ON blind_rounds
  FOR EACH ROW EXECUTE FUNCTION guard_blind_round_chain();

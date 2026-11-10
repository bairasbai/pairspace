-- One immutable synthetic conversation round per pair epoch. No history or automatic rounds.
CREATE TABLE blind_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id uuid NOT NULL REFERENCES couples(id),
  membership_epoch integer NOT NULL CHECK (membership_epoch > 0),
  question_id text NOT NULL CHECK (question_id='small-joy'),
  catalog_version integer NOT NULL CHECK (catalog_version=1),
  participant_one uuid NOT NULL,
  participant_two uuid NOT NULL,
  CHECK (participant_one < participant_two),
  UNIQUE(couple_id,membership_epoch),
  UNIQUE(couple_id,id),
  FOREIGN KEY(couple_id,participant_one) REFERENCES couple_members(couple_id,user_id),
  FOREIGN KEY(couple_id,participant_two) REFERENCES couple_members(couple_id,user_id)
);
CREATE TABLE blind_answers (
  round_id uuid NOT NULL REFERENCES blind_rounds(id),
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000 AND octet_length(body)<=4000
    AND body=normalize(body,NFC) AND body=btrim(body) AND body !~ '[[:cntrl:]]' AND body !~ '  '),
  PRIMARY KEY(round_id,author_id)
);
CREATE TABLE blind_commands (
  actor_user_id uuid NOT NULL REFERENCES users(id),
  command_id uuid NOT NULL,
  round_id uuid NOT NULL REFERENCES blind_rounds(id),
  operation text NOT NULL CHECK (operation IN ('open','answer')),
  PRIMARY KEY(actor_user_id,command_id)
);
CREATE FUNCTION immutable_blind_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_blind_record' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER immutable_blind_round BEFORE UPDATE OR DELETE ON blind_rounds
  FOR EACH ROW EXECUTE FUNCTION immutable_blind_record();
CREATE TRIGGER immutable_blind_answer BEFORE UPDATE OR DELETE ON blind_answers
  FOR EACH ROW EXECUTE FUNCTION immutable_blind_record();
CREATE TRIGGER immutable_blind_command BEFORE UPDATE OR DELETE ON blind_commands
  FOR EACH ROW EXECUTE FUNCTION immutable_blind_record();
CREATE FUNCTION guard_blind_participant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor uuid;
BEGIN
  IF TG_TABLE_NAME='blind_answers' THEN actor=NEW.author_id; ELSE actor=NEW.actor_user_id; END IF;
  IF NOT EXISTS(SELECT 1 FROM blind_rounds WHERE id=NEW.round_id AND actor IN (participant_one,participant_two)) THEN
    RAISE EXCEPTION 'invalid_blind_participant' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_blind_answer BEFORE INSERT ON blind_answers
  FOR EACH ROW EXECUTE FUNCTION guard_blind_participant();
CREATE TRIGGER guard_blind_command BEFORE INSERT ON blind_commands
  FOR EACH ROW EXECUTE FUNCTION guard_blind_participant();

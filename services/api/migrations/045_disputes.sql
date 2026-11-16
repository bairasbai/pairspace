-- A voluntary non-financial conversation, not a payment, debt or enforceable wager.
CREATE FUNCTION valid_dispute_text(value text, maximum integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT value IS NOT NULL AND char_length(value) BETWEEN 1 AND maximum
  AND value=normalize(value,NFC)
  AND value=btrim(value,U&'\000A\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
  AND value !~ U&'[\0080-\009F]' AND value !~ E'[\\x01-\\x09\\x0B-\\x1F\\x7F]'
$$;
CREATE TABLE disputes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), couple_id uuid NOT NULL REFERENCES couples(id),
 author_id uuid NOT NULL, recipient_id uuid NOT NULL CHECK(author_id<>recipient_id),
 membership_epoch integer NOT NULL CHECK(membership_epoch BETWEEN 1 AND 2147483646),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 100), version integer NOT NULL,
 created_at timestamptz NOT NULL CHECK(isfinite(created_at) AND date_trunc('milliseconds',created_at)=created_at),
 judge_date date NOT NULL CHECK(judge_date BETWEEN '2000-01-01' AND '2100-12-31'),
 timezone text NOT NULL CHECK(char_length(timezone) BETWEEN 1 AND 100),
 content_state text NOT NULL CHECK(content_state IN ('active','removed')), claim text, condition text,
 joined_at timestamptz, declined_at timestamptz, resolved_at timestamptz, removed_at timestamptz,
 resolved_by uuid, winner_id uuid,
 UNIQUE(couple_id,membership_epoch,sequence), UNIQUE(couple_id,id,membership_epoch),
 FOREIGN KEY(couple_id,author_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,recipient_id) REFERENCES couple_members(couple_id,user_id),
 CHECK(judge_date>(created_at AT TIME ZONE timezone)::date),
 CHECK(joined_at IS NULL OR (isfinite(joined_at) AND joined_at>=created_at AND date_trunc('milliseconds',joined_at)=joined_at AND (joined_at AT TIME ZONE timezone)::date<judge_date)),
 CHECK(declined_at IS NULL OR (isfinite(declined_at) AND declined_at>=COALESCE(joined_at,created_at) AND date_trunc('milliseconds',declined_at)=declined_at AND resolved_at IS NULL)),
 CHECK(resolved_at IS NULL OR (isfinite(resolved_at) AND joined_at IS NOT NULL AND resolved_at>=joined_at AND date_trunc('milliseconds',resolved_at)=resolved_at AND (resolved_at AT TIME ZONE timezone)::date>=judge_date)),
 CHECK((resolved_at IS NULL AND resolved_by IS NULL AND winner_id IS NULL)
  OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolved_by IN (author_id,recipient_id) AND (winner_id IS NULL OR winner_id IN (author_id,recipient_id)))),
 CHECK(removed_at IS NULL OR (isfinite(removed_at) AND removed_at>=GREATEST(created_at,joined_at,declined_at,resolved_at) AND date_trunc('milliseconds',removed_at)=removed_at)),
 CHECK((content_state='removed')=(removed_at IS NOT NULL)),
 CHECK(version=1+(joined_at IS NOT NULL)::int+(declined_at IS NOT NULL)::int+(resolved_at IS NOT NULL)::int+(removed_at IS NOT NULL)::int),
 CHECK((content_state='active' AND valid_dispute_text(claim,2000) AND (condition IS NULL OR valid_dispute_text(condition,500)))
  OR (content_state='removed' AND claim IS NULL AND condition IS NULL))
);
CREATE FUNCTION guard_dispute() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'dispute_physical_delete_unsupported' USING ERRCODE='23514'; END IF;
 PERFORM id FROM couples WHERE id=NEW.couple_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.content_state<>'active' OR NEW.joined_at IS NOT NULL OR NEW.declined_at IS NOT NULL
   OR NEW.resolved_at IS NOT NULL OR NEW.removed_at IS NOT NULL
   OR NEW.sequence<>(SELECT count(*)+1 FROM disputes WHERE couple_id=NEW.couple_id AND membership_epoch=NEW.membership_epoch)
   THEN RAISE EXCEPTION 'dispute_create_shape' USING ERRCODE='23514'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.couple_id,NEW.author_id,NEW.recipient_id,NEW.membership_epoch,NEW.sequence,NEW.created_at,NEW.judge_date,NEW.timezone)
   IS DISTINCT FROM ROW(OLD.id,OLD.couple_id,OLD.author_id,OLD.recipient_id,OLD.membership_epoch,OLD.sequence,OLD.created_at,OLD.judge_date,OLD.timezone)
   OR NEW.version<>OLD.version+1 OR OLD.content_state='removed'
   THEN RAISE EXCEPTION 'dispute_identity' USING ERRCODE='23514'; END IF;
  -- Exactly one new event; retain every previous event and any recorded outcome.
  IF (OLD.joined_at IS NOT NULL AND NEW.joined_at IS DISTINCT FROM OLD.joined_at)
   OR (OLD.declined_at IS NOT NULL AND NEW.declined_at IS DISTINCT FROM OLD.declined_at)
   OR (OLD.resolved_at IS NOT NULL AND ROW(NEW.resolved_at,NEW.resolved_by,NEW.winner_id) IS DISTINCT FROM ROW(OLD.resolved_at,OLD.resolved_by,OLD.winner_id))
   OR ((OLD.declined_at IS NOT NULL OR OLD.resolved_at IS NOT NULL) AND NEW.joined_at IS DISTINCT FROM OLD.joined_at)
   THEN RAISE EXCEPTION 'dispute_history' USING ERRCODE='23514'; END IF;
  IF NEW.content_state='removed' THEN
   IF ROW(NEW.joined_at,NEW.declined_at,NEW.resolved_at,NEW.resolved_by,NEW.winner_id)
    IS DISTINCT FROM ROW(OLD.joined_at,OLD.declined_at,OLD.resolved_at,OLD.resolved_by,OLD.winner_id)
    THEN RAISE EXCEPTION 'dispute_removal_history' USING ERRCODE='23514'; END IF;
  ELSE
   IF ROW(NEW.claim,NEW.condition) IS DISTINCT FROM ROW(OLD.claim,OLD.condition)
    OR (NEW.joined_at IS DISTINCT FROM OLD.joined_at AND NEW.joined_at<GREATEST(OLD.created_at,OLD.joined_at,OLD.declined_at,OLD.resolved_at))
    OR (NEW.declined_at IS DISTINCT FROM OLD.declined_at AND NEW.declined_at<GREATEST(OLD.created_at,OLD.joined_at,OLD.declined_at,OLD.resolved_at))
    OR (NEW.resolved_at IS DISTINCT FROM OLD.resolved_at AND NEW.resolved_at<GREATEST(OLD.created_at,OLD.joined_at,OLD.declined_at,OLD.resolved_at))
    THEN RAISE EXCEPTION 'dispute_transition' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_dispute BEFORE INSERT OR UPDATE OR DELETE ON disputes FOR EACH ROW EXECUTE FUNCTION guard_dispute();
CREATE TABLE dispute_commands (
 actor_user_id uuid NOT NULL, command_id uuid NOT NULL, couple_id uuid NOT NULL, membership_epoch integer NOT NULL,
 dispute_id uuid NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 operation text NOT NULL CHECK(operation IN ('create','join','decline','resolve','remove')),
 expected_version integer, applied jsonb NOT NULL,
 PRIMARY KEY(actor_user_id,command_id),
 FOREIGN KEY(couple_id,actor_user_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,dispute_id,membership_epoch) REFERENCES disputes(couple_id,id,membership_epoch)
);
CREATE FUNCTION guard_dispute_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record; snapshot jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'dispute_command_immutable' USING ERRCODE='23514'; END IF;
 -- Explicit metadata projection: receipt validation never loads claim or condition.
 SELECT id,couple_id,author_id,recipient_id,membership_epoch,version,created_at,judge_date,timezone,
  content_state,joined_at,declined_at,resolved_at,resolved_by,winner_id,removed_at
 INTO p FROM disputes WHERE id=NEW.dispute_id AND couple_id=NEW.couple_id AND membership_epoch=NEW.membership_epoch;
 IF NOT FOUND THEN RAISE EXCEPTION 'dispute_command_scope' USING ERRCODE='23514'; END IF;
 snapshot:=jsonb_build_object('id',p.id,'coupleId',p.couple_id,'authorId',p.author_id,'recipientId',p.recipient_id,
  'membershipEpoch',p.membership_epoch,'version',p.version,'createdAt',to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'judgeDate',p.judge_date::text,'timezone',p.timezone,'contentState',p.content_state,
  'decisionState',CASE WHEN p.resolved_at IS NOT NULL THEN 'resolved' WHEN p.declined_at IS NOT NULL THEN 'declined' WHEN p.joined_at IS NOT NULL THEN 'joined' ELSE 'invited' END,
  'joinedAt',to_char(p.joined_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'declinedAt',to_char(p.declined_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'resolvedAt',to_char(p.resolved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'removedAt',to_char(p.removed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'resolvedBy',p.resolved_by,'winnerId',p.winner_id);
 IF NEW.applied IS DISTINCT FROM snapshot OR (
  (NEW.operation='create' AND NEW.actor_user_id=p.author_id AND NEW.expected_version IS NULL AND p.version=1)
  OR (NEW.operation='remove' AND NEW.actor_user_id=p.author_id AND NEW.expected_version BETWEEN 1 AND 3 AND p.version=NEW.expected_version+1 AND p.content_state='removed')
  OR (NEW.operation='join' AND NEW.actor_user_id=p.recipient_id AND NEW.expected_version=1 AND p.version=2 AND p.content_state='active' AND p.joined_at IS NOT NULL AND p.declined_at IS NULL AND p.resolved_at IS NULL)
  OR (NEW.operation='decline' AND NEW.actor_user_id=p.recipient_id AND NEW.expected_version BETWEEN 1 AND 2 AND p.version=NEW.expected_version+1 AND p.content_state='active' AND p.declined_at IS NOT NULL)
  OR (NEW.operation='resolve' AND NEW.actor_user_id=p.resolved_by AND NEW.expected_version=2 AND p.version=3 AND p.content_state='active' AND p.resolved_at IS NOT NULL)
 ) IS NOT TRUE THEN RAISE EXCEPTION 'dispute_command_result' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_dispute_command BEFORE INSERT OR UPDATE OR DELETE ON dispute_commands FOR EACH ROW EXECUTE FUNCTION guard_dispute_command();

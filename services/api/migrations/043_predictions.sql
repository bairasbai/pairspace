CREATE TABLE predictions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), couple_id uuid NOT NULL REFERENCES couples(id),
 author_id uuid NOT NULL, recipient_id uuid NOT NULL CHECK(author_id<>recipient_id),
 membership_epoch integer NOT NULL CHECK(membership_epoch BETWEEN 1 AND 2147483646),
 sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 100), version integer NOT NULL,
 created_at timestamptz NOT NULL CHECK(isfinite(created_at) AND date_trunc('milliseconds',created_at)=created_at),
 release_at timestamptz NOT NULL CHECK(isfinite(release_at) AND release_at>created_at AND date_trunc('milliseconds',release_at)=release_at),
 timezone text NOT NULL CHECK(char_length(timezone) BETWEEN 1 AND 100),
 local_date date NOT NULL CHECK(local_date BETWEEN '2000-01-01' AND '2100-12-31'),
 local_time text NOT NULL CHECK(local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 utc_offset text NOT NULL CHECK(utc_offset ~ '^[+-]((0[0-9]|1[0-3]):[0-5][0-9]|14:00)$' AND utc_offset<>'-00:00'),
 content_state text NOT NULL CHECK(content_state IN ('active','removed')), body text,
 opened_at timestamptz, declined_at timestamptz,
 UNIQUE(couple_id,membership_epoch,sequence), UNIQUE(couple_id,id,membership_epoch),
 FOREIGN KEY(couple_id,author_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,recipient_id) REFERENCES couple_members(couple_id,user_id),
 CHECK(local_date>(created_at AT TIME ZONE timezone)::date),
 CHECK(release_at AT TIME ZONE timezone=local_date+local_time::time),
 CHECK(release_at=(local_date+local_time::time) AT TIME ZONE utc_offset::interval),
 CHECK(opened_at IS NULL OR (isfinite(opened_at) AND opened_at>=release_at AND date_trunc('milliseconds',opened_at)=opened_at)),
 CHECK(declined_at IS NULL OR (isfinite(declined_at) AND declined_at>=created_at AND date_trunc('milliseconds',declined_at)=declined_at)),
 CHECK(opened_at IS NULL OR declined_at IS NULL),
 CHECK(version=1+(opened_at IS NOT NULL OR declined_at IS NOT NULL)::int+(content_state='removed')::int),
 CHECK((content_state='active' AND body IS NOT NULL AND char_length(body) BETWEEN 1 AND 2000
  AND body=normalize(body,NFC)
  AND body=btrim(body,U&'\000A\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
  AND body !~ U&'[\0080-\009F]' AND body !~ E'[\\x01-\\x09\\x0B-\\x1F\\x7F]')
  OR (content_state='removed' AND body IS NULL))
);
CREATE FUNCTION guard_prediction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'prediction_physical_delete_unsupported' USING ERRCODE='23514'; END IF;
 PERFORM id FROM couples WHERE id=NEW.couple_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.content_state<>'active' OR NEW.opened_at IS NOT NULL OR NEW.declined_at IS NOT NULL
   OR NEW.sequence<>(SELECT count(*)+1 FROM predictions WHERE couple_id=NEW.couple_id AND membership_epoch=NEW.membership_epoch)
   THEN RAISE EXCEPTION 'prediction_create_shape' USING ERRCODE='23514'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.couple_id,NEW.author_id,NEW.recipient_id,NEW.membership_epoch,NEW.sequence,NEW.created_at,NEW.release_at,NEW.timezone,NEW.local_date,NEW.local_time,NEW.utc_offset)
   IS DISTINCT FROM ROW(OLD.id,OLD.couple_id,OLD.author_id,OLD.recipient_id,OLD.membership_epoch,OLD.sequence,OLD.created_at,OLD.release_at,OLD.timezone,OLD.local_date,OLD.local_time,OLD.utc_offset)
   OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'prediction_identity' USING ERRCODE='23514'; END IF;
  IF NOT (
   (OLD.content_state='active' AND NEW.content_state='removed' AND NEW.body IS NULL
    AND NEW.opened_at IS NOT DISTINCT FROM OLD.opened_at AND NEW.declined_at IS NOT DISTINCT FROM OLD.declined_at)
   OR (OLD.content_state='active' AND NEW.content_state='active' AND OLD.opened_at IS NULL AND OLD.declined_at IS NULL
    AND ((NEW.opened_at IS NOT NULL AND NEW.declined_at IS NULL) OR (NEW.declined_at IS NOT NULL AND NEW.opened_at IS NULL))
    AND NEW.body IS NOT DISTINCT FROM OLD.body)
  ) THEN RAISE EXCEPTION 'prediction_transition' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_prediction BEFORE INSERT OR UPDATE OR DELETE ON predictions FOR EACH ROW EXECUTE FUNCTION guard_prediction();
CREATE TABLE prediction_commands (
 actor_user_id uuid NOT NULL, command_id uuid NOT NULL, couple_id uuid NOT NULL, membership_epoch integer NOT NULL,
 prediction_id uuid NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 operation text NOT NULL CHECK(operation IN ('create','open','decline','remove')),
 expected_version integer, applied jsonb NOT NULL,
 PRIMARY KEY(actor_user_id,command_id),
 FOREIGN KEY(couple_id,actor_user_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,prediction_id,membership_epoch) REFERENCES predictions(couple_id,id,membership_epoch)
);
CREATE FUNCTION guard_prediction_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record; snapshot jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'prediction_command_immutable' USING ERRCODE='23514'; END IF;
 -- Receipt validation is metadata-only, including inside the database trigger.
 SELECT id,couple_id,author_id,recipient_id,membership_epoch,version,created_at,release_at,
  timezone,local_date,local_time,utc_offset,content_state,opened_at,declined_at
 INTO p FROM predictions WHERE id=NEW.prediction_id AND couple_id=NEW.couple_id AND membership_epoch=NEW.membership_epoch;
 IF NOT FOUND THEN RAISE EXCEPTION 'prediction_command_scope' USING ERRCODE='23514'; END IF;
 snapshot:=jsonb_build_object('id',p.id,'coupleId',p.couple_id,'authorId',p.author_id,'recipientId',p.recipient_id,
  'membershipEpoch',p.membership_epoch,'version',p.version,'createdAt',to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'releaseAt',to_char(p.release_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'timezone',p.timezone,'localDate',p.local_date::text,
  'localTime',p.local_time,'offset',p.utc_offset,'contentState',p.content_state,
  'openedAt',to_char(p.opened_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'declinedAt',to_char(p.declined_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 IF NEW.applied IS DISTINCT FROM snapshot OR (
  (NEW.operation='create' AND NEW.actor_user_id=p.author_id AND NEW.expected_version IS NULL AND p.version=1)
  OR (NEW.operation='remove' AND NEW.actor_user_id=p.author_id AND NEW.expected_version BETWEEN 1 AND 2
   AND p.version=NEW.expected_version+1 AND p.content_state='removed')
  OR (NEW.operation IN ('open','decline') AND NEW.actor_user_id=p.recipient_id AND NEW.expected_version=1
   AND p.version=2 AND p.content_state='active' AND ((NEW.operation='open' AND p.opened_at IS NOT NULL) OR (NEW.operation='decline' AND p.declined_at IS NOT NULL)))
 ) IS NOT TRUE THEN RAISE EXCEPTION 'prediction_command_result' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_prediction_command BEFORE INSERT OR UPDATE OR DELETE ON prediction_commands FOR EACH ROW EXECUTE FUNCTION guard_prediction_command();

CREATE TABLE capsules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), couple_id uuid NOT NULL REFERENCES couples(id),
 author_id uuid NOT NULL, membership_epoch integer NOT NULL CHECK(membership_epoch BETWEEN 1 AND 2147483646),
 version integer NOT NULL CHECK(version BETWEEN 1 AND 2147483646),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at) AND date_trunc('milliseconds',created_at)=created_at),
 sealed_at timestamptz NOT NULL CHECK(isfinite(sealed_at) AND sealed_at>=created_at AND date_trunc('milliseconds',sealed_at)=sealed_at),
 release_at timestamptz NOT NULL CHECK(isfinite(release_at) AND release_at>sealed_at AND date_trunc('milliseconds',release_at)=release_at),
 timezone text NOT NULL CHECK(char_length(timezone) BETWEEN 1 AND 100),
 local_date date NOT NULL CHECK(local_date BETWEEN '2000-01-01' AND '2100-12-31'),
 local_time text NOT NULL CHECK(local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 utc_offset text NOT NULL CHECK(utc_offset ~ '^[+-]((0[0-9]|1[0-3]):[0-5][0-9]|14:00)$' AND utc_offset<>'-00:00'),
 content_state text NOT NULL CHECK(content_state IN ('active','removed')), body text,
 UNIQUE(couple_id,author_id,membership_epoch), UNIQUE(couple_id,id,membership_epoch),
 FOREIGN KEY(couple_id,author_id) REFERENCES couple_members(couple_id,user_id),
 CHECK(local_date>(sealed_at AT TIME ZONE timezone)::date),
 CHECK(release_at AT TIME ZONE timezone=local_date+local_time::time),
 CHECK(release_at=(local_date+local_time::time) AT TIME ZONE utc_offset::interval),
 CHECK(version>=1+(sealed_at<>created_at)::int+(content_state='removed')::int),
 CHECK(content_state='removed' OR version<2147483646),
 CHECK((content_state='active' AND body IS NOT NULL AND char_length(body) BETWEEN 1 AND 2000
  AND body=normalize(body,NFC)
  AND body=btrim(body,U&'\000A\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
  AND body !~ U&'[\0080-\009F]' AND body !~ E'[\\x01-\\x09\\x0B-\\x1F\\x7F]')
  OR (content_state='removed' AND body IS NULL))
);
CREATE FUNCTION guard_capsule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'capsule_physical_delete_unsupported' USING ERRCODE='23514'; END IF;
 PERFORM id FROM couples WHERE id=NEW.couple_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.content_state<>'active' OR NEW.sealed_at<>NEW.created_at
   THEN RAISE EXCEPTION 'capsule_create_shape' USING ERRCODE='23514'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.couple_id,NEW.author_id,NEW.membership_epoch,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.couple_id,OLD.author_id,OLD.membership_epoch,OLD.created_at)
   OR NEW.version::bigint<>OLD.version::bigint+1 THEN RAISE EXCEPTION 'capsule_identity' USING ERRCODE='23514'; END IF;
  IF NOT (
   (OLD.content_state='active' AND NEW.content_state='removed' AND NEW.body IS NULL
    AND ROW(NEW.sealed_at,NEW.release_at,NEW.timezone,NEW.local_date,NEW.local_time,NEW.utc_offset)
     IS NOT DISTINCT FROM ROW(OLD.sealed_at,OLD.release_at,OLD.timezone,OLD.local_date,OLD.local_time,OLD.utc_offset))
   OR (OLD.content_state='active' AND NEW.content_state='active' AND NEW.sealed_at>=OLD.sealed_at
    AND NEW.sealed_at<OLD.release_at)
  ) THEN RAISE EXCEPTION 'capsule_transition' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_capsule BEFORE INSERT OR UPDATE OR DELETE ON capsules FOR EACH ROW EXECUTE FUNCTION guard_capsule();
CREATE TABLE capsule_commands (
 actor_user_id uuid NOT NULL, command_id uuid NOT NULL, couple_id uuid NOT NULL, membership_epoch integer NOT NULL,
 capsule_id uuid NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 operation text NOT NULL CHECK(operation IN ('create','reseal','remove')),
 expected_version integer, applied jsonb NOT NULL,
 PRIMARY KEY(actor_user_id,command_id),
 FOREIGN KEY(couple_id,actor_user_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,capsule_id,membership_epoch) REFERENCES capsules(couple_id,id,membership_epoch)
);
CREATE FUNCTION guard_capsule_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record; snapshot jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'capsule_command_immutable' USING ERRCODE='23514'; END IF;
 -- Explicit owner-only metadata; never load sealed text while recording a command.
 SELECT id,couple_id,author_id,membership_epoch,version,created_at,sealed_at,release_at,
  timezone,local_date,local_time,utc_offset,content_state
 INTO p FROM capsules WHERE id=NEW.capsule_id AND couple_id=NEW.couple_id AND membership_epoch=NEW.membership_epoch AND author_id=NEW.actor_user_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'capsule_command_scope' USING ERRCODE='23514'; END IF;
 snapshot:=jsonb_build_object('id',p.id,'coupleId',p.couple_id,'authorId',p.author_id,
  'membershipEpoch',p.membership_epoch,'version',p.version,'createdAt',to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'sealedAt',to_char(p.sealed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'releaseAt',to_char(p.release_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'timezone',p.timezone,'localDate',p.local_date::text,
  'localTime',p.local_time,'offset',p.utc_offset,'contentState',p.content_state);
 IF NEW.applied IS DISTINCT FROM snapshot OR (
  (NEW.operation='create' AND NEW.expected_version IS NULL AND p.version=1 AND p.content_state='active')
  OR (NEW.operation='remove' AND NEW.expected_version BETWEEN 1 AND 2147483645
   AND p.version::bigint=NEW.expected_version::bigint+1 AND p.content_state='removed')
  OR (NEW.operation='reseal' AND NEW.expected_version BETWEEN 1 AND 2147483644
   AND p.version::bigint=NEW.expected_version::bigint+1 AND p.content_state='active')
 ) IS NOT TRUE THEN RAISE EXCEPTION 'capsule_command_result' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_capsule_command BEFORE INSERT OR UPDATE OR DELETE ON capsule_commands FOR EACH ROW EXECUTE FUNCTION guard_capsule_command();

CREATE TABLE partings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), couple_id uuid NOT NULL REFERENCES couples(id),
 creator_id uuid NOT NULL, membership_epoch integer NOT NULL CHECK(membership_epoch>0),
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 200 AND octet_length(title)<=800 AND title=normalize(title,NFC) AND title=btrim(title) AND title !~ '[[:cntrl:]]' AND title !~ '  '),
 start_date text NOT NULL CHECK(valid_shared_local_date(start_date) AND start_date>='2000-01-01'),
 end_date text NOT NULL CHECK(valid_shared_local_date(end_date) AND end_date<='2100-12-31' AND end_date>=start_date),
 timezone text NOT NULL CHECK(char_length(timezone) BETWEEN 1 AND 100),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(couple_id,id,membership_epoch), FOREIGN KEY(couple_id,creator_id) REFERENCES couple_members(couple_id,user_id)
);
CREATE FUNCTION guard_parting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'parting_delete_not_supported' USING ERRCODE='23514'; END IF;
 PERFORM id FROM couples WHERE id=NEW.couple_id FOR UPDATE;
 IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.couple_id,NEW.creator_id,NEW.membership_epoch,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.couple_id,OLD.creator_id,OLD.membership_epoch,OLD.created_at) OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'parting_identity' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone) THEN RAISE EXCEPTION 'parting_zone' USING ERRCODE='23514'; END IF;
 IF NEW.starts_at AT TIME ZONE NEW.timezone <> NEW.start_date::date::timestamp OR NEW.ends_at AT TIME ZONE NEW.timezone <> (NEW.end_date::date+1)::timestamp THEN RAISE EXCEPTION 'parting_boundary' USING ERRCODE='23514'; END IF;
 -- Independently require one exact midnight mapping, not PostgreSQL's implicit gap/fold choice.
 SELECT count(*) INTO n FROM generate_series(NEW.starts_at-interval '28 hours',NEW.starts_at+interval '28 hours',interval '1 minute') t WHERE t AT TIME ZONE NEW.timezone=NEW.start_date::date::timestamp;
 IF n<>1 THEN RAISE EXCEPTION 'parting_boundary' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO n FROM generate_series(NEW.ends_at-interval '28 hours',NEW.ends_at+interval '28 hours',interval '1 minute') t WHERE t AT TIME ZONE NEW.timezone=(NEW.end_date::date+1)::timestamp;
 IF n<>1 THEN RAISE EXCEPTION 'parting_boundary' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND (SELECT count(*) FROM partings WHERE couple_id=NEW.couple_id AND membership_epoch=NEW.membership_epoch)>=100 THEN RAISE EXCEPTION 'parting_capacity' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM partings p WHERE p.couple_id=NEW.couple_id AND p.membership_epoch=NEW.membership_epoch AND p.id<>NEW.id AND ((p.start_date<=NEW.end_date AND p.end_date>=NEW.start_date) OR (p.starts_at<NEW.ends_at AND p.ends_at>NEW.starts_at))) THEN RAISE EXCEPTION 'parting_overlap' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_parting BEFORE INSERT OR UPDATE OR DELETE ON partings FOR EACH ROW EXECUTE FUNCTION guard_parting();
CREATE TABLE parting_commands (
 actor_user_id uuid NOT NULL, command_id uuid NOT NULL, couple_id uuid NOT NULL,
 membership_epoch integer NOT NULL, parting_id uuid NOT NULL, title text NOT NULL,
 start_date text NOT NULL,end_date text NOT NULL,timezone text NOT NULL,
 operation text NOT NULL CHECK(operation IN ('create','edit')), expected_version integer,
 CHECK((operation='create' AND expected_version IS NULL) OR (operation='edit' AND expected_version>0)),
 PRIMARY KEY(actor_user_id,command_id), FOREIGN KEY(couple_id,actor_user_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,parting_id,membership_epoch) REFERENCES partings(couple_id,id,membership_epoch)
);
CREATE FUNCTION guard_parting_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM partings p WHERE p.couple_id=NEW.couple_id AND p.id=NEW.parting_id AND p.membership_epoch=NEW.membership_epoch AND p.title=NEW.title AND p.start_date=NEW.start_date AND p.end_date=NEW.end_date AND p.timezone=NEW.timezone AND ((NEW.operation='create' AND p.version=1 AND p.creator_id=NEW.actor_user_id) OR (NEW.operation='edit' AND p.version IN (NEW.expected_version,NEW.expected_version+1)))) THEN RAISE EXCEPTION 'parting_receipt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_parting_receipt BEFORE INSERT ON parting_commands FOR EACH ROW EXECUTE FUNCTION guard_parting_receipt();
CREATE TRIGGER immutable_parting_receipt BEFORE UPDATE OR DELETE ON parting_commands FOR EACH ROW EXECUTE FUNCTION immutable_shared_date();

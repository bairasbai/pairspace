CREATE TABLE arrival_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), couple_id uuid NOT NULL REFERENCES couples(id),
 creator_id uuid NOT NULL, membership_epoch integer NOT NULL CHECK(membership_epoch>0),
 label text NOT NULL CHECK(char_length(label) BETWEEN 0 AND 200 AND octet_length(label)<=800 AND label=normalize(label,NFC) AND label=btrim(label) AND label !~ '[[:cntrl:]]' AND label !~ '  '),
 local_date text NOT NULL CHECK(valid_shared_local_date(local_date) AND local_date>='2000-01-01' AND local_date<='2100-12-31'),
 local_time text NOT NULL CHECK(local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 timezone text NOT NULL CHECK(char_length(timezone) BETWEEN 1 AND 100),
 utc_offset text NOT NULL CHECK(utc_offset ~ '^[+-](0[0-9]|1[0-4]):[0-5][0-9]$' AND utc_offset<>'-00:00' AND (substring(utc_offset,2,2)<>'14' OR right(utc_offset,2)='00')),
 arrives_at timestamptz NOT NULL CHECK(isfinite(arrives_at)),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(couple_id,membership_epoch), UNIQUE(couple_id,id,membership_epoch),
 FOREIGN KEY(couple_id,creator_id) REFERENCES couple_members(couple_id,user_id)
);
CREATE FUNCTION guard_arrival_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'arrival_delete_not_supported' USING ERRCODE='23514'; END IF;
 PERFORM id FROM couples WHERE id=NEW.couple_id FOR UPDATE;
 IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.couple_id,NEW.creator_id,NEW.membership_epoch,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.couple_id,OLD.creator_id,OLD.membership_epoch,OLD.created_at) OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'arrival_identity' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone) THEN RAISE EXCEPTION 'arrival_zone' USING ERRCODE='23514'; END IF;
 IF NEW.arrives_at AT TIME ZONE NEW.timezone <> (NEW.local_date||' '||NEW.local_time)::timestamp
 OR NEW.arrives_at <> (NEW.local_date||'T'||NEW.local_time||':00'||NEW.utc_offset)::timestamptz THEN
 RAISE EXCEPTION 'arrival_schedule' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_arrival_plan BEFORE INSERT OR UPDATE OR DELETE ON arrival_plans FOR EACH ROW EXECUTE FUNCTION guard_arrival_plan();
CREATE TABLE arrival_plan_commands (
 actor_user_id uuid NOT NULL, command_id uuid NOT NULL, couple_id uuid NOT NULL,
 membership_epoch integer NOT NULL, plan_id uuid NOT NULL, expected_version integer NOT NULL CHECK(expected_version>=0),
 label text NOT NULL, local_date text NOT NULL, local_time text NOT NULL, timezone text NOT NULL, utc_offset text NOT NULL,
 PRIMARY KEY(actor_user_id,command_id), FOREIGN KEY(couple_id,actor_user_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,plan_id,membership_epoch) REFERENCES arrival_plans(couple_id,id,membership_epoch)
);
CREATE FUNCTION guard_arrival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM arrival_plans p WHERE p.couple_id=NEW.couple_id AND p.id=NEW.plan_id AND p.membership_epoch=NEW.membership_epoch AND p.label=NEW.label AND p.local_date=NEW.local_date AND p.local_time=NEW.local_time AND p.timezone=NEW.timezone AND p.utc_offset=NEW.utc_offset AND ((NEW.expected_version=0 AND p.version=1 AND p.creator_id=NEW.actor_user_id) OR (NEW.expected_version>0 AND p.version IN (NEW.expected_version,NEW.expected_version+1)))) THEN RAISE EXCEPTION 'arrival_receipt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_arrival_receipt BEFORE INSERT ON arrival_plan_commands FOR EACH ROW EXECUTE FUNCTION guard_arrival_receipt();
CREATE TRIGGER immutable_arrival_receipt BEFORE UPDATE OR DELETE ON arrival_plan_commands FOR EACH ROW EXECUTE FUNCTION immutable_shared_date();

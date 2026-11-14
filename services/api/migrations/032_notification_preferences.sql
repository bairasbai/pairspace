CREATE TABLE notification_preferences (
 couple_id uuid NOT NULL REFERENCES couples(id), user_id uuid NOT NULL, membership_epoch integer NOT NULL CHECK(membership_epoch>0),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), care boolean NOT NULL DEFAULT false, chat boolean NOT NULL DEFAULT false, letter boolean NOT NULL DEFAULT false,
 quiet_start text, quiet_end text, timezone text,
 PRIMARY KEY(couple_id,membership_epoch,user_id), FOREIGN KEY(couple_id,user_id) REFERENCES couple_members(couple_id,user_id),
 CHECK((quiet_start IS NULL AND quiet_end IS NULL AND timezone IS NULL) OR
 (quiet_start IS NOT NULL AND quiet_end IS NOT NULL AND timezone IS NOT NULL AND quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND quiet_start<>quiet_end AND char_length(timezone) BETWEEN 1 AND 100))
);
CREATE FUNCTION guard_notification_preferences() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'notification_delete_not_supported' USING ERRCODE='23514'; END IF;
 PERFORM id FROM couples WHERE id=NEW.couple_id FOR UPDATE;
 IF TG_OP='UPDATE' AND (ROW(NEW.couple_id,NEW.user_id,NEW.membership_epoch) IS DISTINCT FROM ROW(OLD.couple_id,OLD.user_id,OLD.membership_epoch) OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'notification_identity' USING ERRCODE='23514'; END IF;
 IF NEW.timezone IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=NEW.timezone) THEN RAISE EXCEPTION 'notification_zone' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_notification_preferences BEFORE INSERT OR UPDATE OR DELETE ON notification_preferences FOR EACH ROW EXECUTE FUNCTION guard_notification_preferences();
CREATE TABLE notification_preference_commands (
 actor_user_id uuid NOT NULL, command_id uuid NOT NULL, couple_id uuid NOT NULL, membership_epoch integer NOT NULL,
 expected_version integer NOT NULL CHECK(expected_version>=0), fingerprint text NOT NULL,
 PRIMARY KEY(actor_user_id,command_id), FOREIGN KEY(couple_id,membership_epoch,actor_user_id) REFERENCES notification_preferences(couple_id,membership_epoch,user_id)
);
CREATE FUNCTION guard_notification_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM notification_preferences p WHERE p.couple_id=NEW.couple_id AND p.user_id=NEW.actor_user_id AND p.membership_epoch=NEW.membership_epoch AND p.version IN (NEW.expected_version,NEW.expected_version+1)
 AND NEW.fingerprint::jsonb=jsonb_build_object('care',p.care,'chat',p.chat,'letter',p.letter,'quiet',CASE WHEN p.quiet_start IS NULL THEN NULL ELSE jsonb_build_object('start',p.quiet_start,'end',p.quiet_end,'timezone',p.timezone) END)) THEN RAISE EXCEPTION 'notification_receipt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_notification_receipt BEFORE INSERT ON notification_preference_commands FOR EACH ROW EXECUTE FUNCTION guard_notification_receipt();
CREATE TRIGGER immutable_notification_receipt BEFORE UPDATE OR DELETE ON notification_preference_commands FOR EACH ROW EXECUTE FUNCTION immutable_shared_date();

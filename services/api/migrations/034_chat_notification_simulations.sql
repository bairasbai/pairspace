-- Metadata-only context capture for NEW chat events. No backfill and no dispatch.
ALTER TABLE outbox_events ADD CONSTRAINT chat_outbox_identity UNIQUE(id,couple_id,message_id);
CREATE TABLE chat_notification_context (
 event_id uuid PRIMARY KEY, couple_id uuid NOT NULL, message_id uuid NOT NULL,
 sender_id uuid NOT NULL, recipient_id uuid NOT NULL, membership_epoch integer NOT NULL CHECK(membership_epoch>0),
 CHECK(sender_id<>recipient_id),
 UNIQUE(event_id,couple_id,recipient_id,membership_epoch),
 FOREIGN KEY(event_id,couple_id,message_id) REFERENCES outbox_events(id,couple_id,message_id),
 FOREIGN KEY(couple_id,message_id) REFERENCES chat_messages(couple_id,id),
 FOREIGN KEY(couple_id,sender_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,recipient_id) REFERENCES couple_members(couple_id,user_id)
);
CREATE FUNCTION guard_chat_notification_context() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'chat_context_immutable' USING ERRCODE='23514'; END IF;
 -- Only the nested capture trigger may create context, never historical/manual backfill.
 IF pg_trigger_depth()<>2 THEN RAISE EXCEPTION 'chat_context_capture_only' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM outbox_events e JOIN chat_messages m ON m.id=e.message_id AND m.couple_id=e.couple_id
   JOIN couples c ON c.id=e.couple_id WHERE e.id=NEW.event_id AND e.type='chat.message_created'
   AND e.couple_id=NEW.couple_id AND e.message_id=NEW.message_id AND m.sender_id=NEW.sender_id
   AND c.status='active' AND c.membership_epoch=NEW.membership_epoch)
   OR (SELECT count(*) FROM couple_members WHERE couple_id=NEW.couple_id AND status='active')<>2
   OR NOT EXISTS(SELECT 1 FROM couple_members WHERE couple_id=NEW.couple_id AND user_id=NEW.sender_id AND status='active')
   OR NOT EXISTS(SELECT 1 FROM couple_members WHERE couple_id=NEW.couple_id AND user_id=NEW.recipient_id AND status='active') THEN
   RAISE EXCEPTION 'invalid_chat_context' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_chat_notification_context BEFORE INSERT OR UPDATE OR DELETE ON chat_notification_context
 FOR EACH ROW EXECUTE FUNCTION guard_chat_notification_context();
CREATE FUNCTION capture_chat_notification_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE epoch integer; sender uuid; recipient uuid;
BEGIN
 IF NEW.type<>'chat.message_created' THEN RETURN NEW; END IF;
 SELECT membership_epoch INTO epoch FROM couples WHERE id=NEW.couple_id AND status='active' FOR UPDATE;
 IF epoch IS NULL THEN RAISE EXCEPTION 'unavailable_chat_context' USING ERRCODE='23514'; END IF;
 PERFORM user_id FROM couple_members WHERE couple_id=NEW.couple_id AND status='active' ORDER BY user_id FOR SHARE;
 SELECT sender_id INTO sender FROM chat_messages WHERE id=NEW.message_id AND couple_id=NEW.couple_id;
 SELECT user_id INTO recipient FROM couple_members WHERE couple_id=NEW.couple_id AND status='active' AND user_id<>sender;
 INSERT INTO chat_notification_context(event_id,couple_id,message_id,sender_id,recipient_id,membership_epoch)
 VALUES(NEW.id,NEW.couple_id,NEW.message_id,sender,recipient,epoch);
 RETURN NEW;
END $$;
CREATE TRIGGER capture_chat_notification_context AFTER INSERT ON outbox_events
 FOR EACH ROW EXECUTE FUNCTION capture_chat_notification_context();

CREATE TABLE chat_notification_simulations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL UNIQUE,
 couple_id uuid NOT NULL, recipient_id uuid NOT NULL, membership_epoch integer NOT NULL CHECK(membership_epoch>0),
 state text NOT NULL CHECK(state IN ('simulation_eligible','simulation_blocked')),
 reason text NOT NULL CHECK(reason IN ('unavailable','deleted','hidden','disabled','quiet_hours','allowed')),
 evaluated_at timestamptz NOT NULL CHECK(isfinite(evaluated_at)), preference_version integer, message_version integer,
 FOREIGN KEY(event_id,couple_id,recipient_id,membership_epoch)
   REFERENCES chat_notification_context(event_id,couple_id,recipient_id,membership_epoch),
 CHECK((state='simulation_eligible' AND reason='allowed') OR (state='simulation_blocked' AND reason<>'allowed')),
 CHECK((reason='unavailable' AND preference_version IS NULL AND message_version IS NULL)
   OR (reason IN ('deleted','hidden') AND preference_version IS NULL AND message_version IS NOT NULL AND message_version>0)
   OR (reason IN ('allowed','disabled','quiet_hours') AND preference_version IS NOT NULL AND preference_version>=0
     AND message_version IS NOT NULL AND message_version>0))
);
CREATE FUNCTION guard_chat_notification_simulation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'chat_simulation_immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_chat_notification_simulation BEFORE INSERT OR UPDATE OR DELETE ON chat_notification_simulations
 FOR EACH ROW EXECUTE FUNCTION guard_chat_notification_simulation();
CREATE FUNCTION guard_captured_chat_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM chat_notification_context WHERE event_id=OLD.id) THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'chat_event_identity_immutable' USING ERRCODE='23514'; END IF;
   IF ROW(NEW.id,NEW.couple_id,NEW.type,NEW.message_id,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.couple_id,OLD.type,OLD.message_id,OLD.created_at) THEN
     RAISE EXCEPTION 'chat_event_identity_immutable' USING ERRCODE='23514';
   END IF;
 END IF;
 -- Shared processed_at remains owned by existing consumers, never this simulator.
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_captured_chat_event BEFORE UPDATE OR DELETE ON outbox_events
 FOR EACH ROW EXECUTE FUNCTION guard_captured_chat_event();

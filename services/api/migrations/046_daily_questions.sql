-- Immutable shared calendar pins and original v1 question snapshots; no answer body in receipts.
CREATE TABLE daily_question_zones (
 couple_id uuid NOT NULL REFERENCES couples(id),
 membership_epoch integer NOT NULL CHECK(membership_epoch BETWEEN 1 AND 2147483646),
 timezone text NOT NULL CHECK(char_length(timezone) BETWEEN 1 AND 100),
 PRIMARY KEY(couple_id,membership_epoch), UNIQUE(couple_id,membership_epoch,timezone)
);
CREATE FUNCTION guard_daily_question_zone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'daily_question_zone_immutable' USING ERRCODE='23514'; END IF;
 PERFORM id FROM couples WHERE id=NEW.couple_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM couples WHERE id=NEW.couple_id AND membership_epoch=NEW.membership_epoch AND status='active')
  THEN RAISE EXCEPTION 'daily_question_zone_pair' USING ERRCODE='23514'; END IF;
 -- Validate a real PostgreSQL timezone, never silently substitute a server setting.
 PERFORM clock_timestamp() AT TIME ZONE NEW.timezone;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_daily_question_zone BEFORE INSERT OR UPDATE OR DELETE ON daily_question_zones FOR EACH ROW EXECUTE FUNCTION guard_daily_question_zone();

CREATE FUNCTION daily_question_prompt(day date, version text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN version='amio-daily-v1' AND day BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
 THEN jsonb_build_object('catalogVersion',version,'promptId',id,'promptRU',ru,'promptEN',en) ELSE NULL END
 FROM (VALUES
  (0,'small-discovery','Какое маленькое открытие сегодня привлекло твоё внимание?','What small discovery caught your attention today?'),
  (1,'comfortable-pace','В каком темпе тебе было бы приятно провести ближайший свободный час?','What pace would feel good for your next free hour?'),
  (2,'ordinary-detail','Какую обычную деталь вокруг себя тебе хотелось бы показать мне сегодня?','What ordinary detail around you would you like to show me today?'),
  (3,'try-together','Какую простую вещь тебе было бы любопытно когда-нибудь попробовать вместе?','What simple thing would you be curious to try together someday?'),
  (4,'gentle-change','Какое небольшое изменение сделало бы твой завтрашний день удобнее?','What small change would make tomorrow more comfortable for you?'),
  (5,'unexpected-smile','Что могло бы неожиданно вызвать у тебя улыбку в обычный день?','What might unexpectedly make you smile on an ordinary day?'),
  (6,'keep-a-moment','Какой момент этой недели тебе хотелось бы сохранить в памяти?','What moment from this week would you like to remember?')
 ) AS prompts(n,id,ru,en) WHERE n=(((day-DATE '2026-01-01')%7)+7)%7
$$;
CREATE TABLE daily_question_slots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), couple_id uuid NOT NULL, membership_epoch integer NOT NULL,
 participant_a uuid NOT NULL, participant_b uuid NOT NULL CHECK(participant_a<participant_b),
 day date NOT NULL CHECK(day BETWEEN '0001-01-01' AND '9999-12-31'), timezone text NOT NULL,
 catalog_version text NOT NULL, prompt_id text NOT NULL, prompt_ru text NOT NULL, prompt_en text NOT NULL,
 created_at timestamptz NOT NULL CHECK(isfinite(created_at) AND date_trunc('milliseconds',created_at)=created_at
  AND created_at>=TIMESTAMPTZ '0001-01-01 00:00:00+00' AND created_at<TIMESTAMPTZ '10000-01-01 00:00:00+00'),
 UNIQUE(couple_id,membership_epoch,day), UNIQUE(id,couple_id,membership_epoch),
 FOREIGN KEY(couple_id,membership_epoch,timezone) REFERENCES daily_question_zones(couple_id,membership_epoch,timezone),
 FOREIGN KEY(couple_id,participant_a) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(couple_id,participant_b) REFERENCES couple_members(couple_id,user_id),
 CHECK((created_at AT TIME ZONE timezone)::date=day),
 CHECK(daily_question_prompt(day,catalog_version) IS NOT NULL AND
  daily_question_prompt(day,catalog_version)=jsonb_build_object('catalogVersion',catalog_version,'promptId',prompt_id,'promptRU',prompt_ru,'promptEN',prompt_en))
);
CREATE FUNCTION guard_daily_question_slot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE participants uuid[];
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'daily_question_slot_immutable' USING ERRCODE='23514'; END IF;
 PERFORM id FROM couples WHERE id=NEW.couple_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM couples WHERE id=NEW.couple_id AND membership_epoch=NEW.membership_epoch AND status='active')
  THEN RAISE EXCEPTION 'daily_question_slot_pair' USING ERRCODE='23514'; END IF;
 SELECT array_agg(user_id ORDER BY user_id) INTO participants FROM couple_members WHERE couple_id=NEW.couple_id AND status='active';
 IF participants IS DISTINCT FROM ARRAY[NEW.participant_a,NEW.participant_b]
  THEN RAISE EXCEPTION 'daily_question_slot_participants' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_daily_question_slot BEFORE INSERT OR UPDATE OR DELETE ON daily_question_slots FOR EACH ROW EXECUTE FUNCTION guard_daily_question_slot();
CREATE INDEX daily_question_slots_history ON daily_question_slots(couple_id,membership_epoch,day DESC,id DESC);

CREATE TABLE daily_question_answers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid NOT NULL, couple_id uuid NOT NULL,
 membership_epoch integer NOT NULL, author_id uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 2147483646),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at) AND date_trunc('milliseconds',created_at)=created_at
  AND created_at>=TIMESTAMPTZ '0001-01-01 00:00:00+00' AND created_at<TIMESTAMPTZ '10000-01-01 00:00:00+00'),
 edited_at timestamptz NOT NULL CHECK(isfinite(edited_at) AND edited_at>=created_at AND date_trunc('milliseconds',edited_at)=edited_at
  AND edited_at<TIMESTAMPTZ '10000-01-01 00:00:00+00'),
 content_state text NOT NULL CHECK(content_state IN ('active','removed')),
 removed_at timestamptz CHECK(removed_at IS NULL OR (isfinite(removed_at) AND removed_at>=edited_at AND date_trunc('milliseconds',removed_at)=removed_at
  AND removed_at<TIMESTAMPTZ '10000-01-01 00:00:00+00')),
 text text,
 UNIQUE(slot_id,author_id), UNIQUE(id,couple_id,membership_epoch),
 FOREIGN KEY(slot_id,couple_id,membership_epoch) REFERENCES daily_question_slots(id,couple_id,membership_epoch),
 FOREIGN KEY(couple_id,author_id) REFERENCES couple_members(couple_id,user_id),
 CHECK((content_state='removed')=(removed_at IS NOT NULL)),
 CHECK((content_state='active' AND version<2147483646 AND (version<>1 OR edited_at=created_at))
  OR (content_state='removed' AND version>=2 AND (version<>2 OR edited_at=created_at))),
 CHECK((content_state='active' AND text IS NOT NULL AND char_length(text) BETWEEN 1 AND 2000
  AND text=normalize(text,NFC)
  AND text=btrim(text,U&'\000A\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
  AND text !~ U&'[\0080-\009F]' AND text !~ E'[\\x01-\\x09\\x0B-\\x1F\\x7F]')
  OR (content_state='removed' AND text IS NULL))
);
CREATE FUNCTION guard_daily_question_answer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE slot record; participants uuid[];
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'daily_question_answer_delete_unsupported' USING ERRCODE='23514'; END IF;
 PERFORM id FROM couples WHERE id=NEW.couple_id FOR UPDATE;
 SELECT id,couple_id,membership_epoch,participant_a,participant_b,day,timezone,created_at INTO slot
  FROM daily_question_slots WHERE id=NEW.slot_id AND couple_id=NEW.couple_id AND membership_epoch=NEW.membership_epoch;
 IF NOT EXISTS(SELECT 1 FROM couples WHERE id=NEW.couple_id AND membership_epoch=NEW.membership_epoch AND status='active')
  THEN RAISE EXCEPTION 'daily_question_answer_pair' USING ERRCODE='23514'; END IF;
 SELECT array_agg(user_id ORDER BY user_id) INTO participants FROM couple_members WHERE couple_id=NEW.couple_id AND status='active';
 IF slot.id IS NULL OR participants IS DISTINCT FROM ARRAY[slot.participant_a,slot.participant_b]
  THEN RAISE EXCEPTION 'daily_question_answer_participants' USING ERRCODE='23514'; END IF;
 IF NEW.author_id NOT IN (slot.participant_a,slot.participant_b)
  OR NEW.created_at<slot.created_at OR (NEW.created_at AT TIME ZONE slot.timezone)::date<>slot.day
  OR (NEW.edited_at AT TIME ZONE slot.timezone)::date<>slot.day
  OR (NEW.removed_at IS NOT NULL AND (NEW.removed_at AT TIME ZONE slot.timezone)::date<slot.day)
  THEN RAISE EXCEPTION 'daily_question_answer_scope' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.version<>1 OR NEW.content_state<>'active' OR NEW.created_at<>NEW.edited_at
   THEN RAISE EXCEPTION 'daily_question_answer_create' USING ERRCODE='23514'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.slot_id,NEW.couple_id,NEW.membership_epoch,NEW.author_id,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.slot_id,OLD.couple_id,OLD.membership_epoch,OLD.author_id,OLD.created_at)
   OR NEW.version::bigint<>OLD.version::bigint+1 OR OLD.content_state='removed'
   THEN RAISE EXCEPTION 'daily_question_answer_identity' USING ERRCODE='23514'; END IF;
  IF (NEW.content_state='removed' AND NEW.edited_at IS DISTINCT FROM OLD.edited_at)
   OR (NEW.content_state='active' AND NEW.edited_at<OLD.edited_at)
   THEN RAISE EXCEPTION 'daily_question_answer_transition' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_daily_question_answer BEFORE INSERT OR UPDATE OR DELETE ON daily_question_answers FOR EACH ROW EXECUTE FUNCTION guard_daily_question_answer();

CREATE TABLE daily_question_commands (
 actor_user_id uuid NOT NULL, command_id uuid NOT NULL, couple_id uuid NOT NULL, membership_epoch integer NOT NULL,
 answer_id uuid NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 operation text NOT NULL CHECK(operation IN ('create','rewrite','remove')), expected_version integer,
 applied jsonb NOT NULL, slot jsonb NOT NULL,
 PRIMARY KEY(actor_user_id,command_id),
 FOREIGN KEY(couple_id,actor_user_id) REFERENCES couple_members(couple_id,user_id),
 FOREIGN KEY(answer_id,couple_id,membership_epoch) REFERENCES daily_question_answers(id,couple_id,membership_epoch)
);
CREATE FUNCTION guard_daily_question_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; s record; answer_snapshot jsonb; slot_snapshot jsonb; participants uuid[];
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'daily_question_command_immutable' USING ERRCODE='23514'; END IF;
 PERFORM id FROM couples WHERE id=NEW.couple_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM couples WHERE id=NEW.couple_id AND membership_epoch=NEW.membership_epoch AND status='active')
  THEN RAISE EXCEPTION 'daily_question_command_pair' USING ERRCODE='23514'; END IF;
 -- Never select answer text while validating a command receipt.
 SELECT id,slot_id,couple_id,membership_epoch,author_id,version,created_at,edited_at,content_state,removed_at INTO a
  FROM daily_question_answers WHERE id=NEW.answer_id AND couple_id=NEW.couple_id AND membership_epoch=NEW.membership_epoch AND author_id=NEW.actor_user_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'daily_question_command_scope' USING ERRCODE='23514'; END IF;
 SELECT id,couple_id,membership_epoch,participant_a,participant_b,day,timezone,created_at,catalog_version,prompt_id,prompt_ru,prompt_en INTO s
  FROM daily_question_slots WHERE id=a.slot_id;
 SELECT array_agg(user_id ORDER BY user_id) INTO participants FROM couple_members WHERE couple_id=NEW.couple_id AND status='active';
 IF participants IS DISTINCT FROM ARRAY[s.participant_a,s.participant_b]
  THEN RAISE EXCEPTION 'daily_question_command_participants' USING ERRCODE='23514'; END IF;
 answer_snapshot:=jsonb_build_object('id',a.id,'slotId',a.slot_id,'coupleId',a.couple_id,'membershipEpoch',a.membership_epoch,
  'authorId',a.author_id,'version',a.version,'createdAt',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'editedAt',to_char(a.edited_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'contentState',a.content_state,
  'removedAt',to_char(a.removed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
 slot_snapshot:=jsonb_build_object('id',s.id,'coupleId',s.couple_id,'membershipEpoch',s.membership_epoch,
  'participantIds',jsonb_build_array(s.participant_a,s.participant_b),'day',s.day::text,'timezone',s.timezone,
  'createdAt',to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'catalogVersion',s.catalog_version,'promptId',s.prompt_id,'promptRU',s.prompt_ru,'promptEN',s.prompt_en);
 IF NEW.applied IS DISTINCT FROM answer_snapshot OR NEW.slot IS DISTINCT FROM slot_snapshot OR (
  (NEW.operation='create' AND NEW.expected_version IS NULL AND a.version=1 AND a.content_state='active')
  OR (NEW.operation='rewrite' AND NEW.expected_version BETWEEN 1 AND 2147483644 AND a.version::bigint=NEW.expected_version::bigint+1 AND a.content_state='active')
  OR (NEW.operation='remove' AND NEW.expected_version BETWEEN 1 AND 2147483645 AND a.version::bigint=NEW.expected_version::bigint+1 AND a.content_state='removed')
 ) IS NOT TRUE THEN RAISE EXCEPTION 'daily_question_command_result' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_daily_question_command BEFORE INSERT OR UPDATE OR DELETE ON daily_question_commands FOR EACH ROW EXECUTE FUNCTION guard_daily_question_command();

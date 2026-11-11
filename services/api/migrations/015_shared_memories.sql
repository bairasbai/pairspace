-- Explicit shared dated memories, not blind-answer history. No private draft storage.
CREATE TABLE shared_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id uuid NOT NULL REFERENCES couples(id),
  creator_id uuid NOT NULL,
  membership_epoch integer NOT NULL CHECK (membership_epoch>0),
  command_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND octet_length(title)<=800
    AND title=normalize(title,NFC) AND title=btrim(title) AND title !~ '[[:cntrl:]]' AND title !~ '  '),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000 AND body ~ '[^[:space:]]' AND body=normalize(body,NFC) AND position(chr(13) in body)=0),
  local_date text NOT NULL CHECK (valid_shared_local_date(local_date)),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at) AND created_at=date_trunc('milliseconds',created_at)),
  UNIQUE(creator_id,command_id),
  FOREIGN KEY(couple_id,creator_id) REFERENCES couple_members(couple_id,user_id)
);
CREATE INDEX shared_memories_latest ON shared_memories(couple_id,membership_epoch,created_at DESC,id DESC);
CREATE FUNCTION immutable_shared_memory() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_shared_memory' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER immutable_shared_memory BEFORE UPDATE OR DELETE ON shared_memories
  FOR EACH ROW EXECUTE FUNCTION immutable_shared_memory();
-- Retained and inaccessible after pair closure. No archive/deletion policy chosen.

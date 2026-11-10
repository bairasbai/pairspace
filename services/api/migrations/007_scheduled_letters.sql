-- Forward-only additive migration: existing letters remain immediately available.
ALTER TABLE letters ADD COLUMN release_at timestamptz;
ALTER TABLE letters ADD COLUMN release_timezone text;
ALTER TABLE letters ADD CONSTRAINT letters_schedule_pair CHECK (
  (release_at IS NULL AND release_timezone IS NULL) OR
  (release_at IS NOT NULL AND release_timezone IS NOT NULL AND
   char_length(release_timezone) BETWEEN 1 AND 100 AND release_at > created_at)
);

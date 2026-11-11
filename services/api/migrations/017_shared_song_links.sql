-- Optional explicit public music links. Old immutable rows and no-link receipts remain unchanged.
-- No fetching, metadata lookup, redirects, embedding, or playback is performed by the server.
ALTER TABLE shared_songs ADD COLUMN music_url text;
ALTER TABLE shared_songs ADD CONSTRAINT shared_song_music_url CHECK (
  music_url IS NULL OR (char_length(music_url)<=512 AND
    music_url ~ '^https://(open\.spotify\.com|music\.apple\.com|www\.youtube\.com|youtu\.be|music\.yandex\.ru)/[A-Za-z0-9/_-]+$')
);

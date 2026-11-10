-- Identity mapping only. Better Auth owns its own user/session tables.
-- Migration runner must provision Better Auth separately, in the SAME trusted
-- PostgreSQL schema/search_path used by this API. No session copy or backfill.
CREATE TABLE better_auth_identities (
  auth_user_id text PRIMARY KEY CHECK (char_length(auth_user_id) BETWEEN 1 AND 200),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id)
);
-- Provider user existence/ownership is checked under lock by the authority.
-- Mapping mutation is unsupported until its lock order and lifecycle are reviewed.

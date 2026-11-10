-- Identity/session references only. No passwords, token issuance or persistent signing keys.
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
CREATE TABLE auth_identities (
  issuer text NOT NULL CHECK (char_length(issuer) BETWEEN 1 AND 500),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  user_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (issuer, subject),
  UNIQUE (issuer, subject, user_id)
);
CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  issuer text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (issuer, subject, user_id) REFERENCES auth_identities(issuer, subject, user_id),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);

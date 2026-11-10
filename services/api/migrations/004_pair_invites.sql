-- One-time transactional migration; synthetic invitation issuance only.
-- No raw token, recipient contact, notification or activation is persisted here.
CREATE TABLE pair_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id uuid NOT NULL REFERENCES couples(id),
  issuer_user_id uuid NOT NULL,
  command_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  consumed_at timestamptz,
  consumed_by_user_id uuid,
  UNIQUE (couple_id, command_id),
  FOREIGN KEY (couple_id, issuer_user_id) REFERENCES couple_members(couple_id, user_id),
  FOREIGN KEY (couple_id, consumed_by_user_id) REFERENCES couple_members(couple_id, user_id),
  CHECK (isfinite(created_at) AND isfinite(expires_at) AND expires_at > created_at),
  CHECK (revoked_at IS NULL OR (isfinite(revoked_at) AND revoked_at >= created_at)),
  CHECK ((consumed_at IS NULL) = (consumed_by_user_id IS NULL)),
  CHECK (consumed_at IS NULL OR (isfinite(consumed_at) AND consumed_at >= created_at AND consumed_at < expires_at)),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL),
  CHECK (consumed_by_user_id IS NULL OR consumed_by_user_id <> issuer_user_id)
);
-- Expired records still reserve this slot until atomically revoked/replaced.
CREATE UNIQUE INDEX one_current_pair_invite ON pair_invites(couple_id)
  WHERE revoked_at IS NULL AND consumed_at IS NULL;

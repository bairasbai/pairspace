-- Forward-only, synthetic scope. Records are retained for command deduplication.
-- The read window is 24 hours; this is not a data-deletion policy.
CREATE TABLE care_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id uuid NOT NULL REFERENCES couples(id),
  sender_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  client_signal_id uuid NOT NULL,
  membership_epoch integer NOT NULL CHECK (membership_epoch > 0),
  kind text NOT NULL DEFAULT 'thinking_of_you' CHECK (kind = 'thinking_of_you'),
  created_at timestamptz NOT NULL,
  CHECK (sender_id <> recipient_id),
  UNIQUE (sender_id, client_signal_id),
  FOREIGN KEY (couple_id, sender_id) REFERENCES couple_members(couple_id, user_id),
  FOREIGN KEY (couple_id, recipient_id) REFERENCES couple_members(couple_id, user_id)
);
CREATE INDEX care_signal_recent ON care_signals(couple_id, sender_id, created_at DESC);

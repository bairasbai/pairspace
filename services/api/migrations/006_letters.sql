-- Immediate immutable synthetic letters only. Drafts remain private client RAM.
-- No release scheduling, read receipts, editing or deletion in this slice.
CREATE TABLE letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id uuid NOT NULL REFERENCES couples(id),
  sender_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  client_letter_id uuid NOT NULL,
  membership_epoch integer NOT NULL CHECK (membership_epoch > 0),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  created_at timestamptz NOT NULL,
  CHECK (sender_id <> recipient_id),
  UNIQUE (sender_id, client_letter_id),
  FOREIGN KEY (couple_id, sender_id) REFERENCES couple_members(couple_id, user_id),
  FOREIGN KEY (couple_id, recipient_id) REFERENCES couple_members(couple_id, user_id)
);
CREATE INDEX letters_incoming ON letters(couple_id, recipient_id, membership_epoch, created_at DESC, id DESC);

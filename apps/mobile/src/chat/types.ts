export type Scope = Readonly<{
  userId: string;
  coupleId: string;
  membershipEpoch: number;
  /** Local connection incarnation, not a credential. Generate afresh after logout/login. */
  sessionId: string;
}>;
export type SendStatus = 'queued' | 'sending' | 'accepted' | 'failed';
export type Outgoing = Readonly<{
  clientId: string;
  /** Immutable target ID only, never a copied source body. */
  replyToId?: string;
  body: string | null;
  /** Canonical display only; body remains the immutable original send command. */
  canonicalBody?: string;
  hidden?: boolean;
  status: SendStatus;
  attempt: number;
  error: 'rejected' | null;
  serverId: string | null;
  seq: number | null;
  version: number;
  deleted: boolean;
}>;
export type QueueState = Readonly<{
  scope: Scope;
  phase: 'active' | 'paused' | 'revoked' | 'logged_out';
  messages: readonly Outgoing[];
}>;
export type QueueError = 'scope_mismatch' | 'inactive' | 'invalid_id' | 'invalid_text'
  | 'empty_text' | 'text_too_long' | 'id_conflict' | 'deleted' | 'unknown_message'
  | 'invalid_transition' | 'invalid_ack' | 'queue_full' | 'stale_session';
export type QueueResult = Readonly<{ ok: true; state: QueueState } | { ok: false; state: QueueState; error: QueueError }>;
export type Ack = Readonly<{
  replyToId?: string;
  clientId: string; serverId: string; senderId: string; seq: number; version: number; body: string;
}>;

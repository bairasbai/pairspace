import type { SessionAuthority } from './auth-authority.ts';
export interface SqlExecutor {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database {
  /** Trusted server clock, never supplied by request input. */
  now(): Date;
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
/** Created only by a trusted verifier, never from request body; revalidated in each SQL transaction. */
export type Principal = Readonly<{ userId: string; sessionId: string; tokenExpiresAt: number } & (
  { source: 'synthetic-jwt' } | { source: 'better-auth'; authUserId: string }
)>;
export interface AuthorizedDatabase extends Database {
  readonly sessionAuthority: SessionAuthority;
}
export type ApiError = 'unavailable' | 'invalid_request' | 'invalid_text' | 'empty_text'
  | 'message_unavailable' | 'message_deleted' | 'version_conflict' | 'reply_unavailable' | 'invalid_cursor' | 'text_too_long' | 'idempotency_conflict' | 'stale_membership';
export type Result<T> = Readonly<{ ok: true; value: T } | { ok: false; error: ApiError }>;
export type Message = Readonly<{
  id: string; coupleId: string; senderId: string; clientId: string; seq: number;
  body: string; version: number; createdAt: string;
}>;
export type SendCommand = Readonly<{ coupleId: string; membershipEpoch: number; clientId: string; body: string }>;
export type HistoryCommand = Readonly<{ coupleId: string; membershipEpoch: number; beforeSeq?: number; limit: number }>;

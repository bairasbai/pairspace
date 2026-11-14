export type JournalScope = Readonly<{
    origin: string;
    userId: string;
    coupleId: string;
    membershipEpoch: number;
}>;
export type JournalToken = Readonly<{
    installationId: string;
    generation: number;
    lease: number;
    scope: string;
}>;
export type JournalDraft = Readonly<{
    revision: number;
    text: string;
    replyToId?: string;
}>;
export type JournalPending = Readonly<{
    clientId: string;
    body: string;
    replyToId?: string;
    draftRevision: number;
}>;
export type JournalSnapshot = Readonly<{
    draft: JournalDraft | null;
    pending: JournalPending | null;
}>;
export type JournalError = 'locked' | 'corrupt' | 'storage_error' | 'stale' | 'conflict' | 'invalid' | 'unsupported';
export type JournalResult<T> = Readonly<{
    ok: true;
    value: T;
} | {
    ok: false;
    error: JournalError;
}>;
export type JournalInspection = Readonly<{
    hasDraft: boolean;
    hasPending: boolean;
    draftRevision: number;
}>;
export interface JournalPort {
    bindVerifiedScope(scope: JournalScope): Promise<JournalResult<JournalToken>>;
    inspect(token: JournalToken): Promise<JournalResult<JournalInspection>>;
    /** Explicit internal recovery. Pending.body is ONLY for exact retry, never composer/history display. */
    restore(token: JournalToken): Promise<JournalResult<JournalSnapshot>>;
    saveDraft(token: JournalToken, draft: JournalDraft): Promise<JournalResult<null>>;
    prepareSend(token: JournalToken, pending: JournalPending): Promise<JournalResult<null>>;
    settlePending(token: JournalToken, clientId: string, draftRevision: number): Promise<JournalResult<null>>;
    discardPending(token: JournalToken, clientId: string | null, draftRevision: number): Promise<JournalResult<null>>;
    /** Immediate local invalidation; encrypted rows remain. */
    suspend(token: JournalToken): void;
    /** Immediate local invalidation followed by durable retirement and key removal. */
    retire(token: JournalToken): Promise<JournalResult<null>>;
    /** Explicit confirmed local discard-all only; does NOT cancel any server commit. */
    reset(): Promise<JournalResult<null>>;
}
export type SealedJournal = Readonly<{
    data: string;
}>;
export type JournalRow = {
    installationId: string;
    generation: number;
    lease: number;
    scope: string | null;
    revision: number;
    draftRevision: number;
    pendingFloor: number;
    hasDraft: boolean;
    hasPending: boolean;
    sealed: SealedJournal | null;
};
export interface JournalTransaction {
    read(): Promise<JournalRow | null>;
    write(row: JournalRow): Promise<void>;
}
export interface JournalStore {
    transaction<T>(work: (tx: JournalTransaction) => Promise<T>): Promise<T>;
}
export type JournalKey = Readonly<{
    installationId: string;
    secret: string;
}>;
export interface JournalKeys {
    read(): Promise<JournalKey | null>;
    create(installationId: string): Promise<JournalKey>;
    remove(): Promise<void>;
}
export interface JournalCipher {
    seal(plaintext: string, key: JournalKey, aad: string): Promise<SealedJournal>;
    open(sealed: SealedJournal, key: JournalKey, aad: string): Promise<string>;
}

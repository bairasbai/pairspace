import type { JournalDraft, JournalPending, JournalPort, JournalScope, JournalToken, JournalSnapshot } from '../chat/journal/types';
import type { TransportSession } from '../chat/transport';
import type { PendingOutgoing } from './outgoing-flow';
import { normalizeMessageText } from '../chat/text';
export type ChatJournalView = Readonly<{
    enabled: boolean;
    status: 'disabled' | 'idle' | 'checking' | 'recovery' | 'ready' | 'saving' | 'unsaved' | 'locked' | 'conflict';
    hasDraft?: boolean;
    hasPending?: boolean;
    pendingId?: string;
    error?: string;
    replyNeedsVerification?: string;
    conflictToken?: string;
    resetToken?: string;
}>;
type Host = {
    capture(): {
        generation: number;
        session: TransportSession;
    } | null;
    discover(valid?: () => boolean): Promise<{
        credential: TransportSession;
        changed: boolean;
    } | null>;
    cookie(): Promise<string>;
    denied(error: string): void;
    draft(): JournalDraft;
    hasPending(): boolean;
    apply(draft: JournalDraft | null, pending: JournalPending | null, preserveDraft: boolean): void;
    verifyReply(id: string, valid: () => boolean): Promise<boolean>;
    removeReply(): void;
    clearLocal(): void;
    bumpRevision(floor: number): void;
};
/** No plaintext snapshot is exposed through this observable controller. */
export function createChatJournal(origin: string, supplied: JournalPort | Promise<JournalPort> | undefined, host: Host) {
    let view: ChatJournalView = { enabled: !!supplied, status: supplied ? 'idle' : 'disabled' };
    let resolvedPort: JournalPort | null = supplied && 'bindVerifiedScope' in supplied ? supplied : null;
    // Observe factory rejection immediately, even before the user signs in.
    const factory = supplied ? Promise.resolve(supplied).then(port => ({ port }), () => ({ port: null })) : null;
    const getPort = async () => {
        if (resolvedPort)
            return resolvedPort;
        const result = await factory;
        if (!result?.port)
            throw new Error('storage_error');
        return (resolvedPort = result.port);
    };
    let resetConfirmation: {
        token: string;
        generation: number;
    } | null = null;
    let token: JournalToken | null = null, boundScope: JournalScope | null = null, ready = false, sequence = 0;
    let binding: Promise<boolean> | null = null, latest: JournalDraft | null = null, flushing: Promise<boolean> | null = null;
    let preparing: Promise<boolean> | null = null;
    let retirement: Promise<boolean> = Promise.resolve(true);
    let recovery: {
        snapshot: JournalSnapshot;
        token: string;
        draftRevision: number;
    } | null = null, conflictSerial = 0;
    let cleanup: ({ clientId: string; draftRevision: number; discard: false }
        | { clientId: string | null; draftRevision: number; discard: true }) | null = null;
    const listeners = new Set<() => void>();
    const publish = (next: ChatJournalView) => { view = next; listeners.forEach(notify => notify()); };
    const scope = (session: TransportSession): JournalScope => ({ origin, userId: session.scope.userId,
        coupleId: session.scope.coupleId, membershipEpoch: session.scope.membershipEpoch });
    const current = (generation: number, serial: number) => host.capture()?.generation === generation && serial === sequence;
    const fail = (error: string) => { publish({ ...view, status: 'unsaved', error }); return false; };
    async function bind(credential: TransportSession, valid: () => boolean): Promise<boolean> {
        if (!supplied)
            return true;
        const captured = host.capture();
        if (!captured || !valid())
            return false;
        const generation = captured.generation, serial = sequence;
        if (!await retirement || !current(generation, serial) || !valid())
            return false;
        if (token)
            return true;
        if (binding)
            return binding;
        binding = (async () => {
            try {
                const port = await getPort();
                if (!current(generation, serial) || !valid())
                    return false;
                const result = await port.bindVerifiedScope(scope(credential));
                if (!result.ok)
                    return current(generation, serial) ? fail(result.error) : false;
                if (!current(generation, serial) || !valid()) {
                    port.suspend(result.value);
                    return false;
                }
                token = result.value;
                boundScope = scope(credential);
                const inspection = await port.inspect(token);
                const cookie = await host.cookie();
                if (!current(generation, serial) || !valid())
                    return false;
                if (cookie !== credential.token) {
                    host.denied('auth_required');
                    return false;
                }
                if (!inspection.ok)
                    return fail(inspection.error);
                host.bumpRevision(inspection.value.draftRevision);
                if (latest)
                    latest = host.draft();
                ready = !inspection.value.hasDraft && !inspection.value.hasPending;
                publish({ enabled: true, status: ready ? 'ready' : 'recovery', ...inspection.value });
                return true;
            }
            catch {
                return current(generation, serial) ? fail('storage_error') : false;
            }
            finally {
                if (serial === sequence)
                    binding = null;
            }
        })();
        return binding;
    }
    async function authorized(valid: () => boolean) {
        const found = await host.discover(valid);
        if (!found || found.changed || !valid() || !await bind(found.credential, valid))
            return null;
        return found.credential;
    }
    async function flush(): Promise<boolean> {
        if (!supplied)
            return true;
        if (flushing)
            return flushing;
        const captured = host.capture(), serial = sequence;
        if (!captured)
            return false;
        const valid = () => current(captured.generation, serial);
        flushing = (async () => {
            let inFlightDraft: JournalDraft | null = null;
            try {
                const credential = await authorized(valid);
                if (!credential || !valid() || !ready || !token)
                    return false;
                const port = await getPort();
                if (cleanup) {
                    const job = cleanup;
                    const result = await (job.discard ? port.discardPending(token, job.clientId, job.draftRevision) : port.settlePending(token, job.clientId, job.draftRevision));
                    if (!valid())
                        return false;
                    if (!result.ok)
                        return fail(result.error);
                    // The engine atomically discarded this exact draft revision.
                    // Do not re-save an older queued copy; genuinely newer drafts remain.
                    if (job.discard && latest?.revision === job.draftRevision) latest = null;
                    if (cleanup === job) {
                        cleanup = null;
                        publish({ ...view, hasPending: false, pendingId: undefined });
                    }
                }
                while (latest && valid()) {
                    const draft = latest;
                    latest = null;
                    inFlightDraft = draft;
                    publish({ ...view, status: 'saving', error: undefined });
                    const result = await port.saveDraft(token, draft);
                    if (!valid())
                        return false;
                    if (!result.ok) {
                        if (!latest)
                            latest = draft;
                        return fail(result.error);
                    }
                    inFlightDraft = null;
                }
                const cookie = await host.cookie();
                if (!valid())
                    return false;
                if (cookie !== credential.token) {
                    host.denied('auth_required');
                    return false;
                }
                publish({ ...view, status: 'ready', error: undefined });
                return true;
            }
            catch {
                if (!valid())
                    return false;
                if (!latest && inFlightDraft)
                    latest = inFlightDraft;
                return fail('storage_error');
            }
            finally {
                if (serial === sequence)
                    flushing = null;
            }
        })();
        return flushing;
    }
    function suspend() {
        sequence++;
        recovery = null;
        ready = false;
        latest = null;
        cleanup = null;
        binding = null;
        flushing = null;
        const previous = token;
        token = null;
        if (previous && resolvedPort)
            resolvedPort.suspend(previous);
        else if (previous && supplied)
            void getPort().then(port => port.suspend(previous));
        publish({ enabled: !!supplied, status: supplied ? 'idle' : 'disabled' });
    }
    async function drain(): Promise<boolean> {
        do {
            if (!await flush())
                return false;
        } while (cleanup || latest);
        return true;
    }
    async function retire(): Promise<boolean> {
        if (!supplied)
            return true;
        const captured = host.capture(), previous = token, previousScope = boundScope ?? (captured ? scope(captured.session) : null);
        const previousRetirement = retirement;
        suspend();
        boundScope = previousScope;
        retirement = (async () => {
            await previousRetirement;
            try {
                const port = await getPort();
                let target = previous;
                if (!target && previousScope) {
                    const bound = await port.bindVerifiedScope(previousScope);
                    if (!bound.ok)
                        return false;
                    target = bound.value;
                }
                const retired = !target || (await port.retire(target)).ok;
                if (retired && boundScope === previousScope)
                    boundScope = null;
                return retired;
            }
            catch {
                return false;
            }
        })();
        return retirement;
    }
    async function applyRecovery(snapshot: JournalSnapshot, preserve: boolean) {
        host.apply(snapshot.draft, snapshot.pending, preserve);
        ready = true;
        const draft = host.draft();
        latest = draft;
        recovery = null;
        publish({ enabled: true, status: 'ready', hasDraft: !!snapshot.draft, hasPending: !!snapshot.pending,
            pendingId: snapshot.pending?.clientId, ...(draft.replyToId ? { replyNeedsVerification: draft.replyToId } : {}) });
        await flush();
    }
    return {
        getSnapshot: () => view,
        subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
        suspend, retire, flush: drain,
        beginReset() {
            const captured = host.capture();
            if (!supplied || !captured)
                return;
            resetConfirmation = { token: String(++conflictSerial), generation: captured.generation };
            publish({ ...view, resetToken: resetConfirmation.token });
        },
        cancelReset() { resetConfirmation = null; publish({ ...view, resetToken: undefined }); },
        async confirmReset(choiceToken: string) {
            const selected = resetConfirmation;
            if (!supplied || !selected || selected.token !== choiceToken || host.capture()?.generation !== selected.generation)
                return;
            suspend();
            resetConfirmation = null;
            host.clearLocal();
            const serial = sequence;
            const port = await getPort();
            if (serial !== sequence || host.capture()?.generation !== selected.generation)
                return;
            const result = await port.reset();
            if (serial !== sequence || host.capture()?.generation !== selected.generation)
                return;
            if (!result.ok) {
                fail(result.error);
                return;
            }
            retirement = Promise.resolve(true);
            boundScope = null;
            publish({ enabled: true, status: 'idle' });
        },
        changed() {
            if (!supplied || !host.capture()) return;
            latest = host.draft();
            void flush();
        },
        canSend: () => !supplied || (view.status !== 'conflict' && view.status !== 'recovery' && (!view.replyNeedsVerification || host.hasPending())),
        async beforeSend(valid: () => boolean) {
            if (!supplied)
                return true;
            const found = await authorized(valid);
            return !!found && valid() && ready && (!view.replyNeedsVerification || host.hasPending()) && view.status !== 'conflict';
        },
        observeVerified: (credential: TransportSession) => bind(credential, () => !!host.capture()),
        async check() {
            if (!supplied || !host.capture())
                return;
            const captured = host.capture()!, serial = sequence;
            const previousStatus = view.status;
            publish({ ...view, status: 'checking' });
            await authorized(() => current(captured.generation, serial));
            if (current(captured.generation, serial) && view.status === 'checking') {
                publish({ ...view, status: previousStatus });
            }
        },
        async restore() {
            if (!supplied || !host.capture() || host.hasPending())
                return;
            const captured = host.capture()!, serial = sequence, prior = host.draft();
            const valid = () => current(captured.generation, serial);
            try {
                const credential = await authorized(valid);
                if (!credential || !valid() || !token)
                    return;
                const result = await (await getPort()).restore(token);
                const fresh = await authorized(valid);
                if (!fresh || !valid() || JSON.stringify(scope(fresh)) !== JSON.stringify(scope(credential)))
                    return;
                const cookie = await host.cookie();
                if (!valid())
                    return;
                if (cookie !== credential.token) {
                    host.denied('auth_required');
                    return;
                }
                if (!result.ok) {
                    fail(result.error);
                    return;
                }
                const now = host.draft(), stored = result.value.draft;
                if (stored && now.text.length > 0 && (now.text !== stored.text || now.replyToId !== stored.replyToId)) {
                    recovery = { snapshot: result.value, token: String(++conflictSerial), draftRevision: now.revision };
                    ready = false;
                    publish({ ...view, status: 'conflict', conflictToken: recovery.token });
                    return;
                }
                await applyRecovery(result.value, now.revision !== prior.revision || now.text.length > 0);
            }
            catch {
                if (valid())
                    fail('storage_error');
            }
        },
        async resolveConflict(choiceToken: string, choice: 'current' | 'stored') {
            const saved = recovery, captured = host.capture(), serial = sequence;
            if (!saved || saved.token !== choiceToken || !captured || saved.draftRevision !== host.draft().revision)
                return;
            const valid = () => current(captured.generation, serial) && recovery === saved && saved.draftRevision === host.draft().revision;
            const credential = await authorized(valid);
            if (!credential || !valid())
                return;
            const cookie = await host.cookie();
            if (!valid())
                return;
            if (cookie !== credential.token) {
                host.denied('auth_required');
                return;
            }
            await applyRecovery(saved.snapshot, choice === 'current');
        },
        async verifyReply() {
            const id = view.replyNeedsVerification, captured = host.capture(), serial = sequence;
            if (!id || !captured)
                return;
            const valid = () => current(captured.generation, serial) && view.replyNeedsVerification === id;
            if (await host.verifyReply(id, valid) && valid())
                publish({ ...view, replyNeedsVerification: undefined });
        },
        removeReply() { if (!view.replyNeedsVerification)
            return; host.removeReply(); publish({ ...view, replyNeedsVerification: undefined }); latest = host.draft(); void flush(); },
        prepare(command: PendingOutgoing, credential: TransportSession, valid: () => boolean) {
            const work = (async () => {
                if (!supplied)
                    return true;
                if (!await bind(credential, valid) || !valid() || !ready || !token || !command.id)
                    return false;
                if (!await drain() || !valid())
                    return false;
                const body = normalizeMessageText(command.body);
                if (!body.ok)
                    return fail(body.error);
                const result = await (await getPort()).prepareSend(token, { clientId: command.id, body: body.text,
                    draftRevision: command.revision, ...(command.replyToId ? { replyToId: command.replyToId } : {}) });
                const cookie = await host.cookie();
                if (!valid())
                    return false;
                if (cookie !== credential.token) {
                    host.denied('auth_required');
                    return false;
                }
                if (!result.ok)
                    return fail(result.error);
                publish({ ...view, status: 'ready', hasPending: true, pendingId: command.id, error: undefined });
                return true;
            })();
            preparing = work;
            void work.finally(() => { if (preparing === work)
                preparing = null; }).catch(() => { });
            return work;
        },
        async settle(clientId: string, draftRevision: number) {
            if (!supplied || !token)
                return;
            await preparing?.catch(() => false);
            if (!token)
                return;
            cleanup = { clientId, draftRevision, discard: false };
            await drain();
        },
        async discard(clientId: string | null, draftRevision: number) {
            if (!supplied) return true;
            if (!token) return false;
            await preparing?.catch(() => false);
            if (!token)
                return false;
            cleanup = { clientId, draftRevision, discard: true };
            return drain();
        },
    };
}

import { readHiddenWindow, readMessageVisibility, setMessageHidden } from '../chat/visibility-transport';
import type { HiddenWindow, HiddenWindowOptions, MessageVisibility } from '../chat/visibility-model';
import type { DisplayMessage } from '../chat/reply-view';
import type { TransportSession } from '../chat/transport';
export type VisibilityView = Readonly<{
    status: 'idle' | 'loading' | 'confirming' | 'sending' | 'unknown' | 'saved' | 'error';
    confirmation?: Readonly<{
        token: string;
        messageId: string;
        hidden: boolean;
        version: number;
        seq: number;
        createdAt: string;
    }>;
    pendingId?: string;
    history?: HiddenWindow & {
        revision: number;
    };
    visibility?: MessageVisibility;
    error?: string;
}>;
type Host = {
    capture(): {
        generation: number;
        session: TransportSession;
    } | null;
    find(id: string): DisplayMessage | undefined;
    credential(): Promise<{
        credential: TransportSession;
    } | null>;
    cookie(): Promise<string | null>;
    denied(error: string): void;
    revision(): number | null;
    acceptDeleted(messages: readonly DisplayMessage[], token: string, revision: number): Promise<boolean>;
};
export function createChatVisibility(baseURL: string, host: Host, request: (input: Request) => Promise<Response>, commandId: () => string, readId: () => string) {
    let view: VisibilityView = { status: 'idle' }, sequence = 0, serial = 0, busy = false;
    let pending: {
        messageId: string;
        hidden: boolean;
        expectedVisibilityVersion: number;
        commandId: string;
        generation: number;
    } | null = null;
    let confirmationGeneration = -1;
    const listeners = new Set<() => void>();
    const publish = (next: VisibilityView) => { view = next; for (const notify of listeners)
        notify(); };
    const current = (generation: number) => host.capture()?.generation === generation;
    async function run() {
        const command = pending;
        if (!command || busy || !current(command.generation))
            return;
        busy = true;
        publish({ ...view, status: 'sending', pendingId: command.messageId, confirmation: undefined, error: undefined });
        try {
            const found = await host.credential();
            if (!current(command.generation) || pending !== command)
                return;
            if (!found) {
                publish({ ...view, status: 'unknown' });
                return;
            }
            const result = await setMessageHidden(baseURL, found.credential, { ...command, allowHttpLoopbackForTests: true }, request);
            if (!current(command.generation) || pending !== command)
                return;
            if (!result.ok && (result.error === 'auth_required' || result.error === 'access_required')) {
                host.denied(result.error);
                return;
            }
            const cookie = await host.cookie();
            if (!current(command.generation) || pending !== command)
                return;
            if (cookie !== found.credential.token) {
                host.denied('auth_required');
                return;
            }
            if (result.ok) {
                if (result.value.revision !== host.revision()) {
                    publish({ ...view, status: 'unknown', error: 'visibility_changed' });
                    return;
                }
                pending = null;
                publish({ ...view, status: 'saved', pendingId: undefined, history: undefined, visibility: result.value.visibility });
            }
            else {
                const definitive = ['version_conflict', 'message_unavailable', 'idempotency_conflict', 'invalid_request', 'rejected'].includes(result.error);
                if (definitive)
                    pending = null;
                publish({ ...view, status: definitive ? 'error' : 'unknown', pendingId: definitive ? undefined : command.messageId, error: result.error });
            }
        }
        catch {
            if (current(command.generation) && pending === command)
                publish({ ...view, status: 'unknown', error: 'transport_error' });
        }
        finally {
            if (current(command.generation))
                busy = false;
        }
    }
    async function load(direction: HiddenWindowOptions['direction']) {
        const captured = host.capture();
        if (!captured)
            return;
        const history = view.history;
        const edge = direction === 'before' ? history?.olderCursor : direction === 'after' ? history?.newerCursor : undefined;
        if ((direction === 'before' || direction === 'after') && !edge)
            return;
        const generation = captured.generation, token = ++sequence;
        publish({ ...view, status: pending ? view.status : 'loading', error: undefined });
        try {
            const found = await host.credential();
            if (!found || !current(generation) || token !== sequence)
                return;
            const result = await readHiddenWindow(baseURL, found.credential, { direction, readId: readId(),
                ...(edge ? { anchorId: edge.id, anchorSeq: edge.seq, visibilityRevision: history!.revision } : {}), allowHttpLoopbackForTests: true }, request);
            if (!current(generation))
                return;
            if (!result.ok && (result.error === 'auth_required' || result.error === 'access_required')) {
                host.denied(result.error);
                return;
            }
            if (token !== sequence)
                return;
            const cookie = await host.cookie();
            if (!current(generation) || token !== sequence)
                return;
            if (cookie !== found.credential.token) {
                host.denied('auth_required');
                return;
            }
            if (!result.ok) {
                publish({ ...view, status: pending ? view.status : 'error', history: undefined, error: result.error });
                return;
            }
            if (result.value.revision !== host.revision())
                return;
            const deleted = result.value.messages.filter(message => message.deletedAt !== null).map(({ visibilityVersion: _version, replyToId, deletedAt, ...message }) => ({ ...message, body: null, ...(replyToId === null ? {} : { replyToId }), deletedAt: deletedAt! }));
            if (deleted.length && !await host.acceptDeleted(deleted, found.credential.token, result.value.revision))
                return;
            if (!current(generation) || token !== sequence || result.value.revision !== host.revision())
                return;
            publish({ ...view, status: pending ? view.status : 'idle', history: result.value });
        }
        catch {
            if (current(generation) && token === sequence)
                publish({ ...view, status: pending ? view.status : 'error', error: 'transport_error' });
        }
    }
    return {
        getSnapshot: () => view,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        reset() { sequence++; serial++; pending = null; busy = false; confirmationGeneration = -1; publish({ status: 'idle' }); },
        invalidateHistory() { publish({ ...view, history: undefined, confirmation: undefined }); },
        async beginHide(id: string) {
            const captured = host.capture(), message = host.find(id);
            if (!captured || !message || pending || busy)
                return;
            const generation = captured.generation, token = ++sequence;
            publish({ ...view, status: 'loading', confirmation: undefined });
            try {
                const found = await host.credential();
                if (!found || !current(generation) || token !== sequence)
                    return;
                const result = await readMessageVisibility(baseURL, found.credential, { messageId: id, readId: readId(), allowHttpLoopbackForTests: true }, request);
                if (!current(generation))
                    return;
                if (!result.ok && (result.error === 'auth_required' || result.error === 'access_required')) {
                    host.denied(result.error);
                    return;
                }
                if (token !== sequence)
                    return;
                const cookie = await host.cookie();
                if (!current(generation) || token !== sequence)
                    return;
                if (cookie !== found.credential.token) {
                    host.denied('auth_required');
                    return;
                }
                if (!result.ok) {
                    publish({ ...view, status: 'error', error: result.error });
                    return;
                }
                if (result.value.revision !== host.revision())
                    return;
                confirmationGeneration = generation;
                publish({ ...view, status: 'confirming', confirmation: { token: String(++serial), messageId: id, hidden: true,
                        version: result.value.visibility.version, seq: message.seq, createdAt: message.createdAt } });
            }
            catch {
                if (current(generation) && token === sequence)
                    publish({ ...view, status: 'error', error: 'transport_error' });
            }
        },
        beginRestore(id: string) {
            const captured = host.capture(), row = view.history?.messages.find(message => message.id === id);
            if (!captured || !row || pending || busy)
                return;
            sequence++;
            confirmationGeneration = captured.generation;
            publish({ ...view, status: 'confirming', confirmation: { token: String(++serial), messageId: id, hidden: false,
                    version: row.visibilityVersion, seq: row.seq, createdAt: row.createdAt } });
        },
        cancel() { if (pending || busy)
            return; sequence++; serial++; publish({ ...view, status: 'idle', confirmation: undefined }); },
        async confirm(token: string) {
            const selected = view.confirmation;
            if (!selected || selected.token !== token || pending || busy || !current(confirmationGeneration))
                return;
            pending = { messageId: selected.messageId, hidden: selected.hidden, expectedVisibilityVersion: selected.version,
                commandId: commandId(), generation: confirmationGeneration };
            await run();
        },
        retry: run,
        loadLatest: () => load('latest'), loadOldest: () => load('oldest'),
        loadOlder: () => load('before'), loadNewer: () => load('after'),
    };
}

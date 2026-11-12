import { editChatMessage } from '../chat/edit-transport';
import { readReplyDetail } from '../chat/reply-transport';
import { displayMessage, type DisplayMessage } from '../chat/reply-view';
import type { DeleteTarget } from '../chat/delete-transport';
import type { TransportSession } from '../chat/transport';
import { normalizeMessageText } from '../chat/text';
export type EditState = Readonly<{
    status: 'idle' | 'editing' | 'sending' | 'unknown' | 'conflict' | 'saved' | 'deleted' | 'error';
    targetId?: string;
    version?: number;
    draft: string;
    needsReload: boolean;
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
    publish(state: EditState): void;
    denied(error: string): void;
    accept(message: DisplayMessage, token: string): Promise<boolean>;
};
const empty: EditState = { status: 'idle', draft: '', needsReload: false };
const metadata = (m: DisplayMessage): DeleteTarget => ({ id: m.id, coupleId: m.coupleId, senderId: m.senderId,
    clientId: m.clientId, seq: m.seq, version: m.version, createdAt: m.createdAt, replyToId: m.replyToId ?? null });
export function createChatEdit(baseURL: string, host: Host, request: (request: Request) => Promise<Response>, commandId: () => string, readId: () => string) {
    let state = empty, target: DeleteTarget | null = null;
    let revision = 0, baselineRevision = 0, generation = -1, readSequence = 0, busy = false;
    let pending: {
        target: DeleteTarget;
        commandId: string;
        body: string;
        revision: number;
        generation: number;
    } | null = null;
    const publish = (next: EditState) => { state = next; host.publish(next); };
    const current = (g: number) => host.capture()?.generation === g;
    function observe(message: DisplayMessage) {
        if (message.id !== target?.id)
            return;
        if (message.body === null) {
            const unchanged = revision === baselineRevision || revision === pending?.revision;
            pending = null;
            busy = false;
            target = { ...target, version: message.version };
            publish({ ...state, status: 'deleted', version: message.version,
                draft: unchanged ? '' : state.draft, needsReload: true });
        }
        else if (message.version > target.version) {
            publish({ ...state, needsReload: true });
        }
    }
    async function run() {
        const command = pending;
        if (!command || busy || !current(command.generation))
            return;
        busy = true;
        publish({ ...state, status: 'sending', error: undefined });
        try {
            const found = await host.credential();
            if (!current(command.generation) || pending !== command)
                return;
            if (!found) {
                publish({ ...state, status: 'unknown' });
                return;
            }
            const result = await editChatMessage(baseURL, found.credential, { message: command.target,
                commandId: command.commandId, body: command.body, allowHttpLoopbackForTests: true }, request);
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
            const canonical = result.ok ? result.value.message : result.error === 'message_deleted' ? result.message : null;
            if (canonical) {
                const accepted = await host.accept(displayMessage(canonical), found.credential.token);
                if (!current(command.generation) || pending !== command)
                    return;
                if (!accepted) {
                    publish({ ...state, status: 'unknown', error: 'invalid_response' });
                    return;
                }
                pending = null;
                target = metadata(displayMessage(canonical));
                if (canonical.body === null) {
                    observe(displayMessage(canonical));
                    return;
                }
                const unchanged = revision === command.revision;
                if (unchanged)
                    baselineRevision = revision;
                publish({ ...state, version: canonical.version, draft: unchanged ? canonical.body : state.draft,
                    needsReload: false, status: unchanged ? 'saved' : 'editing', error: undefined });
            }
            else if (!result.ok) {
                const definitive = ['version_conflict', 'message_unavailable', 'idempotency_conflict', 'invalid_request', 'rejected'].includes(result.error);
                if (definitive)
                    pending = null;
                publish({ ...state, status: definitive ? 'conflict' : 'unknown',
                    needsReload: definitive || state.needsReload, error: result.error });
            }
        }
        catch {
            if (current(command.generation) && pending === command)
                publish({ ...state, status: 'unknown', error: 'transport_error' });
        }
        finally {
            if (current(command.generation))
                busy = false;
        }
    }
    return {
        observe,
        reset() { readSequence++; revision++; target = null; pending = null; busy = false; generation = -1; state = empty; },
        beginEdit(id: string) {
            const captured = host.capture(), message = host.find(id);
            if (!captured || busy || pending || !message || message.body === null || message.senderId !== captured.session.scope.userId)
                return;
            if (target && state.targetId !== id && state.draft && revision !== baselineRevision)
                return;
            if (target?.id === id && revision !== baselineRevision)
                return;
            readSequence++;
            generation = captured.generation;
            target = metadata(message);
            baselineRevision = ++revision;
            publish({ status: 'editing', targetId: id, version: message.version, draft: message.body, needsReload: false });
        },
        setEditDraft(value: string) {
            if (!current(generation) || !target || typeof value !== 'string' || value.length > 16000)
                return;
            if (value === state.draft)
                return;
            revision++;
            publish({ ...state, draft: value, status: state.status === 'deleted' ? 'deleted' : pending ? state.status : 'editing' });
        },
        cancelEdit() {
            if (pending || busy)
                return;
            readSequence++;
            revision++;
            target = null;
            publish(empty);
        },
        async saveEdit() {
            if (!target || pending || busy || !current(generation) || state.needsReload || state.status === 'deleted')
                return;
            const normalized = normalizeMessageText(state.draft);
            if (!normalized.ok) {
                publish({ ...state, status: 'error', error: normalized.error });
                return;
            }
            pending = { target: { ...target }, commandId: commandId(), body: normalized.text, revision, generation };
            await run();
        },
        retryEdit: run,
        async reloadEdit() {
            if (!target || pending || busy || !current(generation))
                return;
            const id = target.id, g = generation, sequence = ++readSequence;
            busy = true;
            try {
                const found = await host.credential();
                if (!found || !current(g) || sequence !== readSequence)
                    return;
                const result = await readReplyDetail(baseURL, found.credential, { messageId: id, readId: readId(), allowHttpLoopbackForTests: true }, request);
                if (!current(g))
                    return;
                if (!result.ok && (result.error === 'auth_required' || result.error === 'access_required')) {
                    host.denied(result.error);
                    return;
                }
                if (sequence !== readSequence)
                    return;
                const cookie = await host.cookie();
                if (!current(g) || sequence !== readSequence)
                    return;
                if (cookie !== found.credential.token) {
                    host.denied('auth_required');
                    return;
                }
                if (!result.ok) {
                    publish({ ...state, status: 'error', needsReload: true, error: result.error });
                    return;
                }
                const m = displayMessage(result.value);
                const accepted = await host.accept(m, found.credential.token);
                if (!current(g) || sequence !== readSequence)
                    return;
                if (!accepted) {
                    publish({ ...state, needsReload: true, error: 'invalid_response' });
                    return;
                }
                target = metadata(m);
                if (m.body === null) {
                    observe(m);
                    return;
                }
                publish({ ...state, version: m.version, needsReload: false, status: 'editing', error: undefined });
            }
            catch {
                if (current(g) && sequence === readSequence)
                    publish({ ...state, status: 'error', needsReload: true, error: 'transport_error' });
            }
            finally {
                if (current(g) && sequence === readSequence)
                    busy = false;
            }
        },
        getSnapshot: () => state,
    };
}

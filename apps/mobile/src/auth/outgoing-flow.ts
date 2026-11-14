import { discardOutgoing, enqueue, retry } from '../chat/queue';
import type { QueueState } from '../chat/types';
import type { TransportError, TransportSession } from '../chat/transport';
import type { AuthView } from './auth-view';
export type PendingOutgoing = {
    readonly body: string;
    readonly revision: number;
    id: string | null;
    replyToId?: string;
    redacted?: boolean;
};
type SendResult = {
    ok: true;
    value: {
        replay: boolean;
        hidden?: true;
    };
} | {
    ok: false;
    error: TransportError | 'invalid_cursor' | 'reply_unavailable';
};
type Host = {
    pending: PendingOutgoing | null;
    sending: boolean;
    queue: QueueState | null;
    outgoingClientId: string | null;
    view(): AuthView;
    generation(): number;
    draftRevision(): number;
    publish(view: AuthView): void;
    denied(error: string): void;
    discover(valid?: () => boolean): Promise<{
        credential: TransportSession;
        changed: boolean;
    } | null>;
    commandId(): string;
    canSend?(): boolean;
    beforeSend?(valid: () => boolean): Promise<boolean>;
    prepare?(command: PendingOutgoing, credential: TransportSession, valid: () => boolean): Promise<boolean>;
    settle?(clientId: string, draftRevision: number): Promise<void>;
    discard?(clientId: string | null, draftRevision: number): Promise<boolean>;
    send(id: string, credential: TransportSession, valid: () => boolean): Promise<SendResult>;
    sendReply(id: string, target: string, credential: TransportSession, generation: number, valid: () => boolean): Promise<SendResult>;
};
/** One active local operation. Discard invalidates callbacks, not the server write. */
export function createOutgoingFlow(host: Host) {
    let operation = 0, confirmationSerial = 0;
    let confirmation: {
        token: string;
        command: PendingOutgoing;
        generation: number;
        operation: number;
    } | null = null;
    const clearConfirmation = () => { confirmation = null; };
    async function send() {
        let initial = host.view();
        if (host.sending || initial.chatSuspended || initial.phase !== 'signed_in' || !host.queue || (host.canSend && !host.canSend()))
            return;
        host.sending = true;
        const generation = host.generation(), active = ++operation;
        if (host.beforeSend) {
            try {
                if (!await host.beforeSend(() => generation === host.generation() && active === operation)
                    || generation !== host.generation() || active !== operation) {
                    if (generation === host.generation() && active === operation) host.sending = false;
                    return;
                }
            } catch { if (generation === host.generation() && active === operation) host.sending = false; return; }
            initial = host.view();
        }
        const command = host.pending ?? { redacted: false, body: initial.draft, revision: host.draftRevision(), id: null,
            ...(initial.replyTarget ? { replyToId: initial.replyTarget.id } : {}) };
        host.pending = command;
        const valid = () => generation === host.generation() && active === operation && host.pending === command;
        clearConfirmation();
        host.publish({ ...host.view(), discardConfirmation: undefined, outgoingPending: true, error: null, hiddenAcknowledged: undefined,
            outgoing: command.redacted ? undefined : { body: command.body, status: 'sending', ...(command.replyToId ? { replyToId: command.replyToId } : {}) } });
        try {
            const found = await host.discover(valid);
            if (!valid() || !found || found.changed || !host.queue)
                return;
            const credential = found.credential;
            command.id ??= host.commandId();
            const id = command.id;
            host.outgoingClientId = id;
            const added = enqueue(host.queue, credential.scope, id, command.body, command.replyToId);
            if (!added.ok) {
                host.pending = null;
                host.publish({ ...host.view(), outgoingPending: undefined, outgoing: undefined, error: added.error });
                return;
            }
            host.queue = added.state;
            if (host.queue.messages.find(item => item.clientId === id)?.status === 'failed') {
                const retried = retry(host.queue, credential.scope, id);
                if (retried.ok)
                    host.queue = retried.state;
            }
            if (host.prepare && !await host.prepare(command, credential, valid)) {
                if (valid()) host.publish({ ...host.view(), error: 'journal_unavailable' });
                return;
            }
            if (!valid()) return;
            const result = command.replyToId
                ? await host.sendReply(id, command.replyToId, credential, generation, valid)
                : await host.send(id, credential, valid);
            if (generation !== host.generation())
                return;
            // Revocation remains authoritative even when this local attempt was discarded.
            if (!result.ok && (result.error === 'auth_required' || result.error === 'access_required')) {
                host.denied(result.error);
                return;
            }
            if (active !== operation)
                return;
            if (host.queue?.messages.find(item => item.clientId === id)?.deleted) {
                await host.settle?.(id, command.revision);
                if (generation !== host.generation() || active !== operation) return;
                host.pending = null;
                host.outgoingClientId = null;
                host.publish({ ...host.view(), outgoingPending: undefined, outgoing: undefined,
                    draft: host.draftRevision() === command.revision ? '' : host.view().draft });
                return;
            }
            if (!valid() || host.view().chatSuspended)
                return;
            if (result.ok) {
                await host.settle?.(id, command.revision);
                if (!valid()) return;
                const hidden = result.value.hidden === true;
                host.pending = null;
                host.publish({ ...host.view(), outgoingPending: undefined, error: null,
                    draft: host.draftRevision() === command.revision ? '' : host.view().draft,
                    ...(host.draftRevision() === command.revision ? { replyTarget: undefined } : {}),
                    hiddenAcknowledged: hidden || undefined, outgoing: hidden || command.redacted ? undefined : {
                        body: host.queue?.messages.find(item => item.clientId === id)?.canonicalBody ?? command.body,
                        status: 'sent', ...(command.replyToId ? { replyToId: command.replyToId } : {}),
                    } });
            }
            else if (result.error === 'reply_unavailable') {
                // Preserve access to explicit local discard; never strand a failed row.
                command.redacted = true;
                host.publish({ ...host.view(), outgoingPending: true, outgoing: undefined, error: result.error,
                    ...(host.view().replyTarget?.id === command.replyToId ? { replyTarget: undefined } : {}) });
            }
            else
                host.denied(result.error);
        }
        catch {
            if (valid())
                host.publish({ ...host.view(), error: 'transport_error' });
        }
        finally {
            if (generation === host.generation() && active === operation) {
                host.sending = false;
                if (!host.pending && confirmation) {
                    clearConfirmation();
                    host.publish({ ...host.view(), discardConfirmation: undefined });
                }
                if (host.pending && !host.pending.redacted && !host.view().chatSuspended)
                    host.publish({ ...host.view(), outgoing: {
                            body: host.pending.body, status: 'retry', ...(host.pending.replyToId ? { replyToId: host.pending.replyToId } : {}),
                        } });
            }
        }
    }
    return {
        send,
        forgetDiscardConfirmation: clearConfirmation,
        reset() { operation++; confirmationSerial++; clearConfirmation(); },
        beginDiscardOutgoing() {
            if (!host.pending || host.view().phase !== 'signed_in')
                return;
            confirmation = { token: String(++confirmationSerial), command: host.pending, generation: host.generation(), operation };
            host.publish({ ...host.view(), discardConfirmation: { token: confirmation.token, clientId: host.pending.id, wasInFlight: host.sending } });
        },
        cancelDiscardOutgoing() { clearConfirmation(); host.publish({ ...host.view(), discardConfirmation: undefined }); },
        confirmDiscardOutgoing(token: string) {
            const selected = confirmation;
            if (!selected || selected.token !== token || selected.generation !== host.generation() || selected.operation !== operation
                || selected.command !== host.pending || host.view().phase !== 'signed_in')
                return;
            const command = selected.command;
            const finish = () => {
            if (command.id && host.queue && host.queue.messages.find(item => item.clientId === command.id)?.status !== 'accepted') {
                const removed = discardOutgoing(host.queue, host.queue.scope, command.id);
                if (!removed.ok)
                    return;
                host.queue = removed.state;
            }
            operation++;
            clearConfirmation();
            host.pending = null;
            host.sending = false;
            host.outgoingClientId = null;
            host.publish({ ...host.view(), outgoingPending: undefined, discardConfirmation: undefined, outgoing: undefined, error: null,
                ...(host.draftRevision() === command.revision ? { draft: '', replyTarget: undefined } : {}) });
            };
            if (!host.discard) { finish(); return; }
            const current = host.generation(), discarded = ++operation;
            host.sending = true; command.redacted = true; clearConfirmation();
            host.publish({ ...host.view(), outgoing: undefined, discardConfirmation: undefined });
            return host.discard(command.id, command.revision).then(ok => {
                if (current !== host.generation() || operation !== discarded || host.pending !== command) return;
                if (ok) finish(); else { host.sending = false; host.publish({ ...host.view(), error: 'journal_unavailable' }); }
            }).catch(() => { if (current === host.generation() && operation === discarded) { host.sending = false; host.publish({ ...host.view(), error: 'journal_unavailable' }); } });
        },
    };
}

import { deleteChatMessage, type DeleteTarget } from '../chat/delete-transport';
import { displayMessage, type DisplayMessage } from '../chat/reply-view';
import type { TransportSession } from '../chat/transport';

export type DeleteState = Readonly<{
  status: 'idle' | 'confirming' | 'sending' | 'unknown' | 'error' | 'deleted';
  confirmation?: Readonly<{ token: string; messageId: string; version: number; seq: number; createdAt: string }>;
  pendingId?: string;
  error?: string;
}>;
type Host = {
  capture(): { generation: number; session: TransportSession } | null;
  find(id: string): DisplayMessage | undefined;
  credential(): Promise<{ credential: TransportSession } | null>;
  cookie(): Promise<string | null>;
  publish(state: DeleteState): void;
  denied(error: string): void;
  accept(message: DisplayMessage): boolean;
};
/** A confirmation is not a command. Only explicit confirmation allocates its retry key. */
export function createChatDelete(baseURL: string, host: Host,
  request: (request: Request) => Promise<Response>, commandId: () => string) {
  let serial = 0;
  let state: DeleteState = { status: 'idle' };
  let selection: { token: string; message: DeleteTarget; generation: number } | null = null;
  let pending: { message: DeleteTarget; commandId: string; generation: number } | null = null;
  let busy = false;
  const publish = (next: DeleteState) => { state = next; host.publish(next); };
  const current = (generation: number) => host.capture()?.generation === generation;
  async function run() {
    const command = pending;
    if (!command || busy || !current(command.generation)) return;
    busy = true;
    publish({ status: 'sending', pendingId: command.message.id });
    try {
      const found = await host.credential();
      if (!current(command.generation) || pending !== command) return;
      if (!found) { publish({ status: 'unknown', pendingId: command.message.id }); return; }
      const result = await deleteChatMessage(baseURL, found.credential, {
        message: command.message, commandId: command.commandId, allowHttpLoopbackForTests: true,
      }, request);
      if (!current(command.generation) || pending !== command) return;
      if (!result.ok && (result.error === 'auth_required' || result.error === 'access_required')) {
        host.denied(result.error); return;
      }
      const cookie = await host.cookie();
      if (!current(command.generation) || pending !== command) return;
      if (cookie !== found.credential.token) { host.denied('auth_required'); return; }
      if (!result.ok) {
        if (result.error === 'message_deleted') {
          if (!host.accept(displayMessage(result.message))) {
            publish({ status: 'unknown', pendingId: command.message.id, error: 'invalid_response' }); return;
          }
        }
        const definitive = ['message_unavailable', 'version_conflict', 'message_deleted', 'idempotency_conflict', 'rejected', 'invalid_request'].includes(result.error);
        if (definitive) pending = null;
        publish({ status: definitive ? 'error' : 'unknown', error: result.error,
          ...(definitive ? {} : { pendingId: command.message.id }) });
        return;
      }
      if (!current(command.generation) || pending !== command) return;
      if (!host.accept(displayMessage(result.value.message))) {
        publish({ status: 'unknown', pendingId: command.message.id, error: 'invalid_response' }); return;
      }
      pending = null;
      publish({ status: 'deleted' });
    } catch {
      if (current(command.generation) && pending === command) publish({ status: 'unknown', pendingId: command.message.id, error: 'transport_error' });
    } finally { if (current(command.generation)) busy = false; }
  }
  return {
    reset() { serial++; selection = null; pending = null; busy = false; state = { status: 'idle' }; },
    beginDelete(id: string) {
      const context = host.capture(), message = host.find(id);
      if (!context || busy || pending || !message || message.body === null || message.senderId !== context.session.scope.userId) return;
      const token = String(++serial);
      const { id: messageId, coupleId, senderId, clientId, seq, version, createdAt } = message;
      const target: DeleteTarget = Object.freeze({ id: messageId, coupleId, senderId, clientId,
        seq, version, createdAt, replyToId: message.replyToId ?? null });
      selection = { token, message: target, generation: context.generation };
      publish({ status: 'confirming', confirmation: { token, messageId: id, version: message.version, seq: message.seq, createdAt: message.createdAt } });
    },
    cancelDelete() {
      if (pending || busy) return;
      serial++; selection = null; publish({ status: 'idle' });
    },
    async confirmDelete(token: string) {
      const chosen = selection;
      if (!chosen || token !== chosen.token || busy || pending || !current(chosen.generation)) return;
      const live = host.find(chosen.message.id);
      if (!live || live.body === null || live.version !== chosen.message.version) {
        selection = null; publish({ status: 'error', error: 'message_deleted' }); return;
      }
      pending = { message: chosen.message, commandId: commandId(), generation: chosen.generation };
      selection = null;
      await run();
    },
    retryDelete: run,
    getSnapshot: () => state,
  };
}

import { readReplyDetail } from '../chat/reply-transport';
import { displayMessage, type DisplayMessage } from '../chat/reply-view';
import type { TransportSession } from '../chat/transport';
/** The caller supplies only a target recovered from authenticated scoped ciphertext. */
export async function verifyJournalReply(id: string, valid: () => boolean, host: {
    baseURL: string;
    discover(valid: () => boolean): Promise<{
        credential: TransportSession;
        changed: boolean;
    } | null>;
    request(input: Request, valid?: () => boolean): Promise<Response>;
    readId(): string;
    cookie(): Promise<string>;
    denied(error: string): void;
    current(): boolean;
    accept(message: DisplayMessage, token: string, revision: number | undefined, valid: () => boolean): Promise<boolean>;
    select(message: DisplayMessage): void;
}) {
    const found = await host.discover(valid);
    if (!found || found.changed || !valid())
        return false;
    const result = await readReplyDetail(host.baseURL, found.credential, { messageId: id, readId: host.readId(), allowHttpLoopbackForTests: true }, input => host.request(input, valid));
    if (!host.current())
        return false;
    if (!result.ok && (result.error === 'auth_required' || result.error === 'access_required')) {
        host.denied(result.error);
        return false;
    }
    if (!valid())
        return false;
    const cookie = await host.cookie();
    if (!host.current() || !valid())
        return false;
    if (cookie !== found.credential.token) {
        host.denied('auth_required');
        return false;
    }
    if (!result.ok)
        return false;
    const message = displayMessage(result.value);
    if (!await host.accept(message, cookie, result.visibilityRevision, valid) || !valid() || message.body === null)
        return false;
    host.select(message);
    return true;
}

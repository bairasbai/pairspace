import type { HiddenMessage } from '../chat/visibility-model';
import type { DisplayMessage } from '../chat/reply-view';
/** Metadata-only committed receipts still require the current cookie and visibility scope. */
export function createReceiptVerifier(capture: () => {
    generation: number;
    revision: number | null;
}, cookie: () => Promise<string | null>, acceptDeleted?: (message: DisplayMessage, token: string, revision: number, valid: () => boolean) => Promise<boolean>) {
    return async (token: string, revision: number | undefined, message?: HiddenMessage, valid: () => boolean = () => true) => {
        const initial = capture();
        if (revision === undefined || revision !== initial.revision || !valid())
            return false;
        const actual = await cookie();
        const current = capture();
        if (actual !== token || current.generation !== initial.generation || current.revision !== revision || !valid())
            return false;
        if (message?.deletedAt !== null && message !== undefined && acceptDeleted) {
            const { replyToId, deletedAt, ...metadata } = message;
            return acceptDeleted({ ...metadata, body: null, ...(replyToId === null ? {} : { replyToId }), deletedAt }, token, revision, valid);
        }
        return true;
    };
}

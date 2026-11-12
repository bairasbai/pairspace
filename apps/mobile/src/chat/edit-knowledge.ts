import type { DisplayMessage } from './reply-view';
export type BodyDigest = (body: string) => Promise<string>;
export const webBodyDigest: BodyDigest = async (body) => {
    const bytes = new TextEncoder().encode(body);
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
};
type Floor = Readonly<{
    id: string;
    coupleId: string;
    senderId: string;
    clientId: string;
    seq: number;
    createdAt: string;
    replyToId?: string;
    version: number;
    digest: string;
}>;
const identity = (a: Floor, b: DisplayMessage) => a.id === b.id && a.coupleId === b.coupleId
    && a.senderId === b.senderId && a.clientId === b.clientId && a.seq === b.seq
    && a.createdAt === b.createdAt && a.replyToId === b.replyToId;
/** Non-evicting edited-live metadata only: no message plaintext is retained here. */
export function createEditKnowledge(digest: BodyDigest = webBodyDigest, limit = 500) {
    let floors = new Map<string, Floor>(), generation = 0, revision = 0;
    return {
        reset() { generation++; revision++; floors = new Map(); },
        async prepare(messages: readonly DisplayMessage[]) {
            const current = generation;
            const hashes = new Map<string, string>();
            for (const message of messages) {
                if (message.body !== null && message.version > 1) {
                    const hash = await digest(message.body);
                    if (!/^[0-9a-f]{64}$/.test(hash))
                        throw Error('invalid_digest');
                    hashes.set(message.id, hash);
                }
            }
            if (current !== generation)
                return null;
            const staged = new Map(floors);
            for (const message of messages) {
                const old = staged.get(message.id);
                if (old && (!identity(old, message) || message.version < old.version))
                    return null;
                if (message.body === null)
                    continue;
                if (old && message.version === old.version && hashes.get(message.id) !== old.digest)
                    return null;
                if (message.version > 1) {
                    const { body: _body, deletedAt: _deletedAt, ...metadata } = message;
                    staged.set(message.id, { ...metadata, digest: hashes.get(message.id)! });
                }
            }
            if (staged.size > limit)
                throw Error('edit_knowledge_limit');
            const observedRevision = revision;
            return {
                isCurrent: () => current === generation && observedRevision === revision,
                commit() { floors = staged; revision++; },
            };
        },
        // Exposed only as counts for bounded-state verification, never hashes or private text.
        size: () => floors.size,
    };
}

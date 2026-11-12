import { selectReply, type DisplayMessage, type ReplySelection } from './reply-view';
/** Preserve the chosen window and object references when only an off-window item changes. */
export function reconcileVisible(messages: readonly DisplayMessage[], detail: DisplayMessage | undefined, target: ReplySelection | undefined, incoming: readonly DisplayMessage[]) {
    const replacements = new Map(incoming.map(message => [message.id, message]));
    const update = (old: DisplayMessage) => {
        const next = replacements.get(old.id);
        return next && (next.version !== old.version || next.deletedAt !== old.deletedAt || next.body !== old.body) ? next : old;
    };
    const changed = messages.some(message => update(message) !== message);
    const nextDetail = detail ? update(detail) : undefined;
    const selected = target && replacements.get(target.id);
    const nextTarget = selected ? selected.body === null ? undefined :
        target.preview !== [...selected.body].slice(0, 90).join('') ? selectReply(selected) : target : target;
    return { messages: changed ? messages.map(update) : messages, replyDetail: nextDetail, replyTarget: nextTarget };
}

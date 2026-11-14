import { webBodyDigest, type BodyDigest } from '../chat/edit-knowledge';
import type { V2DiscussionMessage } from './morning-discussion-v2-model';
type Metadata = Omit<V2DiscussionMessage, 'body'>;
type Edited = Metadata & { digest: string };
const identity = (a: Metadata, b: Metadata) => a.id === b.id && a.slotId === b.slotId
  && a.coupleId === b.coupleId && a.membershipEpoch === b.membershipEpoch && a.authorId === b.authorId
  && a.clientId === b.clientId && a.seq === b.seq && a.createdAt === b.createdAt;
const collision = (a: Metadata, b: Metadata) => a.id === b.id || (a.coupleId === b.coupleId
  && a.membershipEpoch === b.membershipEpoch && a.slotId === b.slotId
  && (a.seq === b.seq || (a.authorId === b.authorId && a.clientId === b.clientId)));
const meta = ({ body: _body, ...metadata }: V2DiscussionMessage): Metadata => ({ ...metadata });
/** Only edited-body digests and terminal metadata persist off-window. Reset on authentication change. */
export function createMorningDiscussionKnowledge(digest: BodyDigest = webBodyDigest, limit = 500) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw Error('invalid_knowledge_limit');
  let edited = new Map<string, Edited>(), terminal = new Map<string, Metadata>();
  let revision = 0;
  return {
    reset() { edited.clear(); terminal.clear(); revision++; },
    sizes: () => ({ edited: edited.size, terminal: terminal.size }),
    async prepare(messages: readonly V2DiscussionMessage[], visible: readonly V2DiscussionMessage[] = []) {
      const observed = revision;
      const input = messages.map(message => ({ ...message }));
      const displayed = visible.map(message => ({ ...message }));
      const nextEdited = new Map(edited), nextTerminal = new Map(terminal);
      const hashes = new Map<string, string>();
      for (const message of input) {
        if (message.body !== null && message.version > 1) {
          const hash = await digest(message.body);
          if (!/^[0-9a-f]{64}$/.test(hash)) throw Error('invalid_digest');
          hashes.set(message.id, hash);
        }
      }
      if (observed !== revision) return null;
      const output: V2DiscussionMessage[] = [];
      for (const message of input) {
        const known = [...nextEdited.values(), ...nextTerminal.values(), ...displayed, ...output];
        for (const prior of known) {
          if (collision(prior, message) && !identity(prior, message)) return null;
        }
        const dead = nextTerminal.get(message.id);
        if (dead) {
          if (message.body !== null) {
            output.push({ ...dead, body: null }); continue;
          }
          if (message.version !== dead.version || message.deletedAt !== dead.deletedAt || message.editedAt !== dead.editedAt) return null;
        }
        const floor = nextEdited.get(message.id);
        const shown = displayed.find(prior => prior.id === message.id);
        if (shown && (message.version < shown.version || (message.version === shown.version
          && (message.body !== shown.body || message.editedAt !== shown.editedAt || message.deletedAt !== shown.deletedAt)))) return null;
        if (shown?.deletedAt && message.body !== null) return null;
        if (floor && (message.version < floor.version
          || (floor.editedAt !== null && (message.editedAt === null || message.editedAt < floor.editedAt)) || (message.version === floor.version
          && (message.editedAt !== floor.editedAt || message.deletedAt !== floor.deletedAt || hashes.get(message.id) !== floor.digest)))) return null;
        if (message.body === null) {
          nextTerminal.set(message.id, meta(message)); nextEdited.delete(message.id);
        } else if (message.version > 1) nextEdited.set(message.id, { ...meta(message), digest: hashes.get(message.id)! });
        output.push(message);
      }
      if (nextEdited.size > limit) throw Error('edit_knowledge_limit');
      if (nextTerminal.size > limit) throw Error('terminal_knowledge_limit');
      return {
        messages: output,
        isCurrent: () => observed === revision,
        commit() {
          if (observed !== revision) return false;
          edited = nextEdited; terminal = nextTerminal; revision++; return true;
        },
      };
    },
  };
}

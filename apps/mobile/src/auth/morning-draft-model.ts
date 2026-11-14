import { keys, record } from '../chat/reply-model';
import { normalizeMessageText } from '../chat/text';
import { canonicalMorningSlot, parseMorningSlot, type MorningScope, type MorningSlot } from './morning-model';
export type SavedMorningDraft = { slot: MorningSlot; body: string | null; version: number; state: 'missing' | 'live' | 'deleted'; serverNow: string };
const iso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
/** Private saved draft route; ordinary recipient metadata never includes this state. */
export function parseSavedMorningDraft(value: unknown, scope: MorningScope, target: MorningSlot,
  identity: { readId: string } | { commandId: string }): SavedMorningDraft | null {
  if (!record(value) || !keys(value, 'readId' in identity ? 'readId,serverNow,slot,body,version,state' : 'commandId,replay,serverNow,slot,body,version,state')
    || ('readId' in identity ? value.readId !== identity.readId : value.commandId !== identity.commandId || typeof value.replay !== 'boolean')
    || !iso(value.serverNow) || !Number.isInteger(value.version) || Number(value.version) < 0 || Number(value.version) > 2147483646) return null;
  const slot = parseMorningSlot(value.slot, scope), text = normalizeMessageText(value.body);
  if (!slot || slot.id !== target.id || slot.senderId !== scope.userId
    || !canonicalMorningSlot(target, slot)
    || ((slot.state === 'sealed') !== (slot.releaseAt > value.serverNow))
    || (value.state === 'missing' ? value.version !== 0 || value.body !== null || slot.prepared || !('readId' in identity)
      : value.state === 'live' ? Number(value.version) < 1 || !text.ok || text.text !== value.body
        : value.state === 'deleted' ? Number(value.version) < 2 || value.body !== null : true)) return null;
  return { slot, body: value.body as string | null, version: Number(value.version), state: value.state as SavedMorningDraft['state'], serverNow: value.serverNow };
}

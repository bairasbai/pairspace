import { keys, record } from '../chat/reply-model';
import { normalizeMessageText } from '../chat/text';
import { canonicalMorningSlot, parseMorningSlot, type MorningScope, type MorningSlot } from './morning-model';
export type PreparedMorning = { slot: MorningSlot; body: string; version: number; serverNow: string };
const iso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
/** Separate author-only route: old sealed-recipient and ordinary detail schemas stay unchanged. */
export function parsePreparedMorning(value: unknown, scope: MorningScope, target: MorningSlot,
  identity: { readId: string } | { commandId: string }): PreparedMorning | null {
  if (!record(value) || !keys(value, 'readId' in identity ? 'readId,serverNow,slot,body,version' : 'commandId,replay,serverNow,slot,body,version')
    || ('readId' in identity ? value.readId !== identity.readId : value.commandId !== identity.commandId || typeof value.replay !== 'boolean')
    || !iso(value.serverNow) || !Number.isInteger(value.version) || Number(value.version) < 1 || Number(value.version) > 2147483646) return null;
  const slot = parseMorningSlot(value.slot, scope), text = normalizeMessageText(value.body);
  if (!slot || slot.id !== target.id || slot.senderId !== scope.userId || !slot.prepared || !text.ok || text.text !== value.body
    || !canonicalMorningSlot(target, slot) || slot.state === 'missed'
    || ((slot.state === 'sealed') !== (slot.releaseAt > value.serverNow))
    || ('readId' in identity && slot.state !== 'sealed')) return null;
  return { slot, body: text.text, version: Number(value.version), serverNow: value.serverNow };
}

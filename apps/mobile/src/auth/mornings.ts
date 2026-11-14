import { parseMorningPreference as preferenceInput, resolveMorning, type MorningChoice } from '../../../../packages/domain/letters/morning';
import { normalizeMessageText } from '../chat/text';
import { historyReadId } from '../chat/read-identity';
import { keys, record, uuid } from '../chat/reply-model';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { requestMorning, sameMorningContext } from './morning-request';
import { parseMorningSlot, parseMorningPreference, parseMorningPage, canonicalMorningSlot, type MorningSlot, type Preference, type MorningPage, type MorningScope } from './morning-model';
type Draft = {
    text: string;
    revision: number;
};
type Command = {
    id: string;
    selection: number;
} & ({
    kind: 'preference';
    expected: number;
    timezone: string;
    localTime: string;
    revision: number;
} | {
    kind: 'assign';
    preference: Preference;
    localDate: string;
    offset: string;
    releaseAt: string;
    revision: number;
} | {
    kind: 'fill';
    slot: MorningSlot;
    body: string;
    revision: number;
} | {
    kind: 'open';
    slot: MorningSlot;
});
export type MorningView = Readonly<{
    available: boolean;
    userId?: string;
    busy: boolean;
    status: 'idle' | 'ready' | 'sending' | 'sent' | 'unknown' | 'invalid' | 'error';
    error?: string;
    preferences: readonly Preference[];
    slots: readonly MorningSlot[];
    history: MorningPage | null;
    selected: MorningSlot | null;
    opened: {
        slot: MorningSlot;
        body: string;
    } | null;
    draft: string;
    savedDraftSlots: readonly MorningSlot[];
    preferenceForm: {
        timezone: string;
        localTime: string;
    };
    localDate: string;
    offset: string;
    choices: readonly MorningChoice[];
    serverNow: string | null;
    pendingId?: string;
    confirmation?: {
        token: string;
        kind: 'assign' | 'fill';
        slot?: MorningSlot;
        preference?: Preference;
        localDate?: string;
        offset?: string;
        releaseAt?: string;
    };
}>;
const empty: MorningView = { available: false, busy: false, status: 'idle', preferences: [], slots: [], history: null,
    selected: null, opened: null, draft: '', savedDraftSlots: [], preferenceForm: { timezone: '', localTime: '' },
    localDate: '', offset: '', choices: [], serverNow: null };
const iso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
/** Pair-scoped, bounded RAM only. No notification, automatic assignment, or journal integration. */
export function createMorningsController(config: SyntheticConfig, host: InvitationHost, request: (input: Request) => Promise<Response>, commandId: () => string) {
    const settings = Object.freeze({ ...config });
    validateSyntheticConfig(settings);
    let view = empty, bound: InvitationHostSnapshot | null = null, sequence = 0, selection = 0;
    let formRevision = 0, dateRevision = 0, confirmationSerial = 0, draftSerial = 0;
    let pending: Command | null = null, confirmation: {
        token: string;
        command: Command;
    } | null = null;
    let active: 'read' | 'write' | null = null;
    let partnerId: string | null = null;
    const drafts = new Map<string, Draft>(), known = new Map<string, MorningSlot>();
    const listeners = new Set<() => void>();
    const publish = (next: MorningView) => { view = next; listeners.forEach(fn => fn()); };
    function reset() {
        sequence++;
        selection++;
        formRevision++;
        dateRevision++;
        bound = null;
        pending = null;
        confirmation = null;
        active = null; partnerId = null;
        drafts.clear();
        known.clear();
        publish(empty);
    }
    function sync() {
        const next = host.capture();
        if (bound && next && next.generation === bound.generation && next.identity === bound.identity
            && sameMorningContext(next.context, bound.context))
            return;
        reset();
        if (next?.context.state === 'ready') {
            bound = next;
            publish({ ...empty, available: true, userId: next.context.userId });
        }
    }
    const scope = (): MorningScope | null => bound?.context.state === 'ready' ? bound.context : null;
    const partnerPreference = () => view.preferences.find(p => p.userId !== scope()?.userId);
    function choices(localDate: string, preferences = view.preferences) {
        const preference = preferences.find(p => p.userId !== scope()?.userId);
        return preference ? resolveMorning(localDate, preference.localTime, preference.timezone) : [];
    }
    function prune() {
        const keep = new Set([...view.slots.map(s => s.id), ...drafts.keys(), ...(view.selected ? [view.selected.id] : []),
            ...(view.opened ? [view.opened.slot.id] : []), ...(pending && (pending.kind === 'fill' || pending.kind === 'open') ? [pending.slot.id] : [])]);
        for (const id of known.keys())
            if (!keep.has(id))
                known.delete(id);
        publish({ ...view, savedDraftSlots: [...drafts.keys()].flatMap(id => known.has(id) ? [known.get(id)!] : []) });
    }
    function canonical(slot: MorningSlot, map = known) {
        const other = slot.senderId === scope()?.userId ? slot.recipientId : slot.senderId;
        if (partnerId && other !== partnerId) throw Error('invalid_response');
        const old = map.get(slot.id), value = old ? canonicalMorningSlot(old, slot) : slot;
        if (!value)
            throw Error('invalid_response');
        map.set(slot.id, value);
        return value;
    }
    function preference(p: Preference, prior = view.preferences): Preference {
        const old = prior.find(item => item.userId === p.userId);
        if (old && (p.version < old.version || (p.version === old.version && (p.timezone !== old.timezone || p.localTime !== old.localTime))))
            throw Error('invalid_response');
        return p;
    }
    function fail(error: string, status: MorningView['status'] = 'error') { publish({ ...view, status, error }); }
    async function run(kind: 'list' | 'open' | 'write', options: {
        direction?: 'latest' | 'oldest' | 'before' | 'after';
        id?: string;
        incoming?: boolean;
        onOpened?: (slot: MorningSlot) => void;
    } = {}) {
        if (!bound || !scope() || view.busy || (kind === 'write' && !pending))
            return;
        const expected = bound, serial = ++sequence, selected = selection, command = pending;
        const openedTarget = kind === 'open' ? options.id : command?.kind === 'open' ? command.slot.id : undefined;
        const previousBody = view.opened?.slot.id === openedTarget ? view.opened?.body : undefined;
        const currentScope = () => {
            const next = host.capture();
            return next !== null && bound === expected && next.generation === expected.generation && next.identity === expected.identity
                && sameMorningContext(next.context, expected.context);
        };
        const valid = () => currentScope() && serial === sequence;
        const s = scope()!, readId = historyReadId(), direction = options.direction ?? 'latest';
        const anchor = direction === 'before' ? view.history?.olderCursor : direction === 'after' ? view.history?.newerCursor : null;
        if (kind === 'list' && ['before', 'after'].includes(direction) && !anchor)
            return;
        active = kind === 'write' ? 'write' : 'read';
        publish({ ...view, busy: true, error: undefined, ...(kind === 'write' ? { status: 'sending' as const, pendingId: command!.id } : {}),
            ...(kind === 'open' ? { opened: null } : {}) });
        try {
            const query: Record<string, string> = { direction };
            if (anchor) {
                query.anchor_id = anchor.id;
                query.anchor_release_at = anchor.releaseAt;
            }
            const body = command?.kind === 'preference' ? { expected_version: command.expected, timezone: command.timezone, local_time: command.localTime }
                : command?.kind === 'assign' ? { preference_version: command.preference.version, local_date: command.localDate, offset: command.offset }
                    : command?.kind === 'fill' ? { body: command.body } : command?.kind === 'open' ? { confirm: true } : undefined;
            const path = kind === 'list' ? '' : kind === 'open' ? `/slots/${options.id}`
                : command!.kind === 'preference' ? '/preference' : command!.kind === 'assign' ? '/slots' : `/slots/${command!.slot.id}/${command!.kind === 'open' ? 'open' : 'body'}`;
            const result = await requestMorning(settings, host, expected, currentScope, request, {
                path, ...(kind === 'write' ? { method: command!.kind === 'assign' || command!.kind === 'open' ? 'POST' : 'PUT', commandId: command!.id, body }
                    : { readId, ...(kind === 'list' ? { query } : {}) }),
            });
            if (!currentScope())
                return;
            if (!result.ok && ['auth_required', 'access_required', 'scope_changed'].includes(result.error)) {
                const error = result.error;
                reset();
                if (error === 'scope_changed')
                    await host.refresh();
                else
                    host.block(error);
                return;
            }
            if (!valid())
                return;
            if (!result.ok) {
                const definitive = ['invalid_request', 'version_conflict', 'idempotency_conflict', 'slot_exists', 'slot_filled', 'slot_closed'].includes(result.error);
                if (kind === 'write' && definitive) {
                    pending = null;
                    publish({ ...view, pendingId: undefined });
                }
                if (result.error === 'invalid_cursor')
                    publish({ ...view, history: null });
                fail(result.error, kind === 'write' && !definitive ? 'unknown' : 'error');
                return;
            }
            if (kind === 'list') {
                const page = parseMorningPage(result.value, s, readId, direction, anchor ?? undefined);
                if (!page)
                    throw Error('invalid_response');
                const staged = new Map(known), slots = page.slots.map(slot => canonical(slot, staged));
                const preferences = page.preferences.map(p => preference(p));
                const other = preferences.find(p => p.userId !== s.userId)?.userId
                    ?? page.slots.map(slot => slot.senderId === s.userId ? slot.recipientId : slot.senderId)[0];
                if (partnerId && other && partnerId !== other) throw Error('invalid_response');
                partnerId = other ?? partnerId;
                known.clear();
                staged.forEach((slot, id) => known.set(id, slot));
                const nextChoices = choices(view.localDate, preferences);
                publish({ ...view, status: 'ready', history: page, serverNow: page.serverNow, slots, preferences,
                    selected: view.selected ? known.get(view.selected.id) ?? view.selected : null,
                    choices: nextChoices, offset: nextChoices.length === 1 ? nextChoices[0].offset : nextChoices.some(c => c.offset === view.offset) ? view.offset : '' });
            }
            else if (kind === 'open') {
                const value = result.value, slot = parseMorningSlot(value.slot, s);
                if (!keys(value, Object.hasOwn(value, 'body') ? 'readId,serverNow,slot,body' : 'readId,serverNow,slot')
                    || value.readId !== readId || !iso(value.serverNow) || !slot || slot.id !== options.id
                    || (options.incoming && slot.recipientId !== s.userId))
                    throw Error('invalid_response');
                const readable = slot.state === 'available' && (slot.senderId === s.userId || !!slot.openedAt);
                const text = normalizeMessageText(value.body);
                if (readable ? !text.ok || text.text !== value.body || (previousBody !== undefined && text.text !== previousBody) : Object.hasOwn(value, 'body'))
                    throw Error('invalid_response');
                if (slot.state === 'available' && !slot.openedAt && slot.releaseAt > value.serverNow)
                    throw Error('invalid_response');
                if (selection !== selected)
                    return;
                const accepted = canonical(slot);
                publish({ ...view, status: 'ready', selected: accepted, draft: drafts.get(slot.id)?.text ?? '',
                    opened: readable && text.ok ? { slot: accepted, body: text.text } : null });
                if (readable && text.ok) options.onOpened?.(accepted);
            }
            else if (command) {
                const value = result.value;
                if (value.commandId !== command.id || typeof value.replay !== 'boolean')
                    throw Error('invalid_response');
                if (command.kind === 'preference') {
                    const p = parseMorningPreference(value.preference, s);
                    if (!keys(value, 'commandId,replay,preference') || !p || p.userId !== s.userId || p.version < command.expected + 1
                        || (!value.replay && p.version !== command.expected + 1)
                        || (p.version === command.expected + 1 && (p.timezone !== command.timezone || p.localTime !== command.localTime)))
                        throw Error('invalid_response');
                    const accepted = preference(p);
                    publish({ ...view, preferences: [...view.preferences.filter(item => item.userId !== p.userId), accepted] });
                }
                else {
                    const slot = parseMorningSlot(value.slot, s);
                    if (!keys(value, command.kind === 'open' ? 'commandId,replay,slot,body' : 'commandId,replay,slot') || !slot || (command.kind === 'open' ? slot.recipientId !== s.userId : slot.senderId !== s.userId))
                        throw Error('invalid_response');
                    if (command.kind === 'assign' && (slot.recipientId !== command.preference.userId || slot.preferenceVersion !== command.preference.version
                        || slot.localDate !== command.localDate || slot.localTime !== command.preference.localTime || slot.timezone !== command.preference.timezone
                        || slot.offset !== command.offset || slot.releaseAt !== command.releaseAt || (!value.replay && slot.prepared)))
                        throw Error('invalid_response');
                    if (command.kind === 'fill' && (slot.id !== command.slot.id || !canonicalMorningSlot(command.slot, slot)
                        || !slot.prepared || slot.state === 'missed'))
                        throw Error('invalid_response');
                    const openBody = command.kind === 'open' ? normalizeMessageText(value.body) : null;
                    if (command.kind === 'open' && (slot.id !== command.slot.id || !canonicalMorningSlot(command.slot, slot)
                        || !slot.openedAt || slot.state !== 'available' || !openBody?.ok || openBody.text !== value.body
                        || (previousBody !== undefined && openBody.text !== previousBody)))
                        throw Error('invalid_response');
                    const accepted = canonical(slot);
                    if (command.kind === 'open') {
                        if (selection === command.selection && openBody?.ok)
                            publish({ ...view, ...(view.selected?.id === slot.id ? { selected: accepted } : {}), opened: { slot: accepted, body: openBody.text } });
                    }
                    else if (command.kind === 'fill') {
                        const draft = drafts.get(slot.id);
                        if (draft?.revision === command.revision)
                            drafts.delete(slot.id);
                        if (view.selected?.id === slot.id)
                            publish({ ...view, selected: accepted, draft: drafts.get(slot.id)?.text ?? '' });
                    }
                    else if (selection === command.selection && dateRevision === command.revision)
                        publish({ ...view, selected: accepted, draft: drafts.get(slot.id)?.text ?? '' });
                    publish({ ...view, slots: view.slots.map(item => item.id === slot.id ? accepted : item) });
                }
                pending = null;
                publish({ ...view, pendingId: undefined, status: 'sent', history: null });
            }
            prune();
        }
        catch (error) {
            if (valid())
                fail(error instanceof Error ? error.message : 'transport_error', kind === 'write' ? 'unknown' : 'error');
        }
        finally {
            if (valid()) {
                active = null;
                publish({ ...view, busy: false });
            }
        }
    }
    function selectSlot(id: string) {
        const slot = known.get(id);
        if (!view.available || !slot)
            return;
        selection++;
        confirmation = null;
        publish({ ...view, selected: slot, opened: null, draft: drafts.get(id)?.text ?? '', confirmation: undefined });
        prune();
    }
    function setDraft(text: string) {
        if (!view.available || !view.selected || view.selected.senderId !== scope()?.userId || typeof text !== 'string' || [...text].length > 8000)
            return;
        const id = view.selected.id, old = drafts.get(id);
        if (text && !old && drafts.size >= 30) {
            fail('draft_limit');
            return;
        }
        const revision = ++draftSerial;
        if (text)
            drafts.set(id, { text, revision });
        else
            drafts.delete(id);
        confirmation = null;
        publish({ ...view, draft: text, confirmation: undefined });
        prune();
    }
    function requestAssignment() {
        if (!view.available || view.busy || pending)
            return;
        const p = partnerPreference(), choice = view.choices.find(c => c.offset === view.offset), id = commandId();
        const ahead = choice && view.serverNow ? Date.parse(choice.releaseAt) - Date.parse(view.serverNow) : NaN;
        if (!p || !choice || !uuid(id) || !Number.isFinite(ahead) || ahead < 60000 || ahead > 366 * 86400000) {
            fail('invalid_schedule', 'invalid');
            return;
        }
        const command: Command = { kind: 'assign', id, preference: { ...p }, localDate: view.localDate,
            ...choice, revision: dateRevision, selection };
        const token = String(++confirmationSerial);
        confirmation = { token, command };
        publish({ ...view, confirmation: { token, kind: 'assign', preference: p, localDate: command.localDate, ...choice } });
    }
    function requestFill() {
        const slot = view.selected, text = normalizeMessageText(view.draft), id = commandId();
        if (!view.available || view.busy || pending)
            return;
        if (!slot || slot.senderId !== scope()?.userId || slot.state !== 'sealed' || slot.prepared || !text.ok || !uuid(id)) {
            fail('invalid_fill', 'invalid');
            return;
        }
        const token = String(++confirmationSerial);
        confirmation = { token, command: { kind: 'fill', id, slot: { ...slot }, body: text.text, revision: drafts.get(slot.id)?.revision ?? 0, selection } };
        publish({ ...view, confirmation: { token, kind: 'fill', slot } });
    }
    return { sync, reset, actions: {
            getSnapshot: () => view,
            subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
            list: (direction: 'latest' | 'oldest' | 'before' | 'after' = 'latest') => run('list', { direction }),
            latest: () => run('list'), oldest: () => run('list', { direction: 'oldest' }),
            older: () => run('list', { direction: 'before' }), newer: () => run('list', { direction: 'after' }),
            selectSlot, setDraft, clearDraft: () => setDraft(''),
            setPreference(patch: Partial<{
                timezone: string;
                localTime: string;
            }>) {
                if (!view.available || !record(patch) || Object.keys(patch).some(k => !['timezone', 'localTime'].includes(k))
                    || Object.entries(patch).some(([k, v]) => typeof v !== 'string' || v.length > (k === 'timezone' ? 100 : 5)))
                    return;
                formRevision++;
                confirmation = null;
                publish({ ...view, preferenceForm: { ...view.preferenceForm, ...patch }, confirmation: undefined });
            },
            async savePreference() {
                if (!view.available || view.busy || pending)
                    return;
                const p = preferenceInput(view.preferenceForm.timezone, view.preferenceForm.localTime), id = commandId();
                if (!p || !uuid(id)) {
                    fail('invalid_preference', 'invalid');
                    return;
                }
                pending = { kind: 'preference', id, ...p, expected: view.preferences.find(p => p.userId === scope()?.userId)?.version ?? 0, revision: formRevision, selection };
                await run('write');
            },
            setLocalDate(localDate: string) {
                if (!view.available || typeof localDate !== 'string' || localDate.length > 10)
                    return;
                dateRevision++;
                confirmation = null;
                const options = choices(localDate);
                publish({ ...view, localDate, choices: options, offset: options.length === 1 ? options[0].offset : '', confirmation: undefined });
            },
            chooseOffset(offset: string) {
                if (!view.available || !view.choices.some(c => c.offset === offset))
                    return;
                dateRevision++;
                confirmation = null;
                publish({ ...view, offset, confirmation: undefined });
            },
            requestAssignment, requestFill,
            cancelConfirmation() { confirmation = null; publish({ ...view, confirmation: undefined }); },
            async confirm(token: string) {
                const chosen = confirmation;
                if (!chosen || chosen.token !== token || pending || view.busy || !view.available)
                    return;
                pending = chosen.command;
                confirmation = null;
                publish({ ...view, confirmation: undefined });
                await run('write');
            },
            retry: () => pending ? run('write') : Promise.resolve(),
            async open(id: string) {
                const slot = known.get(id);
                if (!view.available || view.busy || !slot || slot.state !== 'available')
                    return;
                if (slot.recipientId === scope()?.userId && !slot.openedAt) {
                    if (pending)
                        return;
                    const command = commandId();
                    if (!uuid(command))
                        return;
                    pending = { kind: 'open', id: command, slot: { ...slot }, selection };
                    await run('write');
                }
                else
                    await run('open', { id });
            },
            async openDiscussionSlot(anchor: MorningSlot): Promise<MorningSlot | null> {
                const s = scope(), slot = s && parseMorningSlot(anchor, s);
                if (!view.available || !slot || active === 'write' || slot.state !== 'available'
                    || (slot.recipientId === s!.userId ? !slot.openedAt : !slot.prepared)) return null;
                if (active === 'read') { sequence++; active = null; publish({ ...view, busy: false }); }
                try {
                    const accepted = canonical(slot);
                    selectSlot(accepted.id);
                    const expected = bound, selected = selection, serial = sequence + 1;
                    let result: MorningSlot | null = null;
                    await run('open', { id: accepted.id, onOpened: value => { result = value; } });
                    return bound === expected && selection === selected && sequence === serial ? result : null;
                } catch { fail('invalid_response'); return null; }
            },
            openLastAvailable: () => view.history?.lastAvailableId ? run('open', { id: view.history.lastAvailableId, incoming: true }) : Promise.resolve(),
            close() {
                selection++;
                confirmation = null;
                if (active === 'read') {
                    sequence++;
                    active = null;
                }
                publish({ ...view, selected: null, opened: null, draft: '', confirmation: undefined, busy: active === 'write' });
                prune();
            },
        } };
}

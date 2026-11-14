import { readBoundedJson } from '../chat/transport';
import { readSessionContext } from './context';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { emptyScale, blankScale, parseScaleInput, validSlot, followsSlot, orderScale, validScaleDate, validScaleZone, exact, record, uuid, instant, sameDateContext, type ScaleView, type ScaleSlot, type ScaleCreate } from './scale-state';
type Pending = Readonly<{
    id: string;
    kind: 'create' | 'publish' | 'remove';
    target: string | null;
    version: number;
    value: number | null;
    date: string | null;
    zone: string | null;
    revision: number;
}>;
export function createScaleController(config: SyntheticConfig, host: InvitationHost, request: (input: Request) => Promise<Response>, commandId: () => string) {
    const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
    validateSyntheticConfig(settings);
    let view = emptyScale, bound: InvitationHostSnapshot | null = null, pending: Pending | null = null;
    let sequence = 0, createRevision = 0, editRevision = 0;
    const listeners = new Set<() => void>();
    const publish = (next: ScaleView) => { view = Object.freeze(next); for (const listener of listeners)
        listener(); };
    function reset() { sequence++; createRevision++; editRevision++; bound = null; pending = null; publish(emptyScale); }
    function sync() {
        const current = host.capture();
        if (bound && current && current.generation === bound.generation && current.identity === bound.identity && sameDateContext(current.context, bound.context))
            return;
        reset();
        if (current?.context.state === 'ready') {
            bound = current;
            publish({ ...emptyScale, available: true, userId: current.context.userId });
        }
    }
    function reconcileEditor(slots: readonly ScaleSlot[]): ScaleView['editor'] {
        const editor = view.editor;
        if (!editor)
            return null;
        const next = slots.find(s => s.id === editor.id), old = view.slots.find(s => s.id === editor.id);
        if (next?.version === editor.version)
            return editor;
        if (editor.value === (old?.state === 'active' ? String(old.value) : ''))
            return null;
        return { ...editor, stale: true };
    }
    function merge(slot: ScaleSlot): readonly ScaleSlot[] {
        const old = view.slots.find(s => s.id === slot.id);
        if ((old && !followsSlot(old, slot)) || view.slots.some(s => s.id !== slot.id && s.authorId === slot.authorId && s.localDate === slot.localDate) || (!old && view.slots.length >= 200))
            throw Error('retry');
        const slots = [...view.slots.filter(s => s.id !== slot.id), slot].sort(orderScale);
        const authors = new Set(slots.map(s => s.authorId));
        if (authors.size > 2 || (authors.size === 2 && !authors.has(view.userId!)) || slots.filter(s => s.authorId === slot.authorId).length > 100)
            throw Error('retry');
        return slots;
    }
    async function run(action: 'list' | 'mutate') {
        if (view.busy || !view.available || !bound || (action === 'mutate' && (!pending || view.requiresRefresh)))
            return;
        const expected = bound, command = pending, seq = ++sequence;
        const current = () => { const next = host.capture(); return sequence === seq && next !== null && next.generation === expected.generation && next.identity === expected.identity && sameDateContext(next.context, expected.context); };
        publish({ ...view, busy: true, error: false, ...(action === 'mutate' ? { status: 'saving' as const } : { checked: false }) });
        try {
            const cookie = await host.getCookie();
            if (!current())
                return;
            const binding = await readSessionContext(settings, expected.identity.sessionId, cookie, request);
            if (!current())
                return;
            if (!binding.ok) {
                if (binding.error !== 'transport_error') {
                    host.block('auth_required');
                    reset();
                    return;
                }
                throw Error('retry');
            }
            if (!sameDateContext(expected.context, binding.value)) {
                reset();
                await host.refresh();
                return;
            }
            const cookieMatches = async () => { const matches = await host.getCookie() === cookie; if (current() && !matches) {
                host.block('auth_required');
                reset();
            } return matches && current(); };
            if (!await cookieMatches())
                return;
            const context = binding.value;
            if (context.state !== 'ready')
                return;
            const mutate = action === 'mutate', kind = command?.kind;
            const payload = mutate ? { command_id: command!.id, membership_epoch: context.membershipEpoch, ...(kind === 'create' ? { expected_date: command!.date, timezone: command!.zone } : { expected_version: command!.version }), ...(kind !== 'remove' ? { value: command!.value } : {}) } : null;
            const response = await request(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/day-scale' + (mutate ? (command!.target ? '/' + command!.target : '') : '?membership_epoch=' + context.membershipEpoch), {
                method: mutate ? (kind === 'create' ? 'POST' : kind === 'publish' ? 'PUT' : 'DELETE') : 'GET', headers: { Cookie: cookie, Origin: settings.baseURL, ...(mutate ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
                ...(mutate ? { body: JSON.stringify(payload) } : {}), credentials: 'omit', redirect: 'error', cache: 'no-store'
            }));
            if (!current() || !await cookieMatches())
                return;
            if ([401, 403].includes(response.status)) {
                host.block('access_required');
                reset();
                return;
            }
            if (response.status === 404) {
                publish({ ...view, status: pending ? 'retry' : 'unavailable', error: true });
                return;
            }
            const body = await readBoundedJson(response, 524288);
            if (!current() || !await cookieMatches())
                return;
            if (record(body) && body.ok === false) {
                if (response.status === 409 && body.error === 'stale_membership') {
                    host.block('access_required');
                    reset();
                    return;
                }
                if (mutate && response.status === 409 && body.error === 'version_conflict') {
                    const slot = body.current;
                    if (!exact(body, 'ok,error,current') || !validSlot(slot, context) || slot.authorId !== context.userId || (command!.target ? slot.id !== command!.target : slot.localDate !== command!.date))
                        throw Error('retry');
                    const slots = merge(slot);
                    pending = null;
                    publish({ ...view, slots, editor: reconcileEditor(slots), ownUsed: Math.max(view.ownUsed, slots.filter(s => s.authorId === context.userId).length), pending: false, status: 'conflict', requiresRefresh: true, checked: false, error: true });
                    return;
                }
                if (response.status === 409 && ['idempotency_conflict', 'capacity_reached', 'date_mismatch'].includes(String(body.error))) {
                    pending = null;
                    publish({ ...view, pending: false, status: body.error === 'capacity_reached' ? 'limit' : body.error === 'date_mismatch' ? 'dateMismatch' : 'conflict', requiresRefresh: true, checked: false, error: true });
                    return;
                }
                if (mutate && response.status === 400 && body.error === 'invalid_request') {
                    pending = null;
                    publish({ ...view, pending: false, status: 'invalid', error: true });
                    return;
                }
            }
            if (response.status !== 200 || !record(body) || !exact(body, 'ok,value') || body.ok !== true || !record(body.value))
                throw Error('retry');
            const value = body.value;
            if (!mutate) {
                if (!exact(value, 'slots,checkedAt,capacityPerAuthor,ownUsed') || !instant(value.checkedAt) || (view.checkedAt !== null && value.checkedAt < view.checkedAt) || value.capacityPerAuthor !== 100
                    || !Array.isArray(value.slots) || value.slots.length > 200 || !Number.isSafeInteger(value.ownUsed) || Number(value.ownUsed) < view.ownUsed || Number(value.ownUsed) > 100)
                    throw Error('retry');
                const slots: ScaleSlot[] = [];
                for (const item of value.slots) {
                    if (!validSlot(item, context) || item.createdAt > value.checkedAt || slots.some(s => s.id === item.id || (s.authorId === item.authorId && s.localDate === item.localDate))
                        || (slots.length > 0 && orderScale(slots[slots.length - 1], item) > 0))
                        throw Error('retry');
                    slots.push(item);
                }
                const authors = new Set(slots.map(s => s.authorId));
                if (authors.size > 2 || (authors.size === 2 && !authors.has(context.userId)) || [...authors].some(author => slots.filter(s => s.authorId === author).length > 100) || slots.filter(s => s.authorId === context.userId).length !== value.ownUsed)
                    throw Error('retry');
                if (view.slots.some(old => { const next = slots.find(s => s.id === old.id); return !next || !followsSlot(old, next); }))
                    throw Error('retry');
                publish({ ...view, slots, editor: reconcileEditor(slots), ownUsed: Number(value.ownUsed), checked: true, checkedAt: value.checkedAt, requiresRefresh: false, status: pending ? 'retry' : 'idle' });
            }
            else {
                const slot = value.slot;
                if (!exact(value, 'slot,commandId,replay') || !validSlot(slot, context) || value.commandId !== command!.id || typeof value.replay !== 'boolean' || slot.authorId !== context.userId
                    || (command!.target !== null && slot.id !== command!.target) || slot.version < Math.max(1, command!.version)
                    || (kind === 'create' && (slot.localDate !== command!.date || slot.timezone !== command!.zone)))
                    throw Error('retry');
                if (!value.replay) {
                    if (![Math.max(1, command!.version), command!.version + 1].includes(slot.version) || (kind === 'create' && slot.version !== 1))
                        throw Error('retry');
                    if (kind === 'remove' ? slot.state !== 'removed' : slot.state !== 'active' || slot.value !== command!.value)
                        throw Error('retry');
                }
                const slots = merge(slot);
                pending = null;
                publish({ ...view, slots, editor: reconcileEditor(slots), ownUsed: Math.max(view.ownUsed, slots.filter(s => s.authorId === context.userId).length), checked: false, pending: false, status: 'saved',
                    ...(kind === 'create' && createRevision === command!.revision ? { create: blankScale } : {}),
                    ...(kind !== 'create' && view.editor?.id === command!.target && editRevision === command!.revision ? { editor: null } : {}) });
            }
        }
        catch {
            if (current())
                publish({ ...view, error: true, ...(action === 'mutate' ? { status: 'retry' as const } : {}) });
        }
        finally {
            if (current())
                publish({ ...view, busy: false });
        }
    }
    function prepare(kind: Pending['kind'], target: string | null = null, confirm = false) {
        if (!view.available || view.busy || pending || view.requiresRefresh)
            return Promise.resolve();
        const slot = view.slots.find(s => s.id === target);
        if (kind === 'create' && !view.checked) {
            publish({ ...view, status: 'conflict', requiresRefresh: true, error: true });
            return Promise.resolve();
        }
        if (kind === 'create' && view.ownUsed >= 100) {
            publish({ ...view, status: 'limit' });
            return Promise.resolve();
        }
        if (kind !== 'create' && (!slot || slot.authorId !== view.userId))
            return Promise.resolve();
        if (kind === 'publish') {
            if (!view.editor || view.editor.id !== target || view.editor.stale || view.editor.version !== slot!.version) {
                publish({ ...view, status: 'conflict', error: true });
                return Promise.resolve();
            }
            if (slot!.state === 'removed' && !confirm)
                return Promise.resolve();
        }
        if (kind === 'remove' && !confirm)
            return Promise.resolve();
        const value = kind === 'remove' ? null : parseScaleInput(kind === 'create' ? view.create.value : view.editor!.value), id = commandId();
        if (!uuid(id) || (kind !== 'remove' && value === null) || (kind === 'create' && (!validScaleDate(view.create.expectedDate) || !validScaleZone(view.create.timezone)))) {
            publish({ ...view, status: 'invalid' });
            return Promise.resolve();
        }
        pending = Object.freeze({ id, kind, target, version: slot?.version ?? 0, value, date: kind === 'create' ? view.create.expectedDate : null, zone: kind === 'create' ? view.create.timezone : null, revision: kind === 'create' ? createRevision : editRevision });
        publish({ ...view, pending: true });
        return run('mutate');
    }
    return { reset, sync, actions: { getSnapshot: () => view, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, load: () => run('list'), retry: () => run('mutate'),
            create: () => prepare('create'), save: (confirm = false) => prepare('publish', view.editor?.id ?? null, confirm), remove: (id: string, confirm: boolean) => prepare('remove', id, confirm),
            setCreateField(key: keyof ScaleCreate, value: string) { if (view.available) {
                createRevision++;
                publish({ ...view, create: { ...view.create, [key]: value.slice(0, key === 'value' ? 10 : 100) } });
            } },
            setValue(value: string) { if (view.available && view.editor) {
                editRevision++;
                publish({ ...view, editor: { ...view.editor, value: value.slice(0, 10) } });
            } },
            beginEdit(id: string) {
                const slot = view.slots.find(s => s.id === id);
                if (!view.available || view.busy || pending || view.requiresRefresh || !slot || slot.authorId !== view.userId)
                    return;
                editRevision++;
                publish({ ...view, editor: { id, version: slot.version, value: slot.state === 'active' ? String(slot.value) : '', mode: slot.state === 'active' ? 'edit' : 'reshare' }, status: 'idle', error: false });
            },
            cancelCreate() { createRevision++; publish({ ...view, create: blankScale }); }, cancelEdit() { editRevision++; publish({ ...view, editor: null }); }
        } };
}
export type ScaleActions = ReturnType<typeof createScaleController>['actions'];

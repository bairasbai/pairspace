import { readBoundedJson } from '../chat/transport';
import { readSessionContext } from './context';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { emptyStems, parseStemText, validStem, followsStem, orderStems, exact, record, uuid, instant, sameDateContext, type StemView, type StemRound } from './stems-state';
type Kind = 'create' | 'complete' | 'skip' | 'removeAuthorBundle' | 'removeRecipientContinuation';
type Pending = Readonly<{
    id: string;
    kind: Kind;
    target: string | null;
    version: number;
    text: string | null;
    beginning: string | null;
    revision: number;
}>;
export function createStemsController(config: SyntheticConfig, host: InvitationHost, request: (input: Request) => Promise<Response>, commandId: () => string) {
    const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
    validateSyntheticConfig(settings);
    let view = emptyStems, bound: InvitationHostSnapshot | null = null, pending: Pending | null = null;
    let sequence = 0, createRevision = 0, completionRevision = 0;
    const listeners = new Set<() => void>();
    const publish = (next: StemView) => {
        view = Object.freeze(next);
        for (const listener of listeners)
            listener();
    };
    function reset() { sequence++; createRevision++; completionRevision++; bound = null; pending = null; publish(emptyStems); }
    function sync() {
        const current = host.capture();
        if (bound && current && current.generation === bound.generation && current.identity === bound.identity && sameDateContext(current.context, bound.context))
            return;
        reset();
        if (current?.context.state === 'ready') {
            bound = current;
            publish({ ...emptyStems, available: true, userId: current.context.userId });
        }
    }
    function reconcileDraft(rounds: readonly StemRound[]): StemView['completionDraft'] {
        const draft = view.completionDraft;
        if (!draft)
            return null;
        const next = rounds.find(q => q.id === draft.id);
        if (next?.authorTextState === 'active' && next.phase === 'waiting' && next.version === draft.version)
            return draft;
        return draft.text ? { ...draft, stale: next?.authorTextState === 'active' && next.phase === 'waiting' ? 'changed' : 'terminal' } : null;
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
            const cookieMatches = async () => {
                const matches = await host.getCookie() === cookie;
                if (current() && !matches) {
                    host.block('auth_required');
                    reset();
                }
                return matches && current();
            };
            if (!await cookieMatches())
                return;
            const context = binding.value;
            if (context.state !== 'ready')
                return;
            const mutate = action === 'mutate', kind = command?.kind;
            const path = kind === 'complete' ? '/complete' : kind === 'removeRecipientContinuation' ? '/recipient-continuation' : kind === 'skip' ? '/skip' : '/author-bundle';
            const payload = mutate ? { command_id: command!.id, membership_epoch: context.membershipEpoch, ...(kind !== 'create' ? { expected_version: command!.version } : {}), ...(kind === 'create' ? { beginning: command!.beginning, own_continuation: command!.text } : kind === 'complete' ? { continuation: command!.text } : {}) } : null;
            const response = await request(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/stems' + (mutate ? (command!.target ? '/' + command!.target + path : '') : '?membership_epoch=' + context.membershipEpoch), {
                method: mutate ? (kind === 'removeAuthorBundle' || kind === 'removeRecipientContinuation' ? 'DELETE' : 'POST') : 'GET', headers: { Cookie: cookie, Origin: settings.baseURL, ...(mutate ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
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
            const body = await readBoundedJson(response, 2097152);
            if (!current() || !await cookieMatches())
                return;
            if (record(body) && body.ok === false) {
                if (response.status === 409 && body.error === 'stale_membership') {
                    host.block('access_required');
                    reset();
                    return;
                }
                if (response.status === 409 && ['version_conflict', 'idempotency_conflict', 'capacity_reached'].includes(String(body.error))) {
                    if (body.error === 'version_conflict') {
                        const round = body.current;
                        if (!exact(body, 'ok,error,current') || !validStem(round, context) || !command || round.id !== command.target)
                            throw Error('retry');
                        const old = view.rounds.find(q => q.id === round.id);
                        if (!old || !followsStem(old, round))
                            throw Error('retry');
                        const rounds = view.rounds.map(q => q.id === round.id ? round : q).sort(orderStems);
                        publish({ ...view, rounds, completionDraft: reconcileDraft(rounds) });
                    }
                    pending = null;
                    publish({ ...view, pending: false, status: body.error === 'capacity_reached' ? 'limit' : 'conflict', requiresRefresh: true, checked: false, error: true });
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
                if (!exact(value, 'rounds,checkedAt,capacity,used') || !instant(value.checkedAt) || (view.checkedAt !== null && value.checkedAt < view.checkedAt) || value.capacity !== 100
                    || !Array.isArray(value.rounds) || value.rounds.length > 100 || value.used !== value.rounds.length || Number(value.used) < view.used)
                    throw Error('retry');
                const rounds: StemRound[] = [];
                for (const item of value.rounds) {
                    if (!validStem(item, context) || item.createdAt > value.checkedAt || (item.completedAt && item.completedAt > value.checkedAt) || rounds.some(q => q.id === item.id || q.sequence === item.sequence)
                        || rounds.some(q => [q.authorId, q.recipientId].sort().join() !== [item.authorId, item.recipientId].sort().join()) || item.sequence > Number(value.used) || (rounds.length > 0 && orderStems(rounds[rounds.length - 1], item) > 0))
                        throw Error('retry');
                    rounds.push(item);
                }
                if (view.rounds.some(old => { const next = rounds.find(q => q.id === old.id); return !next || !followsStem(old, next); }))
                    throw Error('retry');
                publish({ ...view, rounds, completionDraft: reconcileDraft(rounds), used: Number(value.used), checked: true, checkedAt: value.checkedAt, requiresRefresh: false, status: pending ? 'retry' : 'idle' });
            }
            else {
                const round = value.round;
                if (!exact(value, 'round,commandId,replay') || !validStem(round, context) || value.commandId !== command!.id || typeof value.replay !== 'boolean'
                    || (command!.target !== null && round.id !== command!.target) || round.version < Math.max(1, command!.version)
                    || (kind === 'create' || kind === 'removeAuthorBundle' ? round.authorId : round.recipientId) !== context.userId)
                    throw Error('retry');
                const old = view.rounds.find(q => q.id === round.id);
                if ((old && !followsStem(old, round)) || view.rounds.some(q => q.id !== round.id && q.sequence === round.sequence) || view.rounds.some(q => [q.authorId, q.recipientId].sort().join() !== [round.authorId, round.recipientId].sort().join()) || (!old && view.rounds.length >= 100))
                    throw Error('retry');
                if ((kind === 'removeAuthorBundle' && round.authorTextState !== 'removed') || (kind === 'removeRecipientContinuation' && round.recipientTextState !== 'removed')
                    || (kind === 'skip' && round.phase !== 'skipped') || (kind === 'complete' && round.phase !== 'completed'))
                    throw Error('retry');
                if (kind === 'create' && round.authorTextState === 'active' && (round.beginning !== command!.beginning || round.authorContinuation !== command!.text))
                    throw Error('retry');
                if (kind === 'complete' && round.recipientTextState === 'active' && round.recipientContinuation !== command!.text)
                    throw Error('retry');
                if (!value.replay) {
                    if (round.version !== (kind === 'create' ? 1 : command!.version + 1))
                        throw Error('retry');
                    if (kind === 'create' && (round.authorTextState !== 'active' || round.phase !== 'waiting' || round.beginning !== command!.beginning || round.authorContinuation !== command!.text))
                        throw Error('retry');
                    if (kind === 'complete' && (round.phase !== 'completed' || round.recipientContinuation !== command!.text))
                        throw Error('retry');
                }
                pending = null;
                const rounds = [...view.rounds.filter(q => q.id !== round.id), round].sort(orderStems);
                publish({ ...view, rounds, completionDraft: reconcileDraft(rounds), used: Math.max(view.used, round.sequence), checked: false, pending: false, status: 'saved',
                    ...(kind === 'create' && createRevision === command!.revision ? { create: { beginning: '', ownContinuation: '' } } : {}),
                    ...(kind !== 'create' && view.completionDraft?.id === command!.target && completionRevision === command!.revision ? { completionDraft: null } : {}) });
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
    function prepare(kind: Kind, target: string | null = null, confirm = false) {
        if (!view.available || view.busy || pending || view.requiresRefresh)
            return Promise.resolve();
        const round = view.rounds.find(q => q.id === target), actor = view.userId;
        if (!confirm)
            return Promise.resolve();
        if (kind === 'create' && !view.checked) {
            publish({ ...view, status: 'conflict', requiresRefresh: true, error: true });
            return Promise.resolve();
        }
        if (kind === 'create' && view.used >= 100) {
            publish({ ...view, status: 'limit' });
            return Promise.resolve();
        }
        if (kind === 'complete' && view.completionDraft?.stale) {
            publish({ ...view, status: 'conflict', error: true });
            return Promise.resolve();
        }
        if (kind !== 'create') {
            if (!round)
                return Promise.resolve();
            const authorized = kind === 'removeAuthorBundle' ? round.authorId === actor && round.authorTextState === 'active' : round.recipientId === actor
                && (kind === 'removeRecipientContinuation' ? round.recipientTextState === 'active' : round.authorTextState === 'active' && round.phase === 'waiting');
            if (!authorized || !confirm)
                return Promise.resolve();
            if (kind === 'complete' && (!view.completionDraft || view.completionDraft.id !== target || view.completionDraft.version !== round.version)) {
                publish({ ...view, status: 'conflict', requiresRefresh: true, error: true });
                return Promise.resolve();
            }
        }
        const text = kind === 'create' ? parseStemText(view.create.ownContinuation, 'continuation') : kind === 'complete' ? parseStemText(view.completionDraft!.text, 'continuation') : null, id = commandId();
        const beginning = kind === 'create' ? parseStemText(view.create.beginning, 'beginning') : null;
        if ((kind === 'create' && beginning === null) || !uuid(id) || ((kind === 'create' || kind === 'complete') && text === null)) {
            publish({ ...view, status: 'invalid' });
            return Promise.resolve();
        }
        pending = Object.freeze({ id, kind, target, version: round?.version ?? 0, text, beginning, revision: kind === 'create' ? createRevision : completionRevision });
        publish({ ...view, pending: true });
        return run('mutate');
    }
    return { reset, sync, actions: { getSnapshot: () => view, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, load: () => run('list'), retry: () => run('mutate'),
            create: (confirm: boolean) => prepare('create', null, confirm), complete: (confirm: boolean) => prepare('complete', view.completionDraft?.id ?? null, confirm), skip: (id: string, confirm: boolean) => prepare('skip', id, confirm),
            removeAuthorBundle: (id: string, confirm: boolean) => prepare('removeAuthorBundle', id, confirm), removeRecipientContinuation: (id: string, confirm: boolean) => prepare('removeRecipientContinuation', id, confirm),
            setCreate(field: 'beginning' | 'ownContinuation', text: string) {
                if (view.available) {
                    createRevision++;
                    publish({ ...view, create: { ...view.create, [field]: text.slice(0, 8000) } });
                }
            },
            setContinuation(text: string) {
                if (view.available && view.completionDraft) {
                    completionRevision++;
                    publish({ ...view, completionDraft: { ...view.completionDraft, text: text.slice(0, 8000) } });
                }
            },
            beginComplete(id: string) {
                const q = view.rounds.find(item => item.id === id);
                if (!view.available || view.busy || pending || view.requiresRefresh || q?.authorTextState !== 'active' || q.phase !== 'waiting' || q.recipientId !== view.userId)
                    return;
                completionRevision++;
                publish({ ...view, completionDraft: { id, version: q.version, text: '' }, status: 'idle', error: false });
            },
            cancelCreate() { createRevision++; publish({ ...view, create: { beginning: '', ownContinuation: '' } }); }, cancelComplete() { completionRevision++; publish({ ...view, completionDraft: null }); }
        } };
}
export type StemsActions = ReturnType<typeof createStemsController>['actions'];

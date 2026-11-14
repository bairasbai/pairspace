import { readBoundedJson } from '../chat/transport';
import { readSessionContext } from './context';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { emptyLoveWords, blankWords, parseWordFields, validWord, follows, exact, record, uuid, instant, sameDateContext, type LoveWordsView, type LoveWord, type WordFields } from './love-words-state';
type Pending = Readonly<{
    id: string;
    kind: 'create' | 'edit' | 'delete';
    target: string | null;
    version: number;
    fields: WordFields | null;
    revision: number;
}>;
export function createLoveWordsController(config: SyntheticConfig, host: InvitationHost, request: (input: Request) => Promise<Response>, commandId: () => string) {
    const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
    validateSyntheticConfig(settings);
    let view = emptyLoveWords, bound: InvitationHostSnapshot | null = null, pending: Pending | null = null;
    let sequence = 0, createRevision = 0, editRevision = 0;
    const listeners = new Set<() => void>();
    const publish = (next: LoveWordsView) => { view = Object.freeze(next); for (const listener of listeners)
        listener(); };
    function reset() { sequence++; createRevision++; editRevision++; bound = null; pending = null; publish(emptyLoveWords); }
    function sync() {
        const current = host.capture();
        if (bound && current && current.generation === bound.generation && current.identity === bound.identity && sameDateContext(current.context, bound.context))
            return;
        reset();
        if (current?.context.state === 'ready') {
            bound = current;
            publish({ ...emptyLoveWords, available: true, userId: current.context.userId });
        }
    }
    function reconcileEditor(words: readonly LoveWord[]): LoveWordsView['editor'] {
        const editor = view.editor;
        if (!editor)
            return null;
        const next = words.find(w => w.id === editor.id), old = view.words.find(w => w.id === editor.id);
        if (next?.state === 'active' && next.version === editor.version)
            return editor;
        if (old?.state === 'active' && Object.keys(editor.fields).every(k => editor.fields[k as keyof WordFields] === old[k as keyof WordFields]))
            return null;
        return { ...editor, stale: next?.state === 'deleted' ? 'deleted' : 'changed' };
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
            const payload = mutate ? { command_id: command!.id, membership_epoch: context.membershipEpoch,
                ...(kind !== 'create' ? { expected_version: command!.version } : {}),
                ...(command!.fields ? { word: command!.fields.word, meaning: command!.fields.meaning, said_when: command!.fields.saidWhen } : {}) } : null;
            const response = await request(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/love-words' + (mutate ? (command!.target ? '/' + command!.target : '') : '?membership_epoch=' + context.membershipEpoch), {
                method: mutate ? (kind === 'create' ? 'POST' : kind === 'edit' ? 'PUT' : 'DELETE') : 'GET',
                headers: { Cookie: cookie, Origin: settings.baseURL, ...(mutate ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
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
                if (!exact(value, 'words,checkedAt,capacity,used') || !instant(value.checkedAt) || (view.checkedAt !== null && value.checkedAt < view.checkedAt)
                    || value.capacity !== 100 || !Array.isArray(value.words) || value.words.length > 100 || value.used !== value.words.length || Number(value.used) < view.used)
                    throw Error('retry');
                const words: LoveWord[] = [];
                for (const item of value.words) {
                    if (!validWord(item, context) || item.createdAt > value.checkedAt || words.some(w => w.id === item.id || w.sequence === item.sequence)
                        || item.sequence > Number(value.used) || (words.length > 0 && words[words.length - 1].sequence <= item.sequence))
                        throw Error('retry');
                    words.push(item);
                }
                if (view.words.some(old => { const next = words.find(w => w.id === old.id); return !next || !follows(old, next); }))
                    throw Error('retry');
                publish({ ...view, words, editor: reconcileEditor(words), used: Number(value.used), checked: true, checkedAt: value.checkedAt, requiresRefresh: false, status: pending ? 'retry' : 'idle' });
            }
            else {
                const word = value.word;
                if (!exact(value, 'word,commandId,replay') || !validWord(word, context) || value.commandId !== command!.id || typeof value.replay !== 'boolean'
                    || word.authorId !== context.userId || (command!.target !== null && word.id !== command!.target) || word.version < Math.max(1, command!.version))
                    throw Error('retry');
                const old = view.words.find(w => w.id === word.id);
                if ((old && !follows(old, word)) || view.words.some(w => w.id !== word.id && w.sequence === word.sequence) || (!old && view.words.length >= 100))
                    throw Error('retry');
                if (kind === 'delete' && word.state !== 'deleted')
                    throw Error('retry');
                if (!value.replay) {
                    if (kind === 'delete') {
                        if (word.state !== 'deleted' || word.version !== command!.version + 1)
                            throw Error('retry');
                    }
                    else if (word.state !== 'active' || ![Math.max(1, command!.version), command!.version + 1].includes(word.version)
                        || Object.keys(command!.fields!).some(k => word[k as keyof WordFields] !== command!.fields![k as keyof WordFields]))
                        throw Error('retry');
                }
                pending = null;
                const words = [...view.words.filter(w => w.id !== word.id), word].sort((a, b) => b.sequence - a.sequence);
                publish({ ...view, words, editor: reconcileEditor(words), used: Math.max(view.used, word.sequence), checked: false, pending: false, status: 'saved',
                    ...(kind === 'create' && createRevision === command!.revision ? { create: blankWords } : {}),
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
        const word = view.words.find(w => w.id === target), context = bound?.context;
        if (kind === 'edit' && view.editor?.stale) {
            publish({ ...view, status: 'conflict', requiresRefresh: true, error: true });
            return Promise.resolve();
        }
        if (kind === 'create' && !view.checked) {
            publish({ ...view, status: 'conflict', requiresRefresh: true, error: true });
            return Promise.resolve();
        }
        if (kind === 'create' && view.used >= 100) {
            publish({ ...view, status: 'limit' });
            return Promise.resolve();
        }
        if (kind !== 'create' && (!word || word.state !== 'active' || context?.state !== 'ready' || word.authorId !== context.userId || (kind === 'delete' && !confirm)))
            return Promise.resolve();
        if (kind === 'edit' && (!view.editor || view.editor.id !== target || view.editor.version !== word!.version)) {
            publish({ ...view, status: 'conflict', requiresRefresh: true, error: true });
            return Promise.resolve();
        }
        const fields = kind === 'delete' ? null : parseWordFields(kind === 'create' ? view.create : view.editor!.fields), id = commandId();
        if (!uuid(id) || (kind !== 'delete' && !fields)) {
            publish({ ...view, status: 'invalid' });
            return Promise.resolve();
        }
        pending = Object.freeze({ id, kind, target, version: word?.version ?? 0, fields: fields ? Object.freeze(fields) : null, revision: kind === 'create' ? createRevision : editRevision });
        publish({ ...view, pending: true });
        return run('mutate');
    }
    return { reset, sync, actions: { getSnapshot: () => view, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
            load: () => run('list'), retry: () => run('mutate'), create: () => prepare('create'), saveEdit: () => prepare('edit', view.editor?.id ?? null), remove: (id: string, confirm: boolean) => prepare('delete', id, confirm),
            setCreateField(key: keyof WordFields, value: string) { if (view.available) {
                createRevision++;
                publish({ ...view, create: { ...view.create, [key]: value.slice(0, 4000) } });
            } },
            setEditField(key: keyof WordFields, value: string) { if (view.available && view.editor) {
                editRevision++;
                publish({ ...view, editor: { ...view.editor, fields: { ...view.editor.fields, [key]: value.slice(0, 4000) } } });
            } },
            beginEdit(id: string) {
                const word = view.words.find(w => w.id === id);
                if (!view.available || view.busy || pending || view.requiresRefresh || word?.state !== 'active' || bound?.context.state !== 'ready' || word.authorId !== bound.context.userId)
                    return;
                editRevision++;
                publish({ ...view, editor: { id, version: word.version, fields: { word: word.word, meaning: word.meaning, saidWhen: word.saidWhen } }, status: 'idle', error: false });
            },
            cancelCreate() { createRevision++; publish({ ...view, create: blankWords }); }, cancelEdit() { editRevision++; publish({ ...view, editor: null }); }
        } };
}
export type LoveWordsActions = ReturnType<typeof createLoveWordsController>['actions'];

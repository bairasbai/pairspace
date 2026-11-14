import { readBoundedJson } from '../chat/transport';
import { readSessionContext } from './context';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { emptyAsks, parseAskText, validAsk, followsAsk, orderAsks, exact, record, uuid, instant, sameDateContext, type AskView, type AskQuestion } from './asks-state';
type Kind = 'create' | 'answer' | 'skip' | 'removeQuestion' | 'removeAnswer';
type Pending = Readonly<{
    id: string;
    kind: Kind;
    target: string | null;
    version: number;
    text: string | null;
    revision: number;
}>;
export function createAsksController(config: SyntheticConfig, host: InvitationHost, request: (input: Request) => Promise<Response>, commandId: () => string) {
    const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
    validateSyntheticConfig(settings);
    let view = emptyAsks, bound: InvitationHostSnapshot | null = null, pending: Pending | null = null;
    let sequence = 0, createRevision = 0, answerRevision = 0;
    const listeners = new Set<() => void>();
    const publish = (next: AskView) => { view = Object.freeze(next); for (const listener of listeners)
        listener(); };
    function reset() { sequence++; createRevision++; answerRevision++; bound = null; pending = null; publish(emptyAsks); }
    function sync() {
        const current = host.capture();
        if (bound && current && current.generation === bound.generation && current.identity === bound.identity && sameDateContext(current.context, bound.context))
            return;
        reset();
        if (current?.context.state === 'ready') {
            bound = current;
            publish({ ...emptyAsks, available: true, userId: current.context.userId });
        }
    }
    function reconcileDraft(questions: readonly AskQuestion[]): AskView['answerDraft'] {
        const draft = view.answerDraft;
        if (!draft)
            return null;
        const next = questions.find(q => q.id === draft.id);
        if (next?.questionState === 'active' && next.responseState === 'waiting' && next.version === draft.version)
            return draft;
        return draft.text ? { ...draft, stale: next?.questionState === 'active' && next.responseState === 'waiting' ? 'changed' : 'terminal' } : null;
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
            const path = kind === 'answer' || kind === 'removeAnswer' ? '/answer' : kind === 'skip' ? '/skip' : '/question';
            const payload = mutate ? { command_id: command!.id, membership_epoch: context.membershipEpoch, ...(kind !== 'create' ? { expected_version: command!.version } : {}), ...(command!.text !== null ? { text: command!.text } : {}) } : null;
            const response = await request(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/asks' + (mutate ? (command!.target ? '/' + command!.target + path : '') : '?membership_epoch=' + context.membershipEpoch), {
                method: mutate ? (kind === 'removeQuestion' || kind === 'removeAnswer' ? 'DELETE' : 'POST') : 'GET', headers: { Cookie: cookie, Origin: settings.baseURL, ...(mutate ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
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
                if (!exact(value, 'questions,checkedAt,capacity,used') || !instant(value.checkedAt) || (view.checkedAt !== null && value.checkedAt < view.checkedAt) || value.capacity !== 100
                    || !Array.isArray(value.questions) || value.questions.length > 100 || value.used !== value.questions.length || Number(value.used) < view.used)
                    throw Error('retry');
                const questions: AskQuestion[] = [];
                for (const item of value.questions) {
                    if (!validAsk(item, context) || item.createdAt > value.checkedAt || (item.answeredAt && item.answeredAt > value.checkedAt) || questions.some(q => q.id === item.id || q.sequence === item.sequence)
                        || item.sequence > Number(value.used) || (questions.length > 0 && orderAsks(questions[questions.length - 1], item) > 0))
                        throw Error('retry');
                    questions.push(item);
                }
                if (view.questions.some(old => { const next = questions.find(q => q.id === old.id); return !next || !followsAsk(old, next); }))
                    throw Error('retry');
                publish({ ...view, questions, answerDraft: reconcileDraft(questions), used: Number(value.used), checked: true, checkedAt: value.checkedAt, requiresRefresh: false, status: pending ? 'retry' : 'idle' });
            }
            else {
                const question = value.question;
                if (!exact(value, 'question,commandId,replay') || !validAsk(question, context) || value.commandId !== command!.id || typeof value.replay !== 'boolean'
                    || (command!.target !== null && question.id !== command!.target) || question.version < Math.max(1, command!.version)
                    || (kind === 'create' || kind === 'removeQuestion' ? question.authorId : question.recipientId) !== context.userId)
                    throw Error('retry');
                const old = view.questions.find(q => q.id === question.id);
                if ((old && !followsAsk(old, question)) || view.questions.some(q => q.id !== question.id && q.sequence === question.sequence) || (!old && view.questions.length >= 100))
                    throw Error('retry');
                if ((kind === 'removeQuestion' && question.questionState !== 'removed') || (kind === 'removeAnswer' && question.responseState !== 'answer_removed')
                    || (kind === 'skip' && question.responseState !== 'skipped') || (kind === 'answer' && !['answered', 'answer_removed'].includes(question.responseState)))
                    throw Error('retry');
                if (!value.replay) {
                    if (question.version !== (kind === 'create' ? 1 : command!.version + 1))
                        throw Error('retry');
                    if (kind === 'create' && (question.questionState !== 'active' || question.responseState !== 'waiting' || question.question !== command!.text))
                        throw Error('retry');
                    if (kind === 'answer' && (question.responseState !== 'answered' || question.answer !== command!.text))
                        throw Error('retry');
                }
                pending = null;
                const questions = [...view.questions.filter(q => q.id !== question.id), question].sort(orderAsks);
                publish({ ...view, questions, answerDraft: reconcileDraft(questions), used: Math.max(view.used, question.sequence), checked: false, pending: false, status: 'saved',
                    ...(kind === 'create' && createRevision === command!.revision ? { create: '' } : {}),
                    ...(kind !== 'create' && view.answerDraft?.id === command!.target && answerRevision === command!.revision ? { answerDraft: null } : {}) });
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
        const question = view.questions.find(q => q.id === target), actor = view.userId;
        if (kind === 'create' && !view.checked) {
            publish({ ...view, status: 'conflict', requiresRefresh: true, error: true });
            return Promise.resolve();
        }
        if (kind === 'create' && view.used >= 100) {
            publish({ ...view, status: 'limit' });
            return Promise.resolve();
        }
        if (kind === 'answer' && view.answerDraft?.stale) {
            publish({ ...view, status: 'conflict', error: true });
            return Promise.resolve();
        }
        if (kind !== 'create') {
            if (!question)
                return Promise.resolve();
            const authorized = kind === 'removeQuestion' ? question.authorId === actor && question.questionState === 'active' : question.recipientId === actor
                && (kind === 'removeAnswer' ? question.responseState === 'answered' : question.questionState === 'active' && question.responseState === 'waiting');
            if (!authorized || (kind !== 'answer' && !confirm))
                return Promise.resolve();
            if (kind === 'answer' && (!view.answerDraft || view.answerDraft.id !== target || view.answerDraft.version !== question.version)) {
                publish({ ...view, status: 'conflict', requiresRefresh: true, error: true });
                return Promise.resolve();
            }
        }
        const text = kind === 'create' ? parseAskText(view.create) : kind === 'answer' ? parseAskText(view.answerDraft!.text) : null, id = commandId();
        if (!uuid(id) || ((kind === 'create' || kind === 'answer') && text === null)) {
            publish({ ...view, status: 'invalid' });
            return Promise.resolve();
        }
        pending = Object.freeze({ id, kind, target, version: question?.version ?? 0, text, revision: kind === 'create' ? createRevision : answerRevision });
        publish({ ...view, pending: true });
        return run('mutate');
    }
    return { reset, sync, actions: { getSnapshot: () => view, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, load: () => run('list'), retry: () => run('mutate'),
            create: () => prepare('create'), answer: () => prepare('answer', view.answerDraft?.id ?? null), skip: (id: string, confirm: boolean) => prepare('skip', id, confirm),
            removeQuestion: (id: string, confirm: boolean) => prepare('removeQuestion', id, confirm), removeAnswer: (id: string, confirm: boolean) => prepare('removeAnswer', id, confirm),
            setCreate(text: string) { if (view.available) {
                createRevision++;
                publish({ ...view, create: text.slice(0, 8000) });
            } },
            setAnswer(text: string) { if (view.available && view.answerDraft) {
                answerRevision++;
                publish({ ...view, answerDraft: { ...view.answerDraft, text: text.slice(0, 8000) } });
            } },
            beginAnswer(id: string) {
                const q = view.questions.find(item => item.id === id);
                if (!view.available || view.busy || pending || view.requiresRefresh || q?.questionState !== 'active' || q.responseState !== 'waiting' || q.recipientId !== view.userId)
                    return;
                answerRevision++;
                publish({ ...view, answerDraft: { id, version: q.version, text: '' }, status: 'idle', error: false });
            },
            cancelCreate() { createRevision++; publish({ ...view, create: '' }); }, cancelAnswer() { answerRevision++; publish({ ...view, answerDraft: null }); }
        } };
}
export type AsksActions = ReturnType<typeof createAsksController>['actions'];

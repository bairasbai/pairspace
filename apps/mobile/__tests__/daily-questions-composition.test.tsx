import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ConnectedTogether } from '../src/auth/ConnectedTogether';
import { DailyQuestionsPanel } from '../src/auth/DailyQuestionsPanel';
import { dailyQuestionsCopy } from '../src/auth/dailyQuestionsCopy';
import { createPairFeatures } from '../src/auth/pair-features';
import { createDailyQuestionsController } from '../src/auth/daily-questions';
import { fixture as hostFixture } from './predictions-fixtures';
import { createDailySlot } from '../../../packages/domain/daily-question/slot';
import { createDailyAnswerMetadata } from '../../../packages/domain/daily-question/metadata';

it.each(['ru', 'en'] as const)('composes optional daily question without background fetch and scrubs tab exit %s', locale => {
 const f = hostFixture(), request = jest.fn(async () => { throw Error('Navigation must not fetch'); });
 const features = createPairFeatures({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, { ...f.host, suspend: jest.fn(), finish: jest.fn(async () => {}) }, request, () => 'command');
 features.sync(); const controller = features.actions.dailyQuestions, title = dailyQuestionsCopy[locale].title;
 const mounted = render(<ConnectedTogether controller={features.actions} locale={locale}/>);
 fireEvent.press(screen.getByRole('tab', { name: title })); act(() => controller.setDraft('Synthetic private draft'));
 fireEvent.press(screen.getByRole('tab', { name: locale === 'ru' ? 'Словарь' : 'Dictionary' })); expect(controller.getSnapshot().draft).toBe('');
 fireEvent.press(screen.getByRole('tab', { name: title }));
 mounted.rerender(<ConnectedTogether controller={{ ...features.actions, dailyQuestions: undefined }} locale={locale}/>);
 expect(screen.queryByRole('tab', { name: title })).toBeNull(); expect(screen.getByRole('tab', { name: locale === 'ru' ? 'Словарь' : 'Dictionary' }).props.accessibilityState.selected).toBe(true);
 expect(request).not.toHaveBeenCalled();
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = { state: 'ready' as const, sessionId: 'synthetic-session', userId: id(2), coupleId: id(1), membershipEpoch: 1 };
const checkedAt = '2026-11-16T08:00:00.000Z';
const slot = createDailySlot({ id: id(4), participantIds: [id(2), id(3)], timezone: 'UTC' }, context, checkedAt)!;
const answer = createDailyAnswerMetadata({ id: id(5) }, slot, context, checkedAt, true)!;
const today = { day: slot.day, timezone: slot.timezone, catalogVersion: slot.catalogVersion, promptId: slot.promptId, promptRU: slot.promptRU, promptEN: slot.promptEN };
const envelope = (value: unknown, status = 200) => new Response(JSON.stringify({ ok: true, value }), { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
async function settle() { for (let n = 0; n < 120; n++) await Promise.resolve(); }
it.each(['create', 'rewrite'] as const)('real controller %s confirmation immediately hides new text and keeps retry canonical without refilling', async kind => {
 const capture = { generation: 1, identity: { sessionId: context.sessionId, userId: 'provider' }, context };
 const operation = jest.fn(async (_request: Request) => envelope(null));
 const controller = createDailyQuestionsController({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' },
  { capture: () => capture, getCookie: async () => 'synthetic=cookie', block: jest.fn(), refresh: jest.fn(async () => {}) },
  request => request.url.endsWith('/context') ? Promise.resolve(envelope(context)) : operation(request), () => id(7));
 controller.sync(); const api = controller.actions, t = dailyQuestionsCopy.en;
 operation.mockResolvedValueOnce(envelope({ slots: kind === 'create' ? [] : [{ slot, answers: [answer] }], today, checkedAt, hasMore: false, nextBeforeDay: null })); await api.refresh();
 if (kind === 'rewrite') { operation.mockResolvedValueOnce(envelope({ slot, answer, checkedAt, text: 'Synthetic previous answer' })); await api.read(answer.id); }
 api.setDraft('Synthetic new answer'); render(<DailyQuestionsPanel controller={api} locale="en"/>);
 let release!: (response: Response) => void; const held = new Promise<Response>(resolve => { release = resolve; }); operation.mockImplementationOnce(() => held);
 fireEvent.press(screen.getByRole('button', { name: kind === 'create' ? t.submit : t.edit }));
 fireEvent.press(screen.getByRole('button', { name: t.confirm })); expect(screen.getByLabelText(t.draftLabel).props.value).toBe('');
 expect(screen.queryByText('Synthetic previous answer')).toBeNull();
 await act(async () => { await settle(); release(envelope(null, 503)); await settle(); });
 expect(api.getSnapshot().status).toBe('retry'); expect(screen.getByLabelText(t.draftLabel).props.value).toBe('');
 fireEvent.changeText(screen.getByLabelText(t.draftLabel), 'An unrelated later draft');
 const returned = kind === 'create' ? answer : { ...answer, version: 2 };
 operation.mockResolvedValueOnce(envelope({ slot, answer: returned, commandId: id(7), replay: true, checkedAt }));
 await act(async () => { fireEvent.press(screen.getByRole('button', { name: t.retry })); await settle(); });
 const calls = operation.mock.calls.filter(([request]) => request.method === 'POST' || request.method === 'PUT');
 expect(calls).toHaveLength(2); expect(await calls[0][0].json()).toEqual(await calls[1][0].json());
 expect(api.getSnapshot().status).toBe('saved'); expect(screen.getByLabelText(t.draftLabel).props.value).toBe('An unrelated later draft');
 expect(screen.queryByText('Synthetic new answer')).toBeNull();
});

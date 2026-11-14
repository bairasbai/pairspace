import {emptyStems} from '../src/auth/stems-state';
import {emptyScale} from '../src/auth/scale-state';
import {emptyAsks} from '../src/auth/asks-state';
import {emptyLoveWords} from '../src/auth/love-words-state';
import { createNotificationPreferencesController } from '../src/auth/notification-preferences';
import { createArrivalController } from '../src/auth/arrival';
import { createPartingsController } from '../src/auth/partings';
import { createMorningDraftController } from '../src/auth/morning-draft';
import { createMorningPreparedController } from '../src/auth/morning-prepared';
import { createMorningDiscussionsController } from '../src/auth/morning-discussions';
import { createMorningsController } from '../src/auth/mornings';
import { emptyWishes } from '../src/auth/wishes-state';
import { emptySongs } from '../src/auth/songs-state';
import { emptyMemories } from '../src/auth/memories-state';
import { emptyDates } from '../src/auth/dates-state';
import { emptyBlind } from '../src/auth/blind-state';
import { emptyTasks } from '../src/auth/tasks-state';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, AppState } from 'react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';
import { PairspaceApp } from '../App';
import type { SessionController } from '../src/auth/SyntheticChatConnected';
import type { InviteView } from '../src/auth/invitations-controller';
import type { AuthView } from '../src/auth/controller';
jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);
it('connects opt-in synthetic chat without changing navigation or the heart', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  const appListeners = jest.spyOn(AppState, 'addEventListener');
  let view: AuthView = { phase: 'signed_out', error: null, draft: '', messages: [] };
  const listeners = new Set<() => void>();
  const inviteView: InviteView = { mode: 'unavailable', busy: null, error: null, invitation: null,
    issuedToken: null, tokenInput: '', preview: null, consent: false, recovery: 'none' };
  const careView = { available: false, busy: false, status: 'idle' as const, incoming: null, checked: false, error: false };
  const lettersView = { available: false, busy: false, status: 'idle' as const, draft: '', releaseAtInput: '', releaseTimezoneInput: '', letters: [], opened: null, checked: false, error: false };
  const leaveView = { available: false, status: 'idle' as const };
  const visibilityView = { status: 'idle' as const };
  const journalView = { enabled: false, status: 'disabled' as const };
  const reconciliationView = { status: 'idle' as const, hasNewMessages: false };
  const morningFeature = createMorningsController({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, { capture: () => null, getCookie: async () => '', block: jest.fn(), refresh: async () => {} }, async () => { throw Error('unexpected'); }, () => '00000000-0000-4000-8000-000000000001');
  const discussions = createMorningDiscussionsController({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, { capture: () => null, getCookie: async () => '', block: jest.fn(), refresh: async () => {} }, async () => { throw Error('unexpected'); }, () => '00000000-0000-4000-8000-000000000001');
  const prepared = createMorningPreparedController({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, { capture: () => null, getCookie: async () => '', block: jest.fn(), refresh: async () => {} }, async () => { throw Error('unexpected'); }, () => '00000000-0000-4000-8000-000000000001');
  const draft = createMorningDraftController({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, { capture: () => null, getCookie: async () => '', block: jest.fn(), refresh: async () => {} }, async () => { throw Error('unexpected'); }, () => '00000000-0000-4000-8000-000000000001');
  const stemsView={...emptyStems,available:true,userId:'00000000-0000-4000-8000-000000000001'};
  const scaleView={...emptyScale,available:true,userId:'00000000-0000-4000-8000-000000000001'};
  const asksView={...emptyAsks,available:true,userId:'00000000-0000-4000-8000-000000000001'};
  const wordsView={...emptyLoveWords,available:true,userId:'00000000-0000-4000-8000-000000000001'};
  const controller: SessionController = {
    stems:{getSnapshot:()=>stemsView,subscribe:()=>()=>{},load:jest.fn(async()=>{}),retry:jest.fn(async()=>{}),create:jest.fn(async()=>{}),complete:jest.fn(async()=>{}),skip:jest.fn(async()=>{}),removeAuthorBundle:jest.fn(async()=>{}),removeRecipientContinuation:jest.fn(async()=>{}),setCreate:jest.fn(),setContinuation:jest.fn(),beginComplete:jest.fn(),cancelCreate:jest.fn(),cancelComplete:jest.fn()},
    scale:{getSnapshot:()=>scaleView,subscribe:()=>()=>{},load:jest.fn(async()=>{}),setCreateField:jest.fn(),cancelCreate:jest.fn(),create:jest.fn(async()=>{}),beginEdit:jest.fn(),setValue:jest.fn(),cancelEdit:jest.fn(),save:jest.fn(async()=>{}),remove:jest.fn(async()=>{}),retry:jest.fn(async()=>{})},
    asks:{getSnapshot:()=>asksView,subscribe:()=>()=>{},load:jest.fn(async()=>{}),setCreate:jest.fn(),cancelCreate:jest.fn(),create:jest.fn(async()=>{}),beginAnswer:jest.fn(),setAnswer:jest.fn(),cancelAnswer:jest.fn(),answer:jest.fn(async()=>{}),skip:jest.fn(async()=>{}),removeQuestion:jest.fn(async()=>{}),removeAnswer:jest.fn(async()=>{}),retry:jest.fn(async()=>{})},
    loveWords:{getSnapshot:()=>wordsView,subscribe:()=>()=>{},load:jest.fn(async()=>{}),setCreateField:jest.fn(),setEditField:jest.fn(),beginEdit:jest.fn(),cancelCreate:jest.fn(),cancelEdit:jest.fn(),create:jest.fn(async()=>{}),saveEdit:jest.fn(async()=>{}),remove:jest.fn(async()=>{}),retry:jest.fn(async()=>{})},
    notificationPreferences: createNotificationPreferencesController({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, { capture: () => null, getCookie: async () => '', block: jest.fn(), refresh: async () => {} }, async () => { throw Error('unexpected'); }, () => '').actions,
    arrival: createArrivalController({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, { capture: () => null, getCookie: async () => '', block: jest.fn(), refresh: async () => {} }, async () => { throw Error('unexpected'); }, () => '').actions,
    partings: createPartingsController({ mode: 'synthetic-loopback', baseURL: 'http://localhost:8787' }, { capture: () => null, getCookie: async () => '', block: jest.fn(), refresh: async () => {} }, async () => { throw Error('unexpected'); }, () => '').actions,
    morningDraft: draft.actions,
    morningPrepared: prepared.actions,
    morningDiscussions: discussions.actions,
    mornings: morningFeature.actions,
    reconciliation: { getSnapshot: () => reconciliationView, subscribe: () => () => {}, check: jest.fn(), appStateChanged: jest.fn(), invalidate: jest.fn(), reset: jest.fn(), visibilityChanged: jest.fn() },
    resumeJournalSignIn: jest.fn(),
    journal: { getSnapshot: () => journalView, subscribe: () => () => {}, suspend: jest.fn(), retire: jest.fn(async () => true), flush: jest.fn(async () => true),
      changed: jest.fn(), canSend: () => true, beforeSend: jest.fn(async () => true), observeVerified: jest.fn(async () => true), check: jest.fn(async () => {}), restore: jest.fn(async () => {}),
      resolveConflict: jest.fn(async () => {}), verifyReply: jest.fn(async () => {}), removeReply: jest.fn(), prepare: jest.fn(async () => true), settle: jest.fn(async () => {}), discard: jest.fn(async () => true),
      beginReset: jest.fn(), cancelReset: jest.fn(), confirmReset: jest.fn(async () => {}) },
    beginDiscardOutgoing: jest.fn(), cancelDiscardOutgoing: jest.fn(), confirmDiscardOutgoing: jest.fn(),
    visibility: { getSnapshot:()=>visibilityView, subscribe:()=>()=>{}, reset:jest.fn(), invalidateHistory:jest.fn(),
      beginHide:jest.fn(async()=>{}), beginRestore:jest.fn(), cancel:jest.fn(), confirm:jest.fn(async()=>{}), retry:jest.fn(async()=>{}),
      loadLatest:jest.fn(async()=>{}), loadOldest:jest.fn(async()=>{}), loadOlder:jest.fn(async()=>{}), loadNewer:jest.fn(async()=>{}) },
    wishes: { getSnapshot: () => emptyWishes, subscribe: () => () => {}, setDraft: jest.fn(), setExplanation: jest.fn(), setConsent: jest.fn(), create: jest.fn(), fulfill: jest.fn(), reopen: jest.fn(), retry: jest.fn(), list: jest.fn(), cancel: jest.fn() },
    songs: { beginEdit: jest.fn(), getSnapshot: () => emptySongs, subscribe: () => () => {}, setDraft: jest.fn(), setExplanation: jest.fn(), setMusicUrl: jest.fn(), setConsent: jest.fn(), cancel: jest.fn(), create: jest.fn(async () => {}), retry: jest.fn(async () => {}), list: jest.fn(async () => {}) },
    blind: { listRounds: jest.fn(), selectRound: jest.fn(), next: jest.fn(), getSnapshot: () => emptyBlind, subscribe: () => () => {}, setDraft: jest.fn(), setConsent: jest.fn(), open: jest.fn(), read: jest.fn(), submit: jest.fn(), retry: jest.fn() },
    memories: { getSnapshot: () => emptyMemories, subscribe: () => () => {}, setDraft: jest.fn(), setBody: jest.fn(), setLocalDate: jest.fn(), setConsent: jest.fn(), cancel: jest.fn(), create: jest.fn(async () => {}), retry: jest.fn(async () => {}), list: jest.fn(async () => {}) },
    dates: { beginEdit: jest.fn(), setRecurrence: jest.fn(), setLeapDayPolicy: jest.fn(), getSnapshot: () => emptyDates, subscribe: () => () => {}, setDraft: jest.fn(), setLocalDate: jest.fn(), setTimezone: jest.fn(), cancel: jest.fn(), create: jest.fn(async () => {}), retry: jest.fn(async () => {}), list: jest.fn(async () => {}) },
    tasks: { getSnapshot: () => emptyTasks, subscribe: () => () => {}, setDraft: jest.fn(), cancel: jest.fn(),
      create: jest.fn(async () => {}), retry: jest.fn(async () => {}), list: jest.fn(async () => {}),
      complete: jest.fn(async () => {}), reopen: jest.fn(async () => {}) },
    leave: { getSnapshot: () => leaveView, subscribe: () => () => {}, begin: jest.fn(), cancel: jest.fn(), confirm: jest.fn(async () => {}) },
    letters: { getSnapshot: () => lettersView, subscribe: () => () => {}, setDraft: jest.fn(), setReleaseAt: jest.fn(), setReleaseTimezone: jest.fn(), sendLater: jest.fn(async () => {}), close: jest.fn(),
      send: jest.fn(async () => {}), list: jest.fn(async () => {}), open: jest.fn(async () => {}) },
    care: { getSnapshot: () => careView, subscribe: () => () => {}, send: jest.fn(async () => {}), read: jest.fn(async () => {}) },
    invitations: { getSnapshot: () => inviteView, subscribe: () => () => {},
      readMetadata: jest.fn(async () => {}), issue: jest.fn(async () => {}), revoke: jest.fn(async () => {}),
      setToken: jest.fn(), preview: jest.fn(async () => {}), setConsent: jest.fn(),
      accept: jest.fn(async () => {}), cancel: jest.fn(),
    },
    beginEdit: jest.fn(), setEditDraft: jest.fn(), cancelEdit: jest.fn(), saveEdit: jest.fn(async()=>{}), retryEdit: jest.fn(async()=>{}), reloadEdit: jest.fn(async()=>{}),
    beginDelete: jest.fn(), cancelDelete: jest.fn(), confirmDelete: jest.fn(async () => {}), retryDelete: jest.fn(async () => {}),
    dispose: jest.fn(), setReplyTarget: jest.fn(), cancelReply: jest.fn(), openReplyTarget: jest.fn(async () => {}), closeReplyDetail: jest.fn(),
    loadNewer: jest.fn(async () => {}), loadLatest: jest.fn(async () => {}), loadOldest: jest.fn(async () => {}),
    loadOlder: jest.fn(async () => {}),
    getSnapshot: () => view,
    subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    setDraft: jest.fn(), signIn: jest.fn(async () => {}), signOut: jest.fn(async () => {}),
    createWaitingSpace: jest.fn(async () => {}), createProfile: jest.fn(async () => {}), send: jest.fn(async () => {}), refresh: jest.fn(async () => {}),
  };
  const rendered = render(<PairspaceApp syntheticController={controller} />);
  await act(async () => {});
  fireEvent.press(screen.getByRole('tab', { name: 'Чат' }));
  const appListener = appListeners.mock.calls.find(call => call[0] === 'change')!;
  const subscription = appListeners.mock.results[appListeners.mock.calls.indexOf(appListener)].value;
  const removeListener = jest.spyOn(subscription, 'remove');
  act(() => { appListener[1]('background'); appListener[1]('active'); });
  expect(controller.reconciliation.appStateChanged).toHaveBeenCalledWith('active');
  expect(controller.send).not.toHaveBeenCalled();
  expect(controller.reconciliation.check).not.toHaveBeenCalled();
  // Labels intentionally taken from localized form to exercise actual user actions.
  fireEvent.changeText(screen.getByLabelText('Email тестового аккаунта'), 'synthetic@example.test');
  fireEvent.changeText(screen.getByLabelText('Пароль тестового аккаунта'), 'synthetic-password');
  fireEvent.press(screen.getByRole('button', { name: 'Войти в тестовый чат' }));
  expect(controller.signIn).toHaveBeenCalledWith('synthetic@example.test', 'synthetic-password');
  await act(async () => {
    view = { ...view, phase: 'signed_in' };
    listeners.forEach(callback => callback());
  });
  fireEvent.changeText(screen.getByLabelText('Тестовое сообщение'), 'synthetic body');
  expect(controller.setDraft).toHaveBeenCalledWith('synthetic body');
  await act(async () => { view = { ...view, draft: 'synthetic body' }; listeners.forEach(callback => callback()); });
  fireEvent.press(screen.getByRole('button', { name: 'Отправить тестовое сообщение' }));
  fireEvent.press(screen.getByRole('button', { name: 'Обновить историю' }));
  fireEvent.press(screen.getByRole('button', { name: 'Выйти' }));
  expect(controller.send).toHaveBeenCalled(); expect(controller.refresh).toHaveBeenCalled(); expect(controller.signOut).toHaveBeenCalled();
  await act(async () => { view = { ...view, phase: 'blocked', error: 'context_unmapped' }; listeners.forEach(callback => callback()); });
  fireEvent.press(screen.getByRole('button', { name: 'Создать тестовый профиль' }));
  expect(controller.createProfile).toHaveBeenCalledTimes(1);
  await act(async () => { view = { ...view, phase: 'blocked', error: 'context_no_active_pair' }; listeners.forEach(callback => callback()); });
  fireEvent.press(screen.getByRole('button', { name: 'Создать пространство ожидания' }));
  expect(controller.createWaitingSpace).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole('tab',{name:'Вместе'}));
  expect(screen.getByText('Наш словарь')).toBeTruthy();
  expect(controller.loveWords.load).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText('Новое слово: Слово (до 120 символов)'),'Synthetic shared word');
  expect(controller.loveWords.setCreateField).toHaveBeenCalledWith('word','Synthetic shared word');
  fireEvent.press(screen.getByText('Обновить весь словарь'));expect(controller.loveWords.load).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByText('Сохранить новое слово для обоих'));expect(controller.loveWords.create).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole('tab',{name:'Вопросы'}));expect(screen.queryByText('Наш словарь')).toBeNull();
  expect(screen.getByText('Вопросы друг другу')).toBeTruthy();expect(controller.asks.load).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText('Новый вопрос'),'Synthetic question');expect(controller.asks.setCreate).toHaveBeenCalledWith('Synthetic question');
  fireEvent.press(screen.getByText('Обновить все вопросы'));expect(controller.asks.load).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByText('Отправить вопрос партнёру'));expect(controller.asks.create).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole('tab',{name:'Шкала дня'}));expect(screen.getByText('Добровольная оценка своего дня от 0 до 100, не оценка партнёра и не диагноз. После публикации партнёр видит число, даже если ничего не публикует сам.')).toBeTruthy();
  expect(controller.scale.load).not.toHaveBeenCalled();fireEvent.changeText(screen.getByLabelText('Новое значение от 0 до 100'),'0');expect(controller.scale.setCreateField).toHaveBeenCalledWith('value','0');
  fireEvent.press(screen.getByText('Обновить всю историю'));expect(controller.scale.load).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByText('Поделиться оценкой за сегодня'));expect(controller.scale.create).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole('tab',{name:'Продолжи фразу'}));expect(screen.getByText('Автор делится началом фразы и сохраняет своё продолжение. Партнёр может добавить своё продолжение: тогда оба текста станут видны обоим. Участие добровольное, без срока и оценки совпадений.')).toBeTruthy();
  expect(controller.stems.load).not.toHaveBeenCalled();fireEvent.changeText(screen.getByLabelText('Начало фразы (1–500 символов)'),'Synthetic beginning');expect(controller.stems.setCreate).toHaveBeenCalledWith('beginning','Synthetic beginning');
  fireEvent.press(screen.getByText('Обновить все фразы'));expect(controller.stems.load).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByText('Предложить фразу'));expect(controller.stems.create).not.toHaveBeenCalled();fireEvent.press(screen.getByText('Подтвердить'));expect(controller.stems.create).toHaveBeenCalledWith(true);
  fireEvent.press(screen.getByRole('tab',{name:'Словарь'}));expect(screen.getByText('Наш словарь')).toBeTruthy();
  fireEvent.press(screen.getByRole('tab',{name:'Сегодня'}));expect(screen.queryByText('Наш словарь')).toBeNull();
  rendered.unmount();
  expect(removeListener).toHaveBeenCalledTimes(1);
  jest.restoreAllMocks();
});

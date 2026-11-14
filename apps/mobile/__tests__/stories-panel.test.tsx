import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { StoriesPanel } from '../src/auth/StoriesPanel';
import { ConnectedTogether } from '../src/auth/ConnectedTogether';
import { createPairFeatures } from '../src/auth/pair-features';
import { storiesCopy } from '../src/auth/storiesCopy';
import { ack, context, deferred, detail, envelope, fixture, incoming, list, own, prose, removed, settle, told, uuid } from './stories-fixtures';

for (const locale of ['ru', 'en'] as const) for (const platform of ['ios', 'android'] as const) {
  it(`offers distinct long-form composer and explicit reader in ${locale}/${platform}`, async () => {
    const replacement = jest.replaceProperty(Platform, 'OS', platform);
    try {
      const f = fixture(), t = storiesCopy[locale];
      await f.load([incoming]); render(<StoriesPanel controller={f.api} locale={locale}/>);
      expect(screen.getByText(t.title)).toBeTruthy(); expect(screen.queryByText(prose)).toBeNull();
      fireEvent.press(screen.getByRole('button', { name: `${t.begin} 1` }));
      fireEvent.changeText(screen.getByLabelText(t.storyLabel), '🦉🦉');
      expect(screen.getByText(`${t.characters} 2/8000`)).toBeTruthy();
      f.operation.mockResolvedValueOnce(ack(told));
      await act(async () => { fireEvent.press(screen.getByRole('button', { name: t.tell })); await settle(); });
      expect(screen.queryByLabelText(t.storyLabel)).toBeNull(); expect(screen.queryByText(prose)).toBeNull();
      f.operation.mockResolvedValueOnce(detail());
      await act(async () => { fireEvent.press(screen.getByRole('button', { name: `${t.open} 1` })); await settle(); });
      expect(screen.getByText(prose).props.children).toContain('\n\n');
      expect(screen.getByText(t.readerTitle)).toBeTruthy();
      fireEvent.press(screen.getByRole('button', { name: t.close })); expect(screen.queryByText(prose)).toBeNull();
      fireEvent.changeText(screen.getByLabelText(t.topicLabel), 'New unsaved topic');
      fireEvent.press(screen.getByRole('button', { name: t.cancelTopic })); expect(f.api.getSnapshot().topicDraft).toBe('');
    } finally { replacement.restore(); }
  });
}
it('has separate voluntary decline/topic/body confirmations and pending retry/stale RAM controls', async () => {
  const t = storiesCopy.ru, f = fixture(); await f.load([incoming]);
  const rendered = render(<StoriesPanel controller={f.api} locale="ru"/>);
  fireEvent.press(screen.getByRole('button', { name: `${t.decline} 1` })); expect(screen.getByText(t.confirmDecline)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: t.cancel }));
  fireEvent.press(screen.getByRole('button', { name: `${t.begin} 1` })); fireEvent.changeText(screen.getByLabelText(t.storyLabel), 'Original private draft');
  f.operation.mockRejectedValueOnce(Error('offline'));
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: t.tell })); await settle(); });
  expect(screen.getByText(t.pending)).toBeTruthy(); fireEvent.changeText(screen.getByLabelText(t.storyLabel), 'Newer unsaved text');
  f.operation.mockResolvedValueOnce(ack(told, true));
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: t.retry })); await settle(); });
  expect(screen.getByText(t.stale)).toBeTruthy(); expect(screen.getByLabelText(t.storyLabel).props.value).toBe('Newer unsaved text');
  fireEvent.press(screen.getByRole('button', { name: t.cancelStory }));
  fireEvent.press(screen.getByRole('button', { name: `${t.removeStory} 1` })); expect(screen.getByText(t.confirmStory)).toBeTruthy();
  f.operation.mockResolvedValueOnce(ack(removed));
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: t.confirm })); await settle(); });
  expect(screen.getByText(t.story_removed)).toBeTruthy(); rendered.unmount();
  const g = fixture(); await g.load([own]); render(<StoriesPanel controller={g.api} locale="ru"/>);
  fireEvent.press(screen.getByRole('button', { name: `${t.removeTopic} 1` })); expect(screen.getByText(t.confirmTopic)).toBeTruthy();
  const withdrawn = { ...own, topicState: 'removed', storyState: 'withdrawn', version: 2 }; delete withdrawn.topic;
  g.operation.mockResolvedValueOnce(ack(withdrawn));
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: t.confirm })); await settle(); });
  expect(screen.getByText(t.withdrawn)).toBeTruthy();
});
it('close during loading prevents late detail reopening; changed/error states require explicit action', async () => {
  const f = fixture(), t = storiesCopy.en; await f.load([told]); render(<StoriesPanel controller={f.api} locale="en"/>);
  const gate = deferred(); f.operation.mockReturnValueOnce(gate.promise);
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: `${t.open} 1` })); await settle(); });
  expect(screen.getByText(t.reading)).toBeTruthy(); fireEvent.press(screen.getByRole('button', { name: t.close }));
  await act(async () => { gate.resolve(detail()); await settle(); });
  expect(screen.queryByText(prose)).toBeNull();
  const newer = { ...told, topicState: 'removed' as const, version: 3 }; delete newer.topic;
  f.operation.mockResolvedValueOnce(detail(newer));
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: `${t.open} 1` })); await settle(); });
  expect(screen.getByText(t.readerChanged)).toBeTruthy();
  f.operation.mockRejectedValueOnce(Error('offline'));
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: `${t.open} 1` })); await settle(); });
  expect(screen.getByText(t.readerError)).toBeTruthy();
});
it('real feature composition exposes stories as a separate Together capability without automatic requests', async () => {
  const snapshot = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
  const host = { capture: () => snapshot,
    getCookie: async () => 'synthetic=cookie', block: jest.fn(), refresh: async () => {}, suspend: jest.fn(), finish: jest.fn() };
  const request = jest.fn(async (r: Request) => r.url.endsWith('/context') ? envelope(context) : list());
  const features = createPairFeatures({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host, request, () => uuid(3));
  features.sync(); const rendered = render(<ConnectedTogether controller={features.actions} locale="ru"/>);
  expect(features.actions.stories).toBeDefined(); expect(request).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('tab', { name: 'Рассказ по заказу' }));
  expect(screen.getByText(storiesCopy.ru.notice)).toBeTruthy(); expect(request).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: storiesCopy.ru.load })); await settle(); });
  expect(request).toHaveBeenCalledTimes(2);
  act(() => features.actions.stories.setTopic('Private unsaved'));
  act(() => features.resetOrdinary()); expect(features.actions.stories.getSnapshot().topicDraft).toBe('');
  rendered.rerender(<ConnectedTogether controller={{ loveWords: features.actions.loveWords, asks: features.actions.asks, scale: features.actions.scale, stems: features.actions.stems }} locale="ru"/>);
  expect(screen.queryByRole('tab', { name: 'Рассказ по заказу' })).toBeNull();
  expect(screen.getByRole('tab', { name: 'Словарь' }).props.accessibilityState.selected).toBe(true);
});
it('batched reset/rebind clears confirmation even for the same actor, story and version without unmounting the panel', async () => {
  const f = fixture(), t = storiesCopy.ru;
  await f.load([incoming]);
  render(<StoriesPanel controller={f.api} locale="ru"/>);
  fireEvent.press(screen.getByRole('button', { name: `${t.decline} 1` }));
  expect(screen.getByText(t.confirmDecline)).toBeTruthy();
  const generation = f.api.getSnapshot().generation;
  await act(async () => { f.controller.reset(); f.controller.sync(); await f.load([incoming]); });
  expect(f.api.getSnapshot().generation).toBeGreaterThan(generation);
  expect(screen.queryByText(t.confirmDecline)).toBeNull();
  expect(screen.queryByRole('button', { name: t.confirm })).toBeNull();
  expect(f.operation).toHaveBeenCalledTimes(2);
  fireEvent.press(screen.getByRole('button', { name: `${t.decline} 1` }));
  expect(screen.getByText(t.confirmDecline)).toBeTruthy();
});
it('replacing a ready controller clears confirmation even when its actor and story are identical', async () => {
  const a = fixture(), b = fixture(), t = storiesCopy.ru;
  await a.load([incoming]); await b.load([incoming]);
  const rendered = render(<StoriesPanel controller={a.api} locale="ru"/>);
  fireEvent.press(screen.getByRole('button', { name: `${t.decline} 1` }));
  expect(screen.getByText(t.confirmDecline)).toBeTruthy();
  expect(a.api.getSnapshot().generation).not.toBe(b.api.getSnapshot().generation);
  rendered.rerender(<StoriesPanel controller={b.api} locale="ru"/>);
  expect(screen.queryByText(t.confirmDecline)).toBeNull();
  expect(screen.queryByRole('button', { name: t.confirm })).toBeNull();
  expect(a.operation).toHaveBeenCalledTimes(1); expect(b.operation).toHaveBeenCalledTimes(1);
});

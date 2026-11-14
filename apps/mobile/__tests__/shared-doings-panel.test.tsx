import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { SharedDoingsPanel } from '../src/auth/SharedDoingsPanel';
import { ConnectedTogether } from '../src/auth/ConnectedTogether';
import { createPairFeatures } from '../src/auth/pair-features';
import { sharedDoingsCopy } from '../src/auth/sharedDoingsCopy';
import { ack, complete, context, deferred, envelope, fixture, incoming, joined, list, own, settle, uuid, withdrawn } from './shared-doings-fixtures';

for (const locale of ['ru', 'en'] as const) for (const platform of ['ios', 'android'] as const) {
  it(`shows invitation without fabricated zero, explicit sharing/removal consequences and own progress in ${locale}/${platform}`, async () => {
    const replacement = jest.replaceProperty(Platform, 'OS', platform);
    try {
      const f = fixture(), t = sharedDoingsCopy[locale]; await f.load([incoming]); render(<SharedDoingsPanel controller={f.api} locale={locale}/>);
      expect(screen.getByText(t.notice)).toBeTruthy(); expect(screen.getByText(t.visibility)).toBeTruthy(); expect(f.api.getSnapshot().doings[0]).not.toHaveProperty('recipientAt');
      expect(screen.queryByLabelText(`${t.progress} 1`)).toBeNull();
      fireEvent.press(screen.getByRole('button', { name: `${t.join} 1` })); expect(screen.getByText(t.confirmJoin)).toBeTruthy();
      fireEvent.press(screen.getByRole('button', { name: t.cancel })); expect(f.operation).toHaveBeenCalledTimes(1);
      fireEvent.press(screen.getByRole('button', { name: `${t.join} 1` })); f.operation.mockResolvedValueOnce(ack(joined));
      await act(async () => { fireEvent.press(screen.getByRole('button', { name: t.confirm })); await settle(); });
      expect(screen.getByText(t.joined)).toBeTruthy(); expect(screen.queryByRole('button', { name: `${t.remove} 1` })).toBeNull();
      fireEvent.changeText(screen.getByLabelText(`${t.progress} 1`), '1'); f.operation.mockResolvedValueOnce(ack({ ...joined, recipientAt: 1, version: 3 }));
      await act(async () => { fireEvent.press(screen.getByRole('button', { name: `${t.advance} 1` })); await settle(); });
      expect(f.api.getSnapshot().doings[0]).toMatchObject({ authorAt: 0, recipientAt: 1 });
    } finally { replacement.restore(); }
  });
}
it('withdrawal after both-complete clears own position/current completion and states that it stops both', async () => {
  const f = fixture(), t = sharedDoingsCopy.ru; await f.load([complete]); render(<SharedDoingsPanel controller={f.api} locale="ru"/>);
  expect(screen.getByText(t.complete)).toBeTruthy(); expect(screen.queryByLabelText(`${t.progress} 1`)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: `${t.withdraw} 1` })); expect(screen.getByText(t.confirmWithdraw)).toBeTruthy();
  f.operation.mockResolvedValueOnce(ack({ ...incoming, authorAt: 2, decisionState: 'declined', version: 5 }));
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: t.confirm })); await settle(); });
  expect(screen.queryByText(t.complete)).toBeNull(); expect(screen.getByText(t.declined)).toBeTruthy(); expect(f.api.getSnapshot().doings[0]).not.toHaveProperty('recipientAt');
});
it('author removal confirmation names BOTH positions and renders a body-free tombstone; invitation decline is distinct', async () => {
  const f = fixture(), t = sharedDoingsCopy.en; await f.load([{ ...own, decisionState: 'joined', recipientAt: 1, authorAt: 1, version: 4 }]);
  const mounted = render(<SharedDoingsPanel controller={f.api} locale="en"/>);
  fireEvent.press(screen.getByRole('button', { name: `${t.remove} 1` })); expect(screen.getByText(t.confirmRemove)).toBeTruthy();
  f.operation.mockResolvedValueOnce(ack({ ...withdrawn, decisionState: 'joined', version: 5 }));
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: t.confirm })); await settle(); });
  expect(screen.getByText(t.removed)).toBeTruthy(); expect(screen.queryByText('Synthetic course')).toBeNull();
  const g = fixture(); await g.load([incoming]); mounted.rerender(<SharedDoingsPanel controller={g.api} locale="en"/>);
  fireEvent.press(screen.getByRole('button', { name: `${t.decline} 1` })); expect(screen.getByText(t.confirmDecline)).toBeTruthy();
  g.operation.mockResolvedValueOnce(ack({ ...incoming, decisionState: 'declined', version: 2 }));
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: t.confirm })); await settle(); }); expect(screen.getByText(t.declined)).toBeTruthy();
});
it('creation confirmation binds the current draft object; edit invalidates it and radio/clear remain RAM-only', async () => {
  const f = fixture(), t = sharedDoingsCopy.ru; await f.load(); render(<SharedDoingsPanel controller={f.api} locale="ru"/>); expect(screen.getByText(t.empty)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: t.propose })); expect(screen.getByText(t.confirmPropose)).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText(t.titleInput), 'Synthetic revised'); expect(screen.queryByText(t.confirmPropose)).toBeNull();
  fireEvent.press(screen.getByRole('radio', { name: t.other })); fireEvent.changeText(screen.getByLabelText(t.partsInput), '3');
  fireEvent.press(screen.getByRole('button', { name: t.propose })); f.operation.mockResolvedValueOnce(ack({ ...own, title: 'Synthetic revised', kind: 'other', parts: 3 }));
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: t.confirm })); await settle(); }); expect(f.api.getSnapshot().status).toBe('saved');
  fireEvent.changeText(screen.getByLabelText(t.titleInput), 'Synthetic unsent'); fireEvent.press(screen.getByRole('button', { name: t.clear })); expect(f.api.getSnapshot().draft.title).toBe('');
});
it('reset/rebind and replacement under StrictMode clear confirmation and late old ACK cannot affect replacement state', async () => {
  const f = fixture(), g = fixture(), h = fixture(), t = sharedDoingsCopy.ru; await f.load([incoming]); await g.load([incoming]); await h.load([incoming]);
  const mounted = render(<StrictMode><SharedDoingsPanel controller={f.api} locale="ru"/></StrictMode>);
  fireEvent.press(screen.getByRole('button', { name: `${t.join} 1` }));
  await act(async () => { f.controller.reset(); f.controller.sync(); await f.load([incoming]); }); expect(screen.queryByText(t.confirmJoin)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: `${t.decline} 1` })); expect(screen.getByText(t.confirmDecline)).toBeTruthy();
  mounted.rerender(<StrictMode><SharedDoingsPanel controller={g.api} locale="ru"/></StrictMode>); expect(screen.queryByText(t.confirmDecline)).toBeNull();
  const late = deferred(); g.operation.mockImplementationOnce(() => late.promise); fireEvent.press(screen.getByRole('button', { name: `${t.join} 1` }));
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: t.confirm })); await settle(); }); expect(g.api.getSnapshot().pending).toBe(true);
  mounted.rerender(<StrictMode><SharedDoingsPanel controller={h.api} locale="ru"/></StrictMode>);
  await act(async () => { late.resolve(ack(joined)); await settle(); }); expect(g.api.getSnapshot().pending).toBe(false);
  expect(h.api.getSnapshot().doings[0]).toEqual(incoming); expect(screen.queryByText(t.joined)).toBeNull(); expect(screen.getByText(t.invited)).toBeTruthy();
});
it('record version change clears progress input and stale confirmation; unmount clears local choices', async () => {
  const f = fixture(), t = sharedDoingsCopy.en; await f.load([own]); const mounted = render(<SharedDoingsPanel controller={f.api} locale="en"/>);
  fireEvent.changeText(screen.getByLabelText(`${t.progress} 1`), '2'); fireEvent.press(screen.getByRole('button', { name: `${t.remove} 1` }));
  await act(async () => { await f.load([{ ...own, authorAt: 1, version: 2 }]); }); expect(screen.queryByText(t.confirmRemove)).toBeNull(); expect(screen.getByLabelText(`${t.progress} 1`).props.value).toBe('1');
  fireEvent.press(screen.getByRole('button', { name: `${t.remove} 1` })); mounted.unmount(); render(<SharedDoingsPanel controller={f.api} locale="en"/>); expect(screen.queryByText(t.confirmRemove)).toBeNull();
});
it('offline creation retains immutable command, honest retry and newer draft; unavailable scope renders no private content', async () => {
  const f = fixture(), t = sharedDoingsCopy.ru; await f.load(); render(<SharedDoingsPanel controller={f.api} locale="ru"/>);
  fireEvent.press(screen.getByRole('button', { name: t.propose })); f.operation.mockRejectedValueOnce(Error('offline'));
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: t.confirm })); await settle(); }); expect(screen.getByText(t.pending)).toBeTruthy(); expect(screen.getByText(t.error)).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText(t.titleInput), 'Synthetic newer RAM'); f.operation.mockResolvedValueOnce(ack(own, true));
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: t.retry })); await settle(); }); expect(screen.getByLabelText(t.titleInput).props.value).toBe('Synthetic newer RAM');
  await act(async () => { f.set(null); f.controller.sync(); }); expect(screen.queryByText('Synthetic course')).toBeNull(); expect(screen.queryByRole('button', { name: t.propose })).toBeNull();
});
it('real composition adds a distinct tab without auto fetch, mode navigation clears choices and legacy injected controllers remain supported', async () => {
  const snapshot = { generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context };
  const host = { capture: () => snapshot, getCookie: async () => 'synthetic=cookie', block: jest.fn(), refresh: async () => {}, suspend: jest.fn(), finish: jest.fn() };
  const request = jest.fn(async (r: Request) => r.url.endsWith('/context') ? envelope(context) : list([own]));
  const features = createPairFeatures({ mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:8787' }, host, request, () => uuid(3)); features.sync();
  const mounted = render(<ConnectedTogether controller={features.actions} locale="ru"/>); expect(request).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('tab', { name: 'Совместное дело' })); expect(request).not.toHaveBeenCalled();
  await act(async () => { fireEvent.press(screen.getByRole('button', { name: sharedDoingsCopy.ru.load })); await settle(); }); expect(request).toHaveBeenCalledTimes(2);
  fireEvent.press(screen.getByRole('button', { name: `${sharedDoingsCopy.ru.remove} 1` })); fireEvent.press(screen.getByRole('tab', { name: 'Словарь' }));
  fireEvent.press(screen.getByRole('tab', { name: 'Совместное дело' })); expect(screen.queryByText(sharedDoingsCopy.ru.confirmRemove)).toBeNull();
  mounted.rerender(<ConnectedTogether controller={{ loveWords: features.actions.loveWords, asks: features.actions.asks, scale: features.actions.scale, stems: features.actions.stems }} locale="en"/>);
  expect(screen.queryByRole('tab', { name: 'Shared doing' })).toBeNull(); expect(screen.getByRole('tab', { name: 'Dictionary' }).props.accessibilityState.selected).toBe(true);
});

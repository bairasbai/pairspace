import { fireEvent, render, screen } from '@testing-library/react-native';
import { SongsPanel } from '../src/auth/SongsPanel';
import { songsCopy } from '../src/auth/songsCopy';
import { emptySongs } from '../src/auth/songs-state';
import { song } from './songs-fixtures';
const initial = { ...emptySongs, available: true, consent: true };
function props(locale: 'ru' | 'en') {
  return { locale, view: initial, onEdit: jest.fn(), onConsent: jest.fn(), onDraft: jest.fn(), onExplanation: jest.fn(), onMusicUrl: jest.fn(), onCreate: jest.fn(), onRetry: jest.fn(), onList: jest.fn(), onCancel: jest.fn() };
}
it.each(['ru', 'en'] as const)('explicit share/list/retry and honest one-off cap UI %s', locale => {
  const p = props(locale), t = songsCopy[locale]; const ui = render(<SongsPanel {...p} />);
  fireEvent.changeText(screen.getByLabelText(t.draft), 'Private draft'); expect(p.onDraft).toHaveBeenCalledWith('Private draft');
  fireEvent.changeText(screen.getByLabelText(t.explanation), song.explanation); expect(p.onExplanation).toHaveBeenCalledWith(song.explanation);
  fireEvent.press(screen.getByText(t.create)); fireEvent.press(screen.getByText(t.list)); fireEvent.press(screen.getByText(t.cancel));
  expect(p.onCreate).toHaveBeenCalledTimes(1); expect(p.onList).toHaveBeenCalledTimes(1); expect(p.onCancel).toHaveBeenCalledTimes(1);
  expect(screen.getByText(t.bound)).toBeTruthy(); expect(screen.getByText(t.cancelHint)).toBeTruthy();
  ui.rerender(<SongsPanel {...p} view={{ ...initial, checked: true }} />); expect(screen.getByText(t.none)).toBeTruthy();
  ui.rerender(<SongsPanel {...p} view={{ ...initial, songs: [song], error: true }} />);
  expect(screen.getByText(song.explanation)).toBeTruthy(); expect(screen.getByText(t.error)).toBeTruthy();
  ui.rerender(<SongsPanel {...p} view={{ ...initial, status: 'retry', pending: { title: 'Original', explanation: song.explanation }, songs: [song] }} />);
  fireEvent.press(screen.getByText(t.again)); expect(p.onRetry).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByText(t.create)); expect(p.onCreate).toHaveBeenCalledTimes(1);
});
it('hides unavailable and blocks busy/conflict writes but leaves refresh and clear available after conflict', () => {
  const p = props('en'), t = songsCopy.en; const ui = render(<SongsPanel {...p} view={emptySongs} />);
  expect(screen.queryByText(t.title)).toBeNull();
  ui.rerender(<SongsPanel {...p} view={{ ...initial, busy: true, status: 'saving' }} />);
  fireEvent.press(screen.getByText(t.create)); fireEvent.press(screen.getByText(t.list)); expect(p.onCreate).not.toHaveBeenCalled(); expect(p.onList).not.toHaveBeenCalled();
  ui.rerender(<SongsPanel {...p} view={{ ...initial, requiresRefresh: true, status: 'conflict' }} />);
  fireEvent.press(screen.getByText(t.create)); fireEvent.press(screen.getByText(t.list)); expect(p.onCreate).not.toHaveBeenCalled(); expect(p.onList).toHaveBeenCalled();
});
it.each(['ru', 'en'] as const)('shows visible consent state and requests explicit toggle in %s', locale => {
  const p = props(locale), t = songsCopy[locale]; const ui = render(<SongsPanel {...p} view={{ ...initial, consent: false }} />);
  expect(screen.getByText('☐ ' + t.consent)).toBeTruthy(); expect(screen.getByText(t.limits)).toBeTruthy();
  fireEvent.press(screen.getByText(t.create)); expect(p.onCreate).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText(t.consent)); expect(p.onConsent).toHaveBeenCalledWith(true);
  ui.rerender(<SongsPanel {...p} />); expect(screen.getByText('☑ ' + t.consent)).toBeTruthy();
  fireEvent.press(screen.getByLabelText(t.consent)); expect(p.onConsent).toHaveBeenCalledWith(false);
});

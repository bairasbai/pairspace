import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Linking, Platform } from 'react-native';
import { normalizeSongLink } from '../../../packages/domain/songs/link';
import { SongLink } from '../src/auth/SongLink';
import { SongsPanel } from '../src/auth/SongsPanel';
import { songsCopy } from '../src/auth/songsCopy';
import { fixture, ack, song, settle, context, uuid, envelope } from './songs-fixtures';
const url = 'https://open.spotify.com/track/Synthetic_123-abc';
const other = 'https://youtu.be/Synthetic123';
beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());
it.each([url, other, 'https://music.apple.com/us/song/123', 'https://www.youtube.com/shorts/abc', 'https://music.yandex.ru/album/1/track/2'])('allows only exact narrow public URL %s', value => {
  expect(normalizeSongLink(value)).toEqual({ ok: true, url: value });
});
it.each([null, 1, {}, '', ' ', url + '\n', url + '\r', url + '\u0000', url + '?si=tracking', url + '#fragment',
  url + '/..', url + '%2f', url + '\\x', url + 'é', url + '\uD800', 'http://youtu.be/a', 'HTTPS://youtu.be/a',
  'https://youtu.be', 'https://youtu.be/', 'https://youtu.be:443/a', 'https://user@youtu.be/a',
  'https://youtu.be.evil.test/a', 'https://127.0.0.1/a', 'https://localhost/a', 'javascript:alert(1)',
  'https://youtu.be/' + 'a'.repeat(500)])('rejects unsupported ambiguous link %p', value => {
  expect(normalizeSongLink(value)).toEqual({ ok: false });
});
it('absence and exact length are stable', () => {
  expect(normalizeSongLink(undefined)).toEqual({ ok: true, url: undefined });
  expect(normalizeSongLink('https://youtu.be/' + 'a'.repeat(495)).ok).toBe(true);
});
it('link editing resets consent; retry preserves original canonical link and later draft', async () => {
  const f = fixture(); f.api.setMusicUrl(url); expect(f.api.getSnapshot().consent).toBe(false);
  f.api.setConsent(true); f.operation.mockRejectedValueOnce(new Error('lost ACK')); await f.api.create();
  f.api.setMusicUrl(other); f.operation.mockResolvedValueOnce(ack({ ...song, musicUrl: url }, true)); await f.api.retry();
  expect(await f.operation.mock.calls[0][0].json()).toEqual(await f.operation.mock.calls[1][0].clone().json());
  expect(await f.operation.mock.calls[1][0].json()).toMatchObject({ music_url: url });
  expect(f.api.getSnapshot()).toMatchObject({ musicUrl: other, status: 'saved', songs: [{ ...song, musicUrl: url }] });
});
it('rejects invalid link before sending and caps RAM without truncating to valid length', async () => {
  const f = fixture(); f.api.setMusicUrl('x'.repeat(1000)); expect(f.api.getSnapshot().musicUrl).toHaveLength(513);
  f.api.setConsent(true); await f.api.create(); expect(f.operation).not.toHaveBeenCalled();
  f.controller.reset(); f.api.setMusicUrl(url); expect(f.api.getSnapshot().musicUrl).toBe('');
});
it('clears unchanged linked draft but clear-and-retype survives older ACK', async () => {
  const f = fixture(); f.api.setMusicUrl(url); f.api.setConsent(true);
  f.operation.mockResolvedValueOnce(ack({ ...song, musicUrl: url })); await f.api.create(); expect(f.api.getSnapshot().musicUrl).toBe('');
  f.api.setDraft(song.title); f.api.setExplanation(song.explanation); f.api.setMusicUrl(url); f.api.setConsent(true);
  let release!: (r: Response) => void; f.operation.mockReturnValueOnce(new Promise(r => { release = r; }));
  const work = f.api.create(); await settle(); f.api.cancel(); f.api.setMusicUrl(url);
  release(ack({ ...song, musicUrl: url })); await work; expect(f.api.getSnapshot().musicUrl).toBe(url);
});
it.each(['userId', 'coupleId', 'membershipEpoch', 'sessionId'] as const)('scrubs linked state across %s', async field => {
  const f = fixture(); f.api.setMusicUrl(url); f.api.setConsent(true);
  let release!: (r: Response) => void; f.operation.mockReturnValueOnce(new Promise(r => { release = r; }));
  const work = f.api.create(); await settle();
  f.set({ generation: 1, identity: { sessionId: 'session', userId: 'provider' }, context: { ...context, [field]: field === 'membershipEpoch' ? 2 : uuid(99) } });
  f.controller.sync(); release(ack({ ...song, musicUrl: url })); await work;
  expect(f.api.getSnapshot()).toMatchObject({ musicUrl: '', pending: null, songs: [] });
});
it.each([null, '', 'http://youtu.be/a', other, undefined])('rejects mismatched or malformed linked ACK %p', async musicUrl => {
  const f = fixture(); f.api.setMusicUrl(url); f.api.setConsent(true); f.operation.mockResolvedValueOnce(ack({ ...song, musicUrl }));
  await f.api.create(); expect(f.api.getSnapshot().status).toBe('retry');
});
it('lists validated link without opening it', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(); const f = fixture();
  f.operation.mockResolvedValueOnce(envelope({ songs: [{ ...song, musicUrl: url }], limit: 50 })); await f.api.list();
  expect(f.api.getSnapshot().songs[0].musicUrl).toBe(url); expect(open).not.toHaveBeenCalled();
});
it.each(['ru', 'en'] as const)('form and pending summary expose link with explicit disclosure in %s', locale => {
  const f = fixture(), t = songsCopy[locale]; f.api.setMusicUrl(url);
  render(<SongsPanel locale={locale} view={{ ...f.api.getSnapshot(), pending: { title: song.title, explanation: song.explanation, musicUrl: url }, songs: [{ ...song, musicUrl: url }] }}
    onDraft={f.api.setDraft} onExplanation={f.api.setExplanation} onMusicUrl={f.api.setMusicUrl}
    onConsent={f.api.setConsent} onCreate={f.api.create} onCancel={f.api.cancel} onRetry={f.api.retry} onList={f.api.list} />);
  expect(screen.getByText(t.leaving)).toBeTruthy(); expect(screen.getByText(t.linkHelp)).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText(t.musicUrl), other); expect(f.api.getSnapshot().musicUrl).toBe(other);
});
it.each(['ios', 'android'] as const)('opens only explicit press via %s OS contract and handles rejection', async os => {
  jest.replaceProperty(Platform, 'OS', os); const open = jest.spyOn(Linking, 'openURL').mockRejectedValueOnce(new Error('denied')).mockResolvedValue();
  render(<SongLink url={url} locale="en" />); expect(open).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(screen.getByText(songsCopy.en.openLink)));
  expect(screen.getByText(songsCopy.en.openFailed)).toBeTruthy(); expect(open).toHaveBeenCalledWith(url);
  await act(async () => fireEvent.press(screen.getByText(songsCopy.en.openLink)));
  expect(screen.queryByText(songsCopy.en.openFailed)).toBeNull(); expect(open).toHaveBeenCalledTimes(2);
});
it('blocks rapid repeats and drops completion after removal', async () => {
  let release!: () => void; const open = jest.spyOn(Linking, 'openURL').mockReturnValue(new Promise(r => { release = r; }));
  const ui = render(<SongLink url={url} locale="ru" />);
  fireEvent.press(screen.getByText(songsCopy.ru.openLink)); fireEvent.press(screen.getByText(songsCopy.ru.openLink));
  expect(open).toHaveBeenCalledTimes(1); ui.unmount(); await act(async () => release());
});
it('does not offer unsupported platform or invalid URL navigation', () => {
  jest.replaceProperty(Platform, 'OS', 'web'); const open = jest.spyOn(Linking, 'openURL').mockResolvedValue();
  const ui = render(<SongLink url={url} locale="en" />); expect(screen.getByText(songsCopy.en.openUnsupported)).toBeTruthy();
  expect(screen.queryByText(songsCopy.en.openLink)).toBeNull(); ui.rerender(<SongLink url="javascript:x" locale="en" />);
  expect(screen.queryByText(songsCopy.en.leaving)).toBeNull(); expect(open).not.toHaveBeenCalled();
});

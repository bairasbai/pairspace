import { normalizeSongLink } from '../../../../packages/domain/songs/link';
import { normalizeSongExplanation } from '../../../../packages/domain/songs/text';
import { normalizeTaskTitle } from '../../../../packages/domain/tasks/title';
import { readBoundedJson } from '../chat/transport';
import { readSessionContext } from './context';
import { validateSyntheticConfig, type SyntheticConfig } from './config';
import type { InvitationHost, InvitationHostSnapshot } from './invitations-controller';
import { emptySongs, record, sameSongContext, songOrder, uuid, validSong, type SongsView } from './songs-state';
export type { SharedSong, SongsView } from './songs-state';
type Pending = Readonly<{ editing: SongsView['editing']; id: string; title: string; explanation: string; musicUrl?: string; revision: number }>;
/** Drafts and unresolved immutable commands exist only in RAM, scoped to the verified session/pair. */
export function createSongsController(config: SyntheticConfig, host: InvitationHost,
  request: (input: Request) => Promise<Response>, commandId: () => string) {
  const settings = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(settings);
  let view = emptySongs;
  let bound: InvitationHostSnapshot | null = null;
  let pending: Pending | null = null;
  let revision = 0, sequence = 0;
  let activeAction: 'save' | 'list' | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: SongsView) => { view = Object.freeze(next); for (const notify of listeners) notify(); };
  function reset() { sequence++; revision++; activeAction = null; bound = null; pending = null; publish(emptySongs); }
  function sync() {
    const current = host.capture();
    if (bound && current && current.generation === bound.generation && current.identity === bound.identity
      && sameSongContext(bound.context, current.context)) return;
    reset();
    if (current?.context.state === 'ready') { bound = current; publish({ ...emptySongs, available: true, userId: current.context.userId }); }
  }
  async function run(action: 'save' | 'list') {
    if (view.busy || !view.available || !bound || (action === 'save' && (!pending || view.requiresRefresh))) return;
    const command = pending, expected = bound, id = ++sequence;
    const current = () => {
      const next = host.capture();
      return sequence === id && next !== null && next.generation === expected.generation
        && next.identity === expected.identity && sameSongContext(next.context, expected.context);
    };
    activeAction = action;
    publish({ ...view, busy: true, error: false, ...(action === 'save' ? { status: 'saving' as const } : {}) });
    try {
      const cookie = await host.getCookie();
      if (!current()) return;
      const binding = await readSessionContext(settings, expected.identity.sessionId, cookie, request);
      if (!current()) return;
      if (!binding.ok) {
        if (binding.error !== 'transport_error') { host.block('auth_required'); reset(); return; }
        throw new Error('retry');
      }
      if (!sameSongContext(expected.context, binding.value)) { reset(); await host.refresh(); return; }
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      const context = binding.value;
      if (context.state !== 'ready') return;
      const save = action === 'save';
      const response = await request(new Request(settings.baseURL + '/v1/couples/' + context.coupleId + '/songs'
        + (save ? (command!.editing ? '/' + command!.editing.id : '') : '?membership_epoch=' + context.membershipEpoch), {
        method: save ? (command!.editing ? 'PATCH' : 'POST') : 'GET', headers: { Cookie: cookie, Origin: settings.baseURL,
          ...(save ? { 'Content-Type': 'application/json', 'Idempotency-Key': command!.id } : {}) },
        ...(save ? { body: JSON.stringify({ command_id: command!.id, membership_epoch: context.membershipEpoch,
          ...(command!.editing ? { expected_version: command!.editing.version } : {}),
          title: command!.title, explanation: command!.explanation, ...(command!.musicUrl ? { music_url: command!.musicUrl } : {}) }) } : {}),
        credentials: 'omit', redirect: 'error', cache: 'no-store',
      }));
      if (!current()) return;
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      if ([401, 403].includes(response.status)) { host.block('access_required'); reset(); return; }
      if (response.status === 404) { publish({ ...view, status: pending ? 'retry' : 'unavailable', error: true }); return; }
      const body = await readBoundedJson(response, 1048576);
      if (!current()) return;
      if (await host.getCookie() !== cookie) { if (current()) { host.block('auth_required'); reset(); } return; }
      if (!current()) return;
      if (response.status === 409 && record(body) && body.ok === false) {
        if (body.error === 'stale_membership') { host.block('access_required'); reset(); return; }
        if (body.error === 'version_conflict' || body.error === 'idempotency_conflict') {
          pending = null;
          publish({ ...view, pending: null, status: 'conflict', requiresRefresh: true, consent: false, error: true }); return;
        }
      }
      if (save && response.status === 400 && record(body) && body.ok === false && body.error === 'invalid_request') {
        pending = null; publish({ ...view, pending: null, status: 'invalid', error: true }); return;
      }
      if (![200, 201].includes(response.status) || !record(body) || body.ok !== true || !record(body.value) || Object.keys(body).sort().join(',') !== 'ok,value') throw new Error('retry');
      const value = body.value;
      if (Object.keys(value).sort().join(',') !== (save ? 'commandId,replay,song' : 'limit,songs')) throw new Error('retry');
      if (save) {
        const song = value.song;
        if (!validSong(song, context) || typeof value.replay !== 'boolean' || value.commandId !== command!.id
          || song.creatorId !== context.userId
          || (command!.editing && (song.id !== command!.editing.id || song.version <= command!.editing.version))
          || ((!value.replay || song.version === (command!.editing ? command!.editing.version + 1 : 1))
            && (song.title !== command!.title || song.explanation !== command!.explanation
              || song.musicUrl !== command!.musicUrl || song.version !== (command!.editing ? command!.editing.version + 1 : 1)))) throw new Error('retry');
        const known = view.songs.find(item => item.id === song.id);
        const canonical = known && known.version > song.version ? known : song;
        pending = null;
        publish({ ...view, pending: null, status: 'saved',
          ...(revision === command!.revision ? { editing: null, draft: '', explanation: '', musicUrl: '', consent: false } : {}),
          songs: [canonical, ...view.songs.filter(item => item.id !== song.id)].sort(songOrder).slice(0, 50) });
      } else {
        const songs = value.songs;
        if (value.limit !== 50 || !Array.isArray(songs) || songs.length > 50
          || songs.some(item => !validSong(item, context)) || new Set(songs.map(item => item.id)).size !== songs.length
          || songs.some((item, index) => index > 0 && songOrder(songs[index - 1], item) >= 0)) throw new Error('retry');
        publish({ ...view, songs, checked: true, requiresRefresh: false, status: pending ? 'retry' : 'idle' });
      }
    } catch { if (current()) publish({ ...view, error: true, ...(action === 'save' ? { status: 'retry' as const } : {}) }); }
    finally { if (current()) { activeAction = null; publish({ ...view, busy: false }); } }
  }
  function prepare() {
    if (!view.available || view.busy || pending || view.requiresRefresh) return Promise.resolve();
    if (view.editing && !view.songs.some(item => item.id === view.editing!.id && item.version === view.editing!.version)) {
      publish({ ...view, status: 'conflict', requiresRefresh: true, consent: false, error: true }); return Promise.resolve();
    }
    if (!view.consent) { publish({ ...view, status: 'invalid' }); return Promise.resolve(); }
    const title = normalizeTaskTitle(view.draft), body = normalizeSongExplanation(view.explanation), id = commandId().toLowerCase();
    const link = normalizeSongLink(view.musicUrl === '' ? undefined : view.musicUrl);
    if (!title.ok || !body.ok || !link.ok || !uuid(id)) {
      publish({ ...view, status: 'invalid' }); return Promise.resolve();
    }
    pending = Object.freeze({ editing: view.editing, id, title: title.text, explanation: body.text, ...(link.url ? { musicUrl: link.url } : {}), revision });
    publish({ ...view, pending: { editing: view.editing, title: title.text, explanation: body.text, ...(link.url ? { musicUrl: link.url } : {}) }, consent: false });
    return run('save');
  }
  return { reset, sync, actions: {
    getSnapshot: () => view,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    setDraft(draft: string) { if (view.available) { revision++; publish({ ...view, draft: draft.slice(0, 800), consent: false }); } },
    setExplanation(explanation: string) { if (view.available) { revision++; publish({ ...view, explanation: explanation.slice(0, 8000), consent: false }); } },
    setMusicUrl(musicUrl: string) { if (view.available) { revision++; publish({ ...view, musicUrl: musicUrl.slice(0, 513), consent: false }); } },
    setConsent(consent: boolean) { if (view.available) publish({ ...view, consent }); },
    beginEdit(id: string) {
      // Selection never discards an unsent draft or changes an in-flight command. Clear explicitly first.
      if (!view.available || view.busy || pending || view.requiresRefresh || view.editing
        || view.draft || view.explanation || view.musicUrl) return;
      const song = view.songs.find(item => item.id === id && item.creatorId === view.userId);
      if (!song || song.version >= 2147483647) return;
      revision++;
      publish({ ...view, editing: Object.freeze({ id: song.id, version: song.version }), draft: song.title,
        explanation: song.explanation, musicUrl: song.musicUrl ?? '', consent: false, status: 'idle', error: false });
    },
    create: prepare,
    retry: () => run('save'), list: () => run('list'),
    cancel() {
      revision++;
      // Cancel only the unsent draft/read. An already submitted command may have committed.
      if (activeAction === 'list') { sequence++; activeAction = null; publish({ ...view, busy: false }); }
      publish({ ...view, editing: null, draft: '', explanation: '', musicUrl: '', consent: false });
    },
  } };
}

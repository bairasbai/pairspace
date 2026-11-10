import { afterEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ values: new Map<string, string>(), accesses: [] as string[] }));
vi.mock('../../../apps/mobile/node_modules/expo-secure-store/build/SecureStore.js', () => ({
  getItemAsync: async (key: string) => { native.accesses.push(key); return native.values.get(key) ?? null; },
  setItemAsync: async (key: string, value: string) => { native.accesses.push(key); native.values.set(key, value); },
}));
vi.mock('../../../apps/mobile/node_modules/expo-constants/build/Constants.js', () => ({ default: { expoConfig: { scheme: 'pairspace-synthetic' } } }));
vi.mock('../../../apps/mobile/node_modules/expo-linking/build/Linking.js', () => ({ createURL: (path: string) => 'pairspace-synthetic://' + path }));
vi.mock('../../../apps/mobile/node_modules/react-native/index.js', () => ({
  Platform: { OS: 'ios' }, AppState: { addEventListener: () => ({ remove() {} }) },
}));
vi.mock('../../../apps/mobile/node_modules/expo-network/build/Network.js', () => ({
  getNetworkStateAsync: async () => ({ isConnected: true }),
  addNetworkStateListener: () => ({ remove() {} }),
}));
import { createOfficialSessionClient } from '../../../apps/mobile/src/auth/official-client';
import { syntheticStoragePrefix } from '../../../apps/mobile/src/auth/config';
afterEach(() => { vi.unstubAllGlobals(); native.values.clear(); native.accesses.length = 0; });

it('REAL official Expo plugin isolates cookie read/send/clear across host and port namespaces', async () => {
  native.values.set('pairspace-synthetic_cookie', 'legacy-unscoped-synthetic-marker');
  const origins = ['http://127.0.0.1:1234', 'http://127.0.0.1:1235', 'http://localhost:1234'];
  const requests: { origin: string; path: string; cookie: string }[] = [];
  vi.stubGlobal('fetch', async (input: string | Request | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(origins).toContain(url.origin);
    expect(request.redirect).toBe('error');
    requests.push({ origin: url.origin, path: url.pathname, cookie: request.headers.get('cookie') ?? '' });
    const index = origins.indexOf(url.origin);
    const data = url.pathname.endsWith('/get-session')
      ? { user: { id: 'synthetic-user-' + index }, session: { id: 'synthetic-session-' + index } }
      : { success: true };
    return Response.json(data, { headers: url.pathname.endsWith('/sign-in/email')
      ? { 'set-cookie': `better-auth.session_token=synthetic-cookie-${index}; Path=/; HttpOnly; Max-Age=3600` }
      : {} });
  });
  const configs = origins.map(baseURL => ({ mode: 'synthetic-loopback' as const, baseURL, identities: {} }));
  const clients = configs.map(createOfficialSessionClient);
  expect(await clients[0].signIn('a@example.test', 'synthetic-only')).toEqual({
    userId: 'synthetic-user-0', sessionId: 'synthetic-session-0',
  });
  expect(await clients[0].getCookie()).toContain('synthetic-cookie-0');
  for (const [index, other] of clients.entries()) {
    if (index === 0) continue;
    native.accesses.length = 0;
    expect(await other.getCookie()).toBe('');
    await other.signOut(); // Initial cleanup at another origin must not send or clear A's cookie.
    expect(native.accesses.length).toBeGreaterThan(0);
    expect(native.accesses.every(key => key.startsWith(syntheticStoragePrefix(configs[index])))).toBe(true);
    expect(await clients[0].getCookie()).toContain('synthetic-cookie-0');
  }
  expect(requests.filter(r => r.origin !== origins[0]).every(r => r.cookie === '')).toBe(true);
  await clients[1].signIn('b@example.test', 'synthetic-only');
  await clients[2].signIn('c@example.test', 'synthetic-only');
  expect(await clients[1].getCookie()).toContain('synthetic-cookie-1');
  expect(await clients[2].getCookie()).toContain('synthetic-cookie-2');
  const sameA = createOfficialSessionClient(configs[0]);
  expect(await sameA.getCookie()).toContain('synthetic-cookie-0');
  await sameA.signOut();
  expect(await clients[0].getCookie()).toBe('');
  expect(await clients[1].getCookie()).toContain('synthetic-cookie-1');
  expect(await clients[2].getCookie()).toContain('synthetic-cookie-2');
  expect(native.values.get('pairspace-synthetic_cookie')).toBe('legacy-unscoped-synthetic-marker');
  for (const [key, value] of native.values) {
    if (key === 'pairspace-synthetic_cookie') continue;
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
    const owners = configs.filter(config => key.startsWith(syntheticStoragePrefix(config)));
    expect(owners).toHaveLength(1);
    if (key.includes('session_data')) expect(value).not.toContain('synthetic-user-');
  }
  for (const request of requests) {
    const otherTokens = origins.map((_, index) => `synthetic-cookie-${index}`)
      .filter((_, index) => origins[index] !== request.origin);
    expect(otherTokens.every(token => !request.cookie.includes(token))).toBe(true);
  }
});

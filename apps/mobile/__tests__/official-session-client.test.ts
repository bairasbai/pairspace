import { Platform } from 'react-native';
import { createNativeJournal } from '../src/chat/journal/native';
import { createOfficialSessionClient } from '../src/auth/official-client';
import { createSyntheticRuntime } from '../src/auth/runtime';
import { defaultAuthConfig, syntheticStoragePrefix } from '../src/auth/config';
import { createAuthClient } from 'better-auth/react';
import { expoClient } from '@better-auth/expo/client';
import * as SecureStore from 'expo-secure-store';
import { fetch as expoFetch } from 'expo/fetch';
import { randomUUID } from 'expo-crypto';
import { createSessionController } from '../src/auth/controller';

jest.mock('../src/chat/journal/native', () => ({ createNativeJournal: jest.fn() }));
jest.mock('better-auth/react', () => ({ createAuthClient: jest.fn() }));
jest.mock('@better-auth/expo/client', () => ({ expoClient: jest.fn(() => ({ id: 'expo' })) }));
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('../src/auth/controller', () => ({ createSessionController: jest.fn() }));
const config = { mode: 'synthetic-loopback' as const, baseURL: 'http://127.0.0.1:1234' };
const email = jest.fn(); const getSession = jest.fn(); const signOut = jest.fn(); const getCookie = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(createAuthClient).mockReturnValue({ signIn: { email }, getSession, signOut, getCookie } as unknown as ReturnType<typeof createAuthClient>);
});
it('has no default enabled networking and uses official Expo SecureStore plugin with exact origin', () => {
  expect(defaultAuthConfig).toBeNull();
  createOfficialSessionClient(config);
  expect(expoClient).toHaveBeenCalledWith({ scheme: 'pairspace-synthetic', storagePrefix: syntheticStoragePrefix(config), storage: SecureStore, disableCache: true });
  expect(createAuthClient).toHaveBeenCalledWith(expect.objectContaining({
    baseURL: config.baseURL, basePath: '/api/auth',
    fetchOptions: { headers: { Origin: config.baseURL }, timeout: 10000, retry: 0, redirect: 'error' },
  }));
});
it('verifies sign-in server session without cookie cache and exposes only identity', async () => {
  email.mockResolvedValue({ error: null }); getSession.mockResolvedValue({ data: { user: { id: 'provider' }, session: { id: 'session' } } });
  const client = createOfficialSessionClient(config);
  expect(await client.signIn('synthetic@example.test', 'synthetic-password')).toEqual({ userId: 'provider', sessionId: 'session' });
  expect(getSession).toHaveBeenCalledWith({ query: { disableCookieCache: true } });
  email.mockResolvedValue({ error: { code: 'denied' } });
  expect(await client.signIn('synthetic@example.test', 'bad')).toBeNull();
  email.mockResolvedValue({}); getSession.mockResolvedValue({ data: null });
  expect(await client.signIn('synthetic@example.test', 'bad')).toBeNull();
});
it('delegates cookie handling and logout to official client, propagating failures', async () => {
  const client = createOfficialSessionClient(config);
  getCookie.mockResolvedValue('official-cookie'); expect(await client.getCookie()).toBe('official-cookie');
  signOut.mockResolvedValue({ error: null }); expect(await client.signOut()).toBe(true);
  signOut.mockResolvedValue({ error: {} }); expect(await client.signOut()).toBe(false);
  signOut.mockRejectedValue(new Error('offline')); await expect(client.signOut()).rejects.toThrow('offline');
});
it('rejects remote configuration before constructing the official client', () => {
  expect(() => createOfficialSessionClient({ ...config, baseURL: 'https://example.test' })).toThrow('invalid_synthetic_config');
  expect(createAuthClient).not.toHaveBeenCalled();
});
it('explicit runtime uses Expo streaming fetch and official command IDs', async () => {
  createSyntheticRuntime(config);
  const args = jest.mocked(createSessionController).mock.calls[0];
  expect(args[0]).toEqual(config); expect(args[0]).not.toBe(config); expect(Object.isFrozen(args[0])).toBe(true); expect(args[3]).toBe(randomUUID);
  const input = { url: config.baseURL, method: 'GET', headers: new Headers(), body: null, signal: new AbortController().signal } as Request;
  await args[2](input);
  expect(expoFetch).toHaveBeenCalledWith(input, { credentials: 'omit', redirect: 'error' });
});

it('encodes every exact origin character including host/port without collisions or unsafe key characters', () => {
  const origins = ['http://127.0.0.1:1234', 'http://127.0.0.1:1235', 'http://localhost:1234', 'http://[::1]:1234'];
  const prefixes = origins.map(baseURL => syntheticStoragePrefix({ ...config, baseURL }));
  expect(new Set(prefixes).size).toBe(origins.length);
  prefixes.forEach((prefix, index) => {
    expect(prefix).toMatch(/^[A-Za-z0-9._-]+$/);
    const hex = prefix.slice('pairspace-synthetic-v1-'.length);
    expect(hex.match(/.{4}/g)!.map(part => String.fromCharCode(parseInt(part, 16))).join('')).toBe(origins[index]);
  });
  expect(() => syntheticStoragePrefix({ ...config, baseURL: 'http://127.0.0.1:1234/path' })).toThrow();
});

it('journal runtime remains opt-in and disabled on web', async () => {
  const original = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  try {
    createSyntheticRuntime(config, { experimentalChatJournal: true });
    expect(jest.mocked(createSessionController).mock.calls[0][5]).toBeUndefined();
    expect(createNativeJournal).not.toHaveBeenCalled();
  } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: original }); }
});
it('native experimental runtime passes its factory promise to the protected coordinator', async () => {
  const original = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  try {
    createSyntheticRuntime(config, { experimentalChatJournal: true });
    const pending = jest.mocked(createSessionController).mock.calls[0][5];
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    expect(createNativeJournal).toHaveBeenCalledTimes(1);
  } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: original }); }
});

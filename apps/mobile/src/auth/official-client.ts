import { createAuthClient } from 'better-auth/react';
import { expoClient } from '@better-auth/expo/client';
import * as SecureStore from 'expo-secure-store';
import { syntheticStoragePrefix, type SyntheticConfig } from './config';

export type AuthIdentity = Readonly<{ userId: string; sessionId: string }>;
export type SessionClient = Readonly<{
  signIn(email: string, password: string): Promise<AuthIdentity | null>;
  signOut(): Promise<boolean>;
  getCookie(): Promise<string>;
}>;

/** Official plugin owns cookie parsing/persistence. No custom token or cookie storage. */
export function createOfficialSessionClient(config: SyntheticConfig): SessionClient {
  const storagePrefix = syntheticStoragePrefix(config);
  const client = createAuthClient({
    baseURL: config.baseURL, basePath: '/api/auth',
    plugins: [expoClient({ scheme: 'pairspace-synthetic', storagePrefix, storage: SecureStore, disableCache: true })],
    fetchOptions: { headers: { Origin: config.baseURL }, timeout: 10000, retry: 0, redirect: 'error' },
  });
  return {
    async signIn(email, password) {
      const result = await client.signIn.email({ email, password });
      if (result.error) return null;
      const verified = await client.getSession({ query: { disableCookieCache: true } });
      return verified.data ? { userId: verified.data.user.id, sessionId: verified.data.session.id } : null;
    },
    async signOut() { return !(await client.signOut()).error; },
    getCookie: () => client.getCookie(),
  };
}

import { createAuthClient } from 'better-auth/react';
import { expoClient } from '@better-auth/expo/client';
import * as SecureStore from 'expo-secure-store';

// Reserved hostname prevents accidental real backend use. Native test must set its own test server.
export const authClient = createAuthClient({
  baseURL: 'https://auth.example.invalid',
  plugins: [expoClient({ scheme: 'pairspace-spike', storagePrefix: 'pairspace-spike', storage: SecureStore, disableCache: true })],
});

// Compile-time proof of intended public client API, not executed by the screen.
export async function typeContract() {
  await authClient.signUp.email({ email: 'synthetic@example.test', password: 'Synthetic-only-password', name: 'Synthetic' });
  await authClient.signIn.email({ email: 'synthetic@example.test', password: 'Synthetic-only-password' });
  const session = await authClient.getSession();
  const cookie: string = await authClient.getCookie();
  await authClient.revokeSession({ token: 'synthetic-session-token' });
  await authClient.signOut();
  return { session, cookie };
}

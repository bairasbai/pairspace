import { Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import { randomUUID, digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto';
import { createOfficialSessionClient } from './official-client';
import { createSessionController } from './controller';
import type { SyntheticConfig } from './config';

/** Explicit harness entry only. Default App never creates this runtime or sends requests. */
export function createSyntheticRuntime(config: SyntheticConfig, options?: Readonly<{ experimentalChatJournal?: boolean }>) {
  const snapshot: SyntheticConfig = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  const client = createOfficialSessionClient(snapshot);
  const journal = options?.experimentalChatJournal && Platform.OS !== 'web'
    ? Promise.resolve().then(() => {
      // Metro resolves this statically; loading remains gated to the native opt-in.
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro static lazy module, never loaded on web/default-off.
      const native: typeof import('../chat/journal/native') = require('../chat/journal/native');
      return native.createNativeJournal();
    }) : undefined;
  return createSessionController(snapshot, client,
    // Preserve the native Request object: Expo handles RN's internal body representation.
    request => expoFetch(request, { credentials: 'omit', redirect: 'error' }), randomUUID, body => digestStringAsync(CryptoDigestAlgorithm.SHA256, body), journal);
}

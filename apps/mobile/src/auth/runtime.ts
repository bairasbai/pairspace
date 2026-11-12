import { fetch as expoFetch } from 'expo/fetch';
import { randomUUID, digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto';
import { createOfficialSessionClient } from './official-client';
import { createSessionController } from './controller';
import type { SyntheticConfig } from './config';

/** Explicit harness entry only. Default App never creates this runtime or sends requests. */
export function createSyntheticRuntime(config: SyntheticConfig) {
  const snapshot: SyntheticConfig = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  return createSessionController(snapshot, createOfficialSessionClient(snapshot),
    // Preserve the native Request object: Expo handles RN's internal body representation.
    request => expoFetch(request, { credentials: 'omit', redirect: 'error' }), randomUUID, body => digestStringAsync(CryptoDigestAlgorithm.SHA256, body));
}

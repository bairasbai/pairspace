import { registerRootComponent } from 'expo';
import { Platform } from 'react-native';
import { PairspaceApp } from '../../App';
import { createSyntheticRuntime } from '../auth/runtime';
import { validateSyntheticConfig, type SyntheticConfig } from '../auth/config';

/**
 * Explicit development entry API, inert on import. A separately selected entry must
 * supply its synthetic loopback origin. Never called by the ordinary offline index.
 * This neither starts a server nor provisions accounts, restores login, or supplies
 * credentials. Only fictional test accounts belong in the existing login panel.
 */
export function startSyntheticNativeHarness(config: SyntheticConfig): void {
  if (!__DEV__ || (Platform.OS !== 'ios' && Platform.OS !== 'android')) {
    throw new Error('synthetic_native_harness_development_only');
  }
  const snapshot: SyntheticConfig = Object.freeze({ mode: config.mode, baseURL: config.baseURL });
  validateSyntheticConfig(snapshot);
  const controller = createSyntheticRuntime(snapshot, { experimentalChatJournal: false });
  // PairspaceApp's existing owner lease disposes this controller on real unmount.
  function SyntheticNativeRoot() {
    return <PairspaceApp syntheticController={controller} />;
  }
  try {
    registerRootComponent(SyntheticNativeRoot);
  } catch (error) {
    controller.dispose();
    throw error;
  }
}

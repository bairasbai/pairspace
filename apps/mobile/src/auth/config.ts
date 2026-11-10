export type SyntheticConfig = Readonly<{
  mode: 'synthetic-loopback';
  baseURL: string;
  /** Fixture mapping only. It grants no server permission. */
  identities: Readonly<Record<string, Readonly<{ userId: string; coupleId: string; membershipEpoch: number }>>>;
}>;
/** Production networking is disabled. Tests/dev harness must inject configuration explicitly. */
export const defaultAuthConfig: SyntheticConfig | null = null;
export function validateSyntheticConfig(config: SyntheticConfig): void {
  const url = new URL(config.baseURL);
  if (config.mode !== 'synthetic-loopback' || url.protocol !== 'http:'
    || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.origin !== config.baseURL || url.username || url.password) throw new Error('invalid_synthetic_config');
}

/** Reversible namespace encoding, not cryptography: fixed-width UTF-16 code units. */
export function syntheticStoragePrefix(config: SyntheticConfig): string {
  validateSyntheticConfig(config);
  return 'pairspace-synthetic-v1-' + config.baseURL.split('')
    .map(character => character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
}

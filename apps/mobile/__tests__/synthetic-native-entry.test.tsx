import { render } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { registerRootComponent } from 'expo';
import { PairspaceApp } from '../App';
import { createSyntheticRuntime } from '../src/auth/runtime';
import { startSyntheticNativeHarness } from '../src/dev/synthetic-native-entry';
import type { SyntheticConfig } from '../src/auth/config';

const mockController = { dispose: jest.fn() };
jest.mock('expo', () => ({ registerRootComponent: jest.fn() }));
jest.mock('../App', () => ({ PairspaceApp: jest.fn(() => null) }));
jest.mock('../src/auth/runtime', () => ({ createSyntheticRuntime: jest.fn(() => mockController) }));
const config: SyntheticConfig = { mode: 'synthetic-loopback', baseURL: 'http://127.0.0.1:43210' };
const originalDev = __DEV__;
const originalOS = Platform.OS;
function dev(value: boolean) { Object.defineProperty(globalThis, '__DEV__', { value, configurable: true }); }
afterEach(() => { dev(originalDev); Platform.OS = originalOS; jest.clearAllMocks(); });

it('is inert on import: no runtime, registration, credentials or network configuration', () => {
  expect(createSyntheticRuntime).not.toHaveBeenCalled();
  expect(registerRootComponent).not.toHaveBeenCalled();
});
it.each(['ios', 'android'] as const)('explicitly registers the existing app on %s with frozen origin and journal disabled', os => {
  dev(true); Platform.OS = os;
  const input = { ...config };
  startSyntheticNativeHarness(input);
  const call = jest.mocked(createSyntheticRuntime).mock.calls[0];
  expect(call).toEqual([config, { experimentalChatJournal: false }]);
  expect(Object.isFrozen(call[0])).toBe(true);
  input.baseURL = 'http://localhost:9999';
  expect(call[0].baseURL).toBe(config.baseURL);
  const Root = jest.mocked(registerRootComponent).mock.calls[0][0];
  render(<Root />);
  expect(jest.mocked(PairspaceApp).mock.calls[0][0]).toEqual({ syntheticController: mockController });
  expect(mockController.dispose).not.toHaveBeenCalled();
});
it.each([['release', false, 'ios'], ['web', true, 'web']] as const)('rejects %s before creating a runtime', (_, enabled, os) => {
  dev(enabled); Platform.OS = os;
  expect(() => startSyntheticNativeHarness(config)).toThrow('synthetic_native_harness_development_only');
  expect(createSyntheticRuntime).not.toHaveBeenCalled();
  expect(registerRootComponent).not.toHaveBeenCalled();
});
it.each(['http://10.0.2.2:4000', 'http://192.168.1.10:4000', 'https://example.test', 'http://localhost:4000/path', 'http://u:p@localhost:4000'])('preserves the loopback contract: rejects %s', baseURL => {
  dev(true); Platform.OS = 'android';
  expect(() => startSyntheticNativeHarness({ ...config, baseURL })).toThrow('invalid_synthetic_config');
  expect(createSyntheticRuntime).not.toHaveBeenCalled();
  expect(registerRootComponent).not.toHaveBeenCalled();
});
it('cleans up if native root registration throws, preserving the original error', () => {
  dev(true); Platform.OS = 'ios';
  const failure = new Error('registration_failed');
  jest.mocked(registerRootComponent).mockImplementationOnce(() => { throw failure; });
  expect(() => startSyntheticNativeHarness(config)).toThrow(failure);
  expect(mockController.dispose).toHaveBeenCalledTimes(1);
});

import path from 'node:path';
const mockDefaults = {
  resolver: { extraNodeModules: { existing: '/existing-mapping' }, disableHierarchicalLookup: false, nodeModulesPaths: [] },
  watchFolders: [],
};
jest.mock('expo/metro-config', () => ({ getDefaultConfig: jest.fn(() => mockDefaults) }));

it('maps only Expo-owned devtools without widening hierarchical or React resolution', () => {
  // Configuration executes in Node, not in the application bundle.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const config = require('../metro.config.cjs');
  const mobile = path.resolve(__dirname, '..');
  const expoDirectory = path.dirname(require.resolve('expo/package.json'));
  const devtoolsPackage = require.resolve('@expo/devtools/package.json', { paths: [expoDirectory] });
  expect(config.resolver.disableHierarchicalLookup).toBe(true);
  expect(config.resolver.nodeModulesPaths).toEqual([path.join(mobile, 'node_modules')]);
  expect(config.watchFolders).toEqual([path.resolve(mobile, '../..')]);
  expect(config.resolver.extraNodeModules).toEqual({
    existing: '/existing-mapping', '@expo/devtools': path.dirname(devtoolsPackage),
  });
  // It resolves the real installed package, not an empty shim disabling tooling.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const manifest = require(devtoolsPackage);
  expect(manifest.name).toBe('@expo/devtools');
  expect(manifest.version).toBe('58.0.2');
  expect(manifest.license).toBe('MIT');
  expect(require.resolve(path.dirname(devtoolsPackage))).toBe(path.join(path.dirname(devtoolsPackage), 'build/index.js'));
});

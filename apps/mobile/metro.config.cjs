const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../..')];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
config.resolver.disableHierarchicalLookup = true;
// Expo's development bridge imports its own locked devtools dependency, which npm
// may nest under expo. Map only that package; do not expose nested React copies or
// re-enable parent-directory dependency lookup across the monorepo.
const expoDirectory = path.dirname(require.resolve('expo/package.json'));
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@expo/devtools': path.dirname(require.resolve('@expo/devtools/package.json', { paths: [expoDirectory] })),
};
module.exports = config;

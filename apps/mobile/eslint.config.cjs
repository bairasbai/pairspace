const { defineConfig } = require('eslint/config');
const expo = require('eslint-config-expo/flat');
module.exports = defineConfig([
  expo,
  { files: ['*.cjs'], languageOptions: { globals: { __dirname: 'readonly' } } },
  { ignores: ['dist/**', 'coverage/**', '.expo/**'] },
  { files: ['__tests__/**/*'], languageOptions: { globals: { jest: 'readonly', expect: 'readonly', it: 'readonly', beforeEach: 'readonly', afterEach: 'readonly' } } },
]);

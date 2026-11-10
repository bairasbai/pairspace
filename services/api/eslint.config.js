import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['services/api/scripts/**/*.mjs', 'services/api/tests/postgres/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly',
      Request: 'readonly', Headers: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' } } },
);

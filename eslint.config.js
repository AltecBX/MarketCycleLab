import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'e2e/out'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  { files: ['e2e/**', 'server/dev.ts', 'server/hash.ts'], languageOptions: { globals: { console: 'readonly', process: 'readonly', fetch: 'readonly', setTimeout: 'readonly', document: 'readonly', window: 'readonly', sessionStorage: 'readonly', localStorage: 'readonly', history: 'readonly', PopStateEvent: 'readonly' } }, rules: { 'no-console': 'off' } },
);

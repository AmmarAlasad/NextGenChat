// Shared base ESLint config for workspace TypeScript packages.
// Provides common ignores, JavaScript defaults, and TypeScript-aware linting.

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export const baseConfig = [
  {
    ignores: ['dist/**', 'node_modules/**', '.turbo/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      globals: {
        ...globals.es2022,
        ...globals.node,
      },
    },
  },
];

export default baseConfig;

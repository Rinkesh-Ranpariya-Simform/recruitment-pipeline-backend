import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'src/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Code conventions: Array<T> / ReadonlyArray<T>, never T[] or readonly T[].
      '@typescript-eslint/array-type': ['error', { default: 'generic', readonly: 'generic' }],
      // Object shapes are declared with `interface`, never `type X = { ... }`.
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
    },
  },
  eslintConfigPrettier,
);

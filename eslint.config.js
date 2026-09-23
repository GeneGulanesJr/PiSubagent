import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vitest from 'eslint-plugin-vitest';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TS-specific safety
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['test/**/*.ts'],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      'vitest/no-focused-tests': 'error',
      'vitest/expect-expect': [
        'error',
        {
          assertFunctionNames: ['expect', 'expectTypeOf'],
        },
      ],
    },
  },
  {
    ignores: [
      'dist/',
      'coverage/',
      'node_modules/',
      '**/*.d.ts',
      'eslint.config.js',
      'vitest.config.ts',
    ],
  },
);

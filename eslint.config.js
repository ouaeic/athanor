import eslint from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/src-tauri/target/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.mts',
      // Test-runner configuration sits outside every package's `src`, so the type-aware parser has
      // no project to resolve it against. It is tooling, not shipped code.
      '**/vitest.config.ts'
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      // React and Fastify intentionally accept promise-returning event handlers.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      // Naming a property only to leave it out of a rest spread is the idiom for omitting it, and
      // react-markdown makes it load-bearing: an undeclared `node` lands on the DOM element as
      // node="[object Object]". The binding is unread on purpose, which is what this option means.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }]
    }
  },
  {
    files: ['apps/web/**/*.tsx'],
    plugins: {
      'jsx-a11y': jsxA11y
    },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules
    }
  }
);

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    '**/build/**',
    '**/node_modules/**',
    'packages/core-backend/migrations/**',
    'workspaces/**',
  ]),
  {
    files: ['packages/**/*.{ts,tsx,js,jsx,mjs,cjs}', 'apps/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['packages/core-frontend/**/*.{ts,tsx}', 'apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
  },
  {
    // Operator scripts, run by hand with `node`, not bundled and not typed.
    // CommonJS is what `node scripts/x.cjs` wants, so the rule that forbids
    // `require()` in app source is measuring the wrong thing here.
    files: ['packages/*/scripts/**/*.cjs', 'scripts/**/*.{js,mjs,cjs}'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
])

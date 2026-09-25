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
    // The backend logs through one port (`shared/logging.ts`), so that a
    // deployment's shell decides where lines go and what shape they take. A
    // bare `console.*` in a module bypasses that decision; the sink itself is
    // the one file allowed to call it, and suites may still spy on it.
    //
    // A `*.cli.ts` entry is the exception with a reason: no deployment ever
    // EXECUTES it. It is a command someone runs by hand (`tsx src/…/x.cli.ts`),
    // and its stdout IS its output; routing that through the logging port would
    // hand a one-off diagnostic to whatever sink a shell happened to install.
    // It is still compiled into `dist` and still copied into the image, because
    // the package's tsconfig includes all of `src` — so what holds is "never on
    // a path the server runs", not "never shipped". That is the invariant the
    // rule is about: the logging port exists so a DEPLOYMENT decides where its
    // lines go, and a file the deployment never calls makes no such decision.
    files: ['packages/core-backend/src/**/*.ts'],
    ignores: [
      'packages/core-backend/src/**/__tests__/**',
      'packages/core-backend/src/shared/logging.ts',
      'packages/core-backend/src/**/*.cli.ts',
    ],
    rules: { 'no-console': 'error' },
  },
  {
    // The shared package's live bindings (`DEFAULT_BRANCH`, `PLUGINS_DIR`, …)
    // and the helpers that read them are the BROWSER'S copy of the branch
    // model and the knowledge-base layout: one process-wide value, right for
    // a page that shows one deployment. The backend serves a knowledge base
    // per composition and reads those facts from `KbContext`
    // (`packages/core-backend/src/shared/kb-context.ts`), injected into every
    // service that needs one — a server hosting several knowledge bases in one
    // process has no single value to put in a binding. This rule is what keeps
    // a backend module from reaching for the binding out of habit; the one
    // permitted site (the composition root's mirror for overlays) disables it
    // on its line and says why.
    files: ['packages/core-backend/src/**/*.ts', 'packages/mcp-core/src/**/*.ts'],
    ignores: ['packages/core-backend/src/**/__tests__/**', 'packages/core-backend/src/test-setup.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@bevel-software/platform-shared',
              importNames: [
                'DEFAULT_BRANCH',
                'PROTECTED_BRANCHES',
                'PROTECTED_BRANCH_DISPLAY_NAMES',
                'configureBranchModel',
                'currentBranchModel',
                'branchModelFromEnv',
                'KNOWLEDGE_BASE_DIR',
                'SKILLS_DIR',
                'PLUGINS_DIR',
                'AGENTS_FILE',
                'configureKbLayout',
                'currentKbLayout',
                'onKbLayoutApplied',
              ],
              message:
                'Process-wide live binding — the browser\'s copy. Read the knowledge base\'s value from the injected KbContext (shared/kb-context.ts) instead.',
            },
          ],
        },
      ],
    },
  },
  {
    // Operator scripts, run by hand with `node`, not bundled and not typed.
    // CommonJS is what `node scripts/x.cjs` wants, so the rule that forbids
    // `require()` in app source is measuring the wrong thing here.
    files: ['packages/*/scripts/**/*.cjs', 'scripts/**/*.{js,mjs,cjs}'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
])

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import { moduleBoundaries, MODULE_BOUNDARY_EXCEPTIONS } from './eslint.module-boundaries.js'

// The process-wide live bindings a backend module must not import; see the
// block that uses them below.
const LIVE_BINDING_PATHS = [
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
]

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
    // The browser's own `confirm()` can be silenced by the browser: after a
    // few dialogs it offers to stop the page creating more, and from then on
    // every `confirm()` answers false without showing anything — the page
    // reads that as Cancel, and the action it guarded stops without a word.
    // The app asks through its own dialog instead (`useConfirm()`, from the
    // shared components). A local function that happens to be called
    // `confirm` (the file tree's, `useConfirm()`'s result) is not the global
    // and is not flagged. `alert()` stays allowed: it refuses nothing.
    // `pnpm test` runs this rule over core-frontend's and apps/web's source
    // (`shared/__tests__/no-builtin-confirm.test.ts`), so CI fails on a new use.
    files: ['packages/core-frontend/**/*.{ts,tsx}', 'apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'confirm',
          message: "The browser can silence its own confirm(); ask with useConfirm() from the shared components.",
        },
      ],
      'no-restricted-properties': [
        'error',
        ...['window', 'globalThis', 'self'].map((object) => ({
          object,
          property: 'confirm',
          message: "The browser can silence its own confirm(); ask with useConfirm() from the shared components.",
        })),
      ],
    },
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
          paths: LIVE_BINDING_PATHS,
        },
      ],
    },
  },
  // Module boundaries. The Module Map promises that a domain module under
  // `packages/core-backend/src/modules/` is reached through its `index.ts`
  // (its public surface and contract) and never through its internals, so a
  // change inside one module cannot silently break another; the core
  // frontend's `src/modules/` follows the same index convention. The rule
  // is "Modular Domain-Driven Design" in the engineering knowledge base.
  //
  // The lint is the first gate because the import half of that rule is
  // mechanical: a machine answers it in seconds, for every file at once,
  // where an architecture review answers it one file per round, an hour of
  // pipeline each (PR #437 went three rounds for this alone). With the
  // import side settled here, the review spends its time on what no linter
  // sees: a file filed in the wrong module, a dependency edge the Module
  // Map forbids.
  //
  // Imports inside one module, and of `shared/`, `core/`, `lib/` and
  // packages, are untouched; so are tests, which may reach into another
  // module's internals for a fixture. `import()` expressions are not seen
  // by `no-restricted-imports`. The files not yet held to the rule are
  // listed, each with its reason, in `eslint.module-boundaries.js`; that
  // list is the backlog and only ever shrinks.
  // `module-boundaries.lint.test.ts` (core-backend) runs the rule in
  // `pnpm test`.
  //
  // These blocks come after the live-binding block above and repeat its
  // `paths` for the backend: a later block's options for the same rule
  // replace an earlier block's, they do not merge.
  ...moduleBoundaries({
    root: import.meta.dirname,
    exceptions: MODULE_BOUNDARY_EXCEPTIONS,
    paths: { 'packages/core-backend': LIVE_BINDING_PATHS },
  }),
  {
    // Operator scripts, run by hand with `node`, not bundled and not typed.
    // CommonJS is what `node scripts/x.cjs` wants, so the rule that forbids
    // `require()` in app source is measuring the wrong thing here.
    files: ['packages/*/scripts/**/*.cjs', 'scripts/**/*.{js,mjs,cjs}'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
])

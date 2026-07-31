import { defineConfig } from 'vitest/config';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

// Bounded upward walk from this config to find the monorepo `.env`. The
// real distance is fixed (`packages/core-backend/` → repo root, two hops),
// but the cap also doubles as a "we've climbed past anything reasonable"
// stop in case this file is ever copied somewhere unexpected.
const MAX_DIRECTORY_TRAVERSAL_DEPTH = 10;

// Look upward from this config for the monorepo `.env` and load it into
// `process.env` before vitest decides which files to include. This is what
// lets `*.live.test.ts` auto-enable when an API key is configured locally
// without the developer setting any extra env var. Pure JS — works the same
// on Windows, macOS, and Linux.
function loadMonorepoEnv(): void {
  let dir = __dirname;
  for (let i = 0; i < MAX_DIRECTORY_TRAVERSAL_DEPTH; i++) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
loadMonorepoEnv();

// `protected.ts` (shared) requires DEFAULT_BRANCH / PROTECTED_BRANCHES with no
// fallback. Pin the historical two-branch values so fixtures that reference
// `current-company-state` / `target-company-state` keep working regardless of
// the local `.env`. Forced (not `||=`) so a dev whose `.env` mirrors a single-
// branch prod tenant still runs the suite against the values it was written for.
process.env.DEFAULT_BRANCH = 'target-company-state';
process.env.PROTECTED_BRANCHES = 'current-company-state,target-company-state';

// `*.live.test.ts` files hit real third-party APIs using credentials from
// the local `.env`. They run only when at least one supported API key is
// present — so CI (no secrets) skips them automatically, while a developer
// with a populated `.env` gets them for free as part of `pnpm test`. The
// `test:live` script (see `package.json`) targets just these files.
const LIVE_API_KEY_VARS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;
const liveTestsEnabled = LIVE_API_KEY_VARS.some((v) => !!process.env[v]);

export default defineConfig({
  resolve: {
    alias: {
      '@bevel-software/platform-shared': path.resolve(__dirname, '../shared/src'),
    },
  },
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      ...(liveTestsEnabled ? [] : ['**/*.live.test.ts']),
    ],
    environment: 'node',
    // The git-service suites run real `git clone`/`push`/`fetch` against local
    // bare remotes; on Windows (slower fs + Defender scanning the temp clones)
    // these comfortably exceed vitest's 5s default. Linux/CI never approaches
    // this ceiling, so it only buys headroom for slow dev machines. `hookTimeout`
    // covers the `afterEach` cleanups that retry `fs.rm` past transient EBUSY.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

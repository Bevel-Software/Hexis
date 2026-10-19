import { branchModelFromEnv, configureBranchModel } from '@bevel-software/platform-shared';
import { afterAll } from 'vitest';
import { removeTestRepositoryRoots } from './__tests__/test-repositories.js';

/**
 * Apply the branch model before any suite imports something that reads it.
 *
 * The shared module no longer reads `process.env` at import time — both sides
 * configure it during boot instead (`createCoreServices` here, a fetch of
 * `/api/config` in the browser). Suites exercise pieces of the server without
 * going through `createCoreServices`, so the same call has to happen for them.
 *
 * It must live in `setupFiles` rather than `vitest.config.ts`: the config is
 * evaluated in its own module graph, so a call there configures a copy of the
 * shared module that no test ever sees.
 *
 * The values come from the environment the config pins, which keeps the one
 * place the historical two-branch pair is written.
 */
configureBranchModel(branchModelFromEnv());

// The repositories `testKbRepository` placed beside each suite's fixture root.
afterAll(removeTestRepositoryRoots);

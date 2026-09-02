import { randomBytes } from 'node:crypto';
import { branchModelFromEnv, configureBranchModel } from '@bevel-software/platform-shared';
import { initColumnCrypto } from './shared/column-crypto.js';

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

/**
 * Same reasoning for the PII column crypto: production initializes it in
 * `CoreConfig`'s constructor, which most suites never run. Services call
 * `blindIndex`/`encryptPii` on their write paths, so an uninitialized key
 * would fail every such test. A random per-run key is deliberate — nothing
 * in a unit test may depend on a specific ciphertext.
 */
initColumnCrypto(randomBytes(32).toString('base64'));

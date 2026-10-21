import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `WELCOME_PATH` is built from `LIBRARY_ROOT` while `onboarding/paths.ts`
 * loads, and it reaches the root through the Library's index, which sits in
 * an import cycle with onboarding. Whichever entry the app loads first, the
 * root must already be set when that line runs (`library/routes/library-root.ts`),
 * or the path would come out as `undefined/welcome`.
 */
const ENTRIES: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
  ['the package entry', () => import('../../../index')],
  ['the shell', () => import('../../../core/CoreAppShell')],
  ["the Library's index", () => import('../../library')],
  ["onboarding's index", () => import('..')],
  ["onboarding's paths", () => import('../paths')],
];

describe('WELCOME_PATH load order', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it.each(ENTRIES)('is under the Library root when %s loads first', async (_name, loadFirst) => {
    await loadFirst();
    const { WELCOME_PATH } = await import('..');
    const { LIBRARY_ROOT } = await import('../../library');
    expect(LIBRARY_ROOT).toBe('/skills-and-tools');
    expect(WELCOME_PATH).toBe('/skills-and-tools/welcome');
  });
});

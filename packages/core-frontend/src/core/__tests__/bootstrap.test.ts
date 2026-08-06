import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureBranchModel, DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { loadServerConfig } from '../bootstrap';

/**
 * The bootstrap runs before React does, and it is the ONLY thing between a
 * fresh deployment and its setup screen. What it must not do is treat "not
 * configured yet" as "broken" — that puts the screen which fixes the problem
 * on the far side of the error reporting it.
 */
const CONFIGURED = {
  defaultBranch: 'target-company-state',
  protectedBranches: ['current-company-state', 'target-company-state'],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // The model is module-global; restore what the shared test setup applied so
  // a later suite is not left with whatever a case here configured.
  configureBranchModel(CONFIGURED);
});

const respond = (branchModel: unknown) =>
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ branchModel }) });

describe('loadServerConfig', () => {
  it('applies a configured model', async () => {
    // Start from a different model so the assertion cannot pass by accident.
    configureBranchModel({ defaultBranch: 'main', protectedBranches: ['main'] });
    respond(CONFIGURED);
    await loadServerConfig();
    expect(DEFAULT_BRANCH).toBe('target-company-state');
  });

  /**
   * The case that made a fresh install unusable: the server answers with an
   * empty model because nobody has set one, and the bootstrap must let the app
   * mount so `SetupGate` can render the screen that collects it.
   */
  it('does not fail on a deployment that has not been set up yet', async () => {
    respond({ defaultBranch: '', protectedBranches: [] });
    await expect(loadServerConfig()).resolves.toBeUndefined();
  });

  /** A half-set model is no more usable than an empty one, and no more fatal. */
  it('tolerates a model that is present but incoherent', async () => {
    respond({ defaultBranch: 'main', protectedBranches: ['release'] });
    await expect(loadServerConfig()).resolves.toBeUndefined();
  });

  /** A server that cannot be reached IS a failure — the caller reports it. */
  it('still fails when the request itself does', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 });
    await expect(loadServerConfig()).rejects.toThrow(/Could not load configuration/);
  });
});

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startCore, type BootableCore } from '../lifecycle.js';
import { ClassifiedFailure, gitFailure } from '../../shared/git-failure.js';
import {
  KbRemoteUnreachableError,
  bootMaySurvive,
} from '../../modules/workspace/startup/kb-startup-runner.js';

/**
 * A boot over a knowledge-base repository the host will not serve.
 *
 * On 2026-09-28 a deployment's repository was deleted and replaced. The new
 * address saved and its connection test passed, but a working copy still
 * fetching through the OLD address answered "repository not found" inside a
 * startup step — which was not the one failure a boot survived, so the
 * container stopped, restarted, and stopped again, taking the setup screen
 * that would have fixed it with it.
 *
 * The rule now: whatever the host ANSWERED about the repository or the
 * credentials lets the boot come up GATED. Only a failure that says the
 * knowledge base itself would be written wrong still stops it.
 */

/** An empty workspaces root, so the beside-the-checkout note finds nothing to say. */
let workspacesRoot: string;

beforeEach(async () => {
  workspacesRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gated-boot-'));
});

afterEach(async () => {
  await fsp.rm(workspacesRoot, { recursive: true, force: true });
});

/** A core whose startup phase fails in a way the test picks. */
function bootable(runAll: () => Promise<void>) {
  const retries = { started: 0 };
  const core: BootableCore = {
    config: { workspacesRoot },
    kbDirName: 'knowledge-base',
    kbStartupRunner: {
      runAll,
      retryUntilMaintained: () => {
        retries.started += 1;
        return { stop() {} };
      },
    } as BootableCore['kbStartupRunner'],
    workflowService: {
      closeChangeRequestsWithDeletedBranches: async () => 0,
    } as BootableCore['workflowService'],
    pluginJoinRequestJobs: { startSweeping() {} } as BootableCore['pluginJoinRequestJobs'],
    startupRetry: null,
  };
  return { core, retries };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startCore over a repository the host will not serve', () => {
  it('comes up gated on "repository not found" raised inside the phase — no restart loop', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { core, retries } = bootable(async () => {
      throw new ClassifiedFailure(
        'KB startup step "groups-to-plugins" failed: git fetch failed: repository not found',
        gitFailure('not-found'),
      );
    });

    // Resolves: the server boots. The setup routes keep it gated on the
    // runner's standing failure, and the admin can sign in and fix it.
    await expect(startCore(core)).resolves.toBeUndefined();
    // And it keeps asking on its own: a repository that is created, or a token
    // that is granted access to it, needs no settings change on this side.
    expect(retries.started).toBe(1);
    expect(core.startupRetry).not.toBeNull();
  });

  it('comes up gated when the host rejected the credentials', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { core } = bootable(async () => {
      throw new ClassifiedFailure('git push failed: Authentication failed', gitFailure('credentials-rejected'));
    });
    await expect(startCore(core)).resolves.toBeUndefined();
  });

  it('still STOPS the boot when the failure is about what a step would write', async () => {
    const { core, retries } = bootable(async () => {
      throw new ClassifiedFailure(
        'KB startup step "template-files" failed: the template is missing roles.yaml',
        { kind: 'step-failed', cause: 'The startup step "template-files" failed.' },
      );
    });

    // Booting over this would scaffold something wrong into every branch.
    await expect(startCore(core)).rejects.toThrow(/template-files/);
    expect(retries.started).toBe(0);
  });
});

describe('bootMaySurvive', () => {
  it('says yes to the remote being out of reach, whatever raised it', () => {
    expect(bootMaySurvive(new KbRemoteUnreachableError('could not be reached'))).toBe(true);
    expect(bootMaySurvive(new ClassifiedFailure('x', gitFailure('unreachable')))).toBe(true);
  });

  it('says yes to what the host answered about the repository or the credentials', () => {
    for (const kind of ['not-found', 'credentials-rejected', 'write-refused'] as const) {
      expect({ kind, survives: bootMaySurvive(new ClassifiedFailure('x', gitFailure(kind))) }).toEqual({
        kind,
        survives: true,
      });
    }
  });

  it('says no to everything else — those say the knowledge base would be written wrong', () => {
    expect(bootMaySurvive(new ClassifiedFailure('x', gitFailure('push-refused-by-policy')))).toBe(false);
    expect(bootMaySurvive(new ClassifiedFailure('x', gitFailure('unknown')))).toBe(false);
    expect(bootMaySurvive(new Error('a step threw'))).toBe(false);
  });
});

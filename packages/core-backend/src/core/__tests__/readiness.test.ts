import { describe, it, expect } from 'vitest';
import {
  createReadiness,
  DISK_FREE_DEGRADED_BYTES,
  QUEUE_AGE_DEGRADED_MS,
  type ReadinessDeps,
} from '../readiness.js';

const NOW = new Date('2026-09-15T12:00:00Z').getTime();

/** A healthy deployment, which each case then breaks in exactly one place. */
function healthy(overrides: Partial<ReadinessDeps> = {}): ReadinessDeps {
  return {
    db: { execute: async () => [] as never },
    oldestQueuedAt: async () => null,
    drains: () => true,
    lastRemoteContact: () => ({ at: NOW - 30_000, ok: true }),
    freeBytes: async () => 50 * DISK_FREE_DEGRADED_BYTES,
    now: () => NOW,
    ...overrides,
  };
}

describe('createReadiness', () => {
  it('reports ok when every fact is fine, with the numbers an alert would read', async () => {
    const report = await createReadiness(healthy())();
    expect(report.status).toBe('ok');
    expect(report.checks.commitQueue).toEqual({ ok: true, oldestPendingSeconds: null, draining: true });
    expect(report.checks.gitRemote).toEqual({ ok: true, lastContactSeconds: 30 });
    expect(report.checks.disk.ok).toBe(true);
    expect(report.timestamp).toBe(NOW);
  });

  it('is unavailable, and only then, when the database cannot be reached', async () => {
    const report = await createReadiness(
      healthy({
        db: {
          execute: async () => {
            throw new Error('connection refused');
          },
        },
      }),
    )();
    expect(report.status).toBe('unavailable');
    expect(report.checks.database.ok).toBe(false);
  });

  it('degrades on a commit that has waited longer than the threshold, and says how long', async () => {
    const queuedAt = new Date(NOW - QUEUE_AGE_DEGRADED_MS - 1000);
    const report = await createReadiness(healthy({ oldestQueuedAt: async () => queuedAt }))();
    expect(report.status).toBe('degraded');
    expect(report.checks.commitQueue.ok).toBe(false);
    expect(report.checks.commitQueue.oldestPendingSeconds).toBe(QUEUE_AGE_DEGRADED_MS / 1000 + 1);
  });

  it('a recent backlog is not a degradation', async () => {
    const report = await createReadiness(healthy({ oldestQueuedAt: async () => new Date(NOW - 5_000) }))();
    expect(report.status).toBe('ok');
    expect(report.checks.commitQueue.oldestPendingSeconds).toBe(5);
  });

  it('a standby that does not hold the lease is healthy, and says it is not draining', async () => {
    // During a redeploy the replacement serves requests without the lease. That
    // is the designed state, not a fault — a probe that failed it would have an
    // orchestrator restart the healthy replacement.
    const report = await createReadiness(healthy({ drains: () => false }))();
    expect(report.status).toBe('ok');
    expect(report.checks.commitQueue.draining).toBe(false);
  });

  it('degrades when the last attempt to reach the remote failed', async () => {
    const report = await createReadiness(healthy({ lastRemoteContact: () => ({ at: NOW - 60_000, ok: false }) }))();
    expect(report.status).toBe('degraded');
    expect(report.checks.gitRemote).toEqual({ ok: false, lastContactSeconds: 60 });
  });

  it('a process that has not yet reached the remote is not degraded by that', async () => {
    const report = await createReadiness(healthy({ lastRemoteContact: () => null }))();
    expect(report.status).toBe('ok');
    expect(report.checks.gitRemote).toEqual({ ok: true, lastContactSeconds: null });
  });

  it('degrades when the volume is nearly full, and stays ok when it cannot say', async () => {
    const full = await createReadiness(healthy({ freeBytes: async () => DISK_FREE_DEGRADED_BYTES - 1 }))();
    expect(full.status).toBe('degraded');
    expect(full.checks.disk.ok).toBe(false);

    const unknown = await createReadiness(healthy({ freeBytes: async () => null }))();
    expect(unknown.status).toBe('ok');
    expect(unknown.checks.disk).toEqual({ ok: true, freeBytes: null });
  });

  it('a fact that throws counts against itself alone', async () => {
    const report = await createReadiness(
      healthy({
        oldestQueuedAt: async () => {
          throw new Error('relation missing');
        },
        freeBytes: async () => {
          throw new Error('statfs unsupported');
        },
      }),
    )();
    // Neither could answer; neither is known bad; the rest is untouched.
    expect(report.status).toBe('ok');
    expect(report.checks.commitQueue.oldestPendingSeconds).toBeNull();
    expect(report.checks.disk.freeBytes).toBeNull();
  });
});

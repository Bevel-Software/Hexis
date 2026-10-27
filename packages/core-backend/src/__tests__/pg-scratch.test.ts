import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `openMigratedScratchDb` owns the pool it opens until it hands the handle
 * over: when the migrations fail, the caller never receives `close`, so the
 * helper must close the pool itself and let the error through. No Postgres
 * here — the connection, the migrations and the `pg` admin client are stubs,
 * since the subject is the helper's ownership of what it opened, not the
 * database.
 */

const stubs = vi.hoisted(() => ({
  db: { kind: 'fake-db' },
  createDb: vi.fn(),
  closeDb: vi.fn(async () => {}),
  runCoreMigrations: vi.fn(async () => {}),
  adminQuery: vi.fn(async () => ({ rows: [] })),
}));

vi.mock('../modules/database/connection.js', () => ({
  createDb: stubs.createDb,
  closeDb: stubs.closeDb,
}));
vi.mock('../modules/database/migrate.js', () => ({
  runCoreMigrations: stubs.runCoreMigrations,
}));
vi.mock('../assets.js', () => ({ coreMigrationsDir: () => '/migrations' }));
vi.mock('pg', () => ({
  default: {
    Client: class {
      connect = async () => {};
      query = stubs.adminQuery;
      end = async () => {};
    },
  },
}));

// Read once, at import: a URL the stubbed admin client will never dial.
process.env.TEST_DATABASE_URL = 'postgres://scratch:scratch@127.0.0.1:1/admin';
const { openMigratedScratchDb } = await import('./pg-scratch.js');

describe('openMigratedScratchDb', () => {
  beforeEach(() => {
    stubs.createDb.mockReturnValue(stubs.db);
  });

  afterEach(() => {
    vi.clearAllMocks();
    stubs.runCoreMigrations.mockResolvedValue(undefined);
  });

  it('hands the migrated database over with a close the caller owns', async () => {
    const opened = await openMigratedScratchDb('hexis_owned');
    expect(opened.db).toBe(stubs.db);
    expect(stubs.runCoreMigrations).toHaveBeenCalledWith(stubs.db, '/migrations');
    // The pool stays open until the caller closes it.
    expect(stubs.closeDb).not.toHaveBeenCalled();
    await opened.close();
    expect(stubs.closeDb).toHaveBeenCalledWith(stubs.db);
  });

  it('closes the pool it opened when the migrations fail, and lets the failure through', async () => {
    stubs.runCoreMigrations.mockRejectedValueOnce(new Error('migration 0022 failed'));
    await expect(openMigratedScratchDb('hexis_failed')).rejects.toThrow('migration 0022 failed');
    // Closed by the helper: the caller never received a handle to close.
    expect(stubs.closeDb).toHaveBeenCalledTimes(1);
    expect(stubs.closeDb).toHaveBeenCalledWith(stubs.db);
  });
});

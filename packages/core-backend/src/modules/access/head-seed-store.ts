import { eq } from 'drizzle-orm';
import type { Database } from '../database/index.js';
import { accessHeadSeeds } from '../database/index.js';
import type { HeadSeed, IHeadSeedStore } from './head-access-map.js';

/** The one row a deployment keeps. */
const KEY = 'latest';

/**
 * The head maps' seed in the database (`access_head_seeds`): one row, read
 * only when the release that wrote it is the one running. Which file
 * versions declare something is a release's reading of them, so another
 * release's list is not trusted and that start reads the files again.
 */
export class DbHeadSeedStore implements IHeadSeedStore {
  constructor(
    private readonly db: Database,
    /** The running release (`resolveAppVersion`). */
    private readonly version: string,
  ) {}

  async load(): Promise<HeadSeed | null> {
    const [row] = await this.db.select().from(accessHeadSeeds).where(eq(accessHeadSeeds.key, KEY)).limit(1);
    if (!row || row.version !== this.version) return null;
    const declaring = row.declaring;
    const wellFormed =
      Array.isArray(declaring) &&
      declaring.every((d) => Array.isArray(d) && d.length === 2 && typeof d[0] === 'string' && typeof d[1] === 'string');
    return wellFormed ? { commit: row.commit, declaring } : null;
  }

  async save(seed: HeadSeed): Promise<void> {
    const values = { version: this.version, commit: seed.commit, declaring: seed.declaring.map(([p, id]) => [p, id] as [string, string]) };
    await this.db
      .insert(accessHeadSeeds)
      .values({ key: KEY, ...values })
      .onConflictDoUpdate({ target: accessHeadSeeds.key, set: { ...values, updatedAt: new Date() } });
  }
}

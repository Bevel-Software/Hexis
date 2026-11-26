import { eq } from 'drizzle-orm';
import type { Database } from '../database/index.js';
import { accessHeadSeeds } from '../database/index.js';
import type { HeadSeed, IHeadSeedStore } from './head-access-map.js';

/** The one row a deployment keeps. */
const KEY = 'latest';

/**
 * The head maps' seed in the database (`access_head_seeds`): one row, read
 * only by the build that wrote it. A seed lists the file versions that
 * declare something, and every version it leaves out is taken to declare
 * nothing; another build may read some of those versions otherwise (a fix to
 * a parser in between), so its list is not trusted and that start reads the
 * files again. The row is keyed by the reading (`ACCESS_READING_VERSION`)
 * and the build's git sha. A build whose sha is unknown reads and saves no
 * seed: two such builds could not be told apart.
 */
export class DbHeadSeedStore implements IHeadSeedStore {
  /** What this build's row is keyed by, or null when it keeps none. */
  private readonly version: string | null;

  constructor(
    private readonly db: Database,
    /**
     * The reading the head maps make (`ACCESS_READING_VERSION`) and the
     * running build's git sha (`GIT_SHA`, which is `'unknown'` when the
     * build was given none).
     */
    build: { reading: number; sha: string },
  ) {
    this.version = build.sha === '' || build.sha === 'unknown' ? null : `${build.reading}:${build.sha}`;
  }

  async load(): Promise<HeadSeed | null> {
    if (this.version === null) return null;
    const [row] = await this.db.select().from(accessHeadSeeds).where(eq(accessHeadSeeds.key, KEY)).limit(1);
    if (!row || row.version !== this.version) return null;
    const declaring = row.declaring;
    const wellFormed =
      Array.isArray(declaring) &&
      declaring.every((d) => Array.isArray(d) && d.length === 2 && typeof d[0] === 'string' && typeof d[1] === 'string');
    return wellFormed ? { commit: row.commit, declaring } : null;
  }

  async save(seed: HeadSeed): Promise<void> {
    if (this.version === null) return;
    const values = { version: this.version, commit: seed.commit, declaring: seed.declaring.map(([p, id]) => [p, id] as [string, string]) };
    await this.db
      .insert(accessHeadSeeds)
      .values({ key: KEY, ...values })
      .onConflictDoUpdate({ target: accessHeadSeeds.key, set: { ...values, updatedAt: new Date() } });
  }
}

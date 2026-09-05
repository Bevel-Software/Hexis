import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { ISkillService } from '../../skills/skills.contract.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { PluginLinkIndex } from '../plugin-links.js';
import type { PluginSource } from '../discovery/plugin-source.js';
import { KbPluginSource } from '../discovery/kb-plugin-source.js';
import { compileMarketplace, type VirtualTree } from './compile-marketplace.js';

const execFileAsync = promisify(execFile);

/** Whose view of the knowledge base to compile. */
export type CompileAudience = { userEmail: string } | { everyone: true };

/**
 * The compiler wired to the live deployment: the default-branch checkout,
 * the released catalog, the link index, and the access resolver as the read
 * verdict. Every sink — the per-user git endpoint, a public mirror, a local
 * export — asks this for a tree and writes it somewhere.
 *
 * Two audiences: a PERSON (their `canRead` per skill, exactly the catalog's
 * filter) or EVERYONE (only what `read: everyone` reaches cleanly — the
 * public subset a shared mirror may carry). Nothing in between: an audience
 * that is "these three people" would need a union of verdicts nobody has
 * asked for yet.
 */
export class MarketplaceCompilerService {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly accessControl: IAccessControl,
    private readonly skillService: ISkillService,
    private readonly links: PluginLinkIndex,
    private readonly kbDirName: string,
    private readonly marketplace: {
      name: string;
      owner: string;
      description?: string;
      /** The hosted MCP endpoint to ship in the skills plugin (URL only). */
      knowledgeBaseMcp?: { name: string; url: string };
    },
    private readonly source: PluginSource = new KbPluginSource(),
  ) {}

  /**
   * The default-branch commit the next compile would read. Throws when git
   * cannot say: the repo service keys freshness on this value, and a stable
   * placeholder would make every later compile look unnecessary — source
   * changes and access revocations would never reach that caller again.
   */
  async sourceCommit(): Promise<string> {
    const { kbRoot } = await this.checkout();
    const { stdout } = await execFileAsync('git', ['-C', kbRoot, 'rev-parse', 'HEAD']);
    const sha = stdout.trim();
    // SHA-1 or SHA-256 object format: any hex object id is a commit.
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`could not read the default branch's commit (${sha || 'empty'})`);
    return sha;
  }

  async compileFor(
    audience: CompileAudience,
    /** The commit to stamp the tree with, when the caller already read it (the freshness check does). */
    knownCommit?: string,
  ): Promise<VirtualTree & { sourceCommit: string }> {
    const { wsId, kbRoot } = await this.checkout();
    // Strictness about the commit belongs to the FRESHNESS check (the repo
    // service calls `sourceCommit()` itself and refuses to serve without
    // one). A compile of a checkout git cannot describe still yields a
    // correct tree; only its README and bundle version lose the sha.
    const sourceCommit = knownCommit ?? (await this.sourceCommit().catch(() => 'unknown'));
    const skills = await this.skillService.listSkills(undefined);
    const membership = await this.links.membership();
    const { plugins } = await this.source.discover(kbRoot);
    const readable = await this.readPredicate(wsId, audience, skills.map((s) => `${s.path}/SKILL.md`));
    const tree = await compileMarketplace({
      kbRoot,
      skills,
      plugins,
      membership,
      readable,
      options: { ...this.marketplace, sourceCommit },
    });
    return { ...tree, sourceCommit };
  }

  // --- internal --------------------------------------------------------------

  private async checkout(): Promise<{ wsId: string; kbRoot: string }> {
    const wsId = (await this.workspaceService.getOrCreateForBranch(DEFAULT_BRANCH)).id;
    return { wsId, kbRoot: path.join(await this.workspaceService.getWorkspacePath(wsId), this.kbDirName) };
  }

  /**
   * One batch verdict per compile, then a lookup. Fail closed both ways: a
   * path the batch skipped is unreadable, and for the everyone audience a
   * skill is public only when the resolver says `read: everyone` applies
   * cleanly (`restricted: false`).
   */
  private async readPredicate(
    wsId: string,
    audience: CompileAudience,
    docPaths: string[],
  ): Promise<(repoPath: string) => Promise<boolean>> {
    if ('userEmail' in audience) {
      const verdicts = docPaths.length
        ? await this.accessControl.canReadBatch(wsId, audience.userEmail, docPaths)
        : new Map<string, boolean>();
      return async (p) => verdicts.get(p) === true;
    }
    const cache = new Map<string, boolean>();
    return async (p) => {
      const hit = cache.get(p);
      if (hit !== undefined) return hit;
      let verdict = false;
      try {
        verdict = !(await this.accessControl.eligibleReaders(wsId, p)).restricted;
      } catch {
        verdict = false;
      }
      cache.set(p, verdict);
      return verdict;
    };
  }
}

/** The default-branch workspace id compiles run against. */
export function compileWorkspaceId(): string {
  return workspaceIdForBranch(DEFAULT_BRANCH);
}

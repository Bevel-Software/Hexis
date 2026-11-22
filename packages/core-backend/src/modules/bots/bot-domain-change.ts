import path from 'node:path';
import type { AuthUser, IVersionControlService } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import { redactSecret } from '../../shared/redact-secret.js';
import type { ITreeWalker } from '../../shared/fs.contract.js';
import { rewriteBotGrants } from './bot-domain.js';

const log = logger('bots');

/** What opening the grant-rewriting change request needs of the workspace. */
export interface GrantRewriteWorkspace {
  getOrCreateForBranch(branch: string): Promise<{ id: string }>;
  /** The workspace's folder on disk; the knowledge base is its `kbDirName` folder. */
  getWorkspacePath(workspaceId: string): Promise<string>;
  readFile(workspaceId: string, wsPath: string): Promise<string>;
  writeFile(workspaceId: string, wsPath: string, content: string): Promise<void>;
}

/**
 * What changing the bots' domain answers: the new domain, the change request
 * rewriting the grants (null when no grant names a bot at the old domain),
 * and, when that request could not be opened, the one sentence saying so.
 */
export interface DomainChange {
  domain: string;
  changeRequest: number | null;
  changeRequestError?: string;
}

/** Opens the change request that rewrites the grants of a domain change; answers its number, or null when no grant names a bot. */
export interface IGrantRewriter {
  open(by: AuthUser, from: string, to: string, botIds: readonly string[]): Promise<number | null>;
}

/**
 * The change request a bots' domain change opens: one branch cut from the
 * default branch, every file whose grants name a bot at the old domain
 * rewritten to the new one, committed by the admin who changed it, and one
 * request into the default branch for a person to review and merge. Until it
 * is merged, the old spelling still counts (see `BotService.changeDomain`).
 *
 * The files it reads are the ones the access model reads, found the way the
 * access model finds them: the knowledge-base walk (`ITreeWalker.walkKb`),
 * which does NOT honour `.bevelignore`. Core's own template hides every
 * `access.md` and `roles.yaml` from the explorer, so the explorer's walk
 * would find no grant at all and the old domain would count forever. A
 * folder the walk cannot list refuses the whole rewrite: a request that
 * rewrote only the grants it happened to see would leave the rest at the
 * old domain once merged.
 *
 * It reads them from the new branch's own checkout, the committed default
 * branch, never from the default branch's working copy: a file there that is
 * not committed is not the target's, and a request carrying it cannot merge.
 * A branch no request comes from (nothing to rewrite, or the rewrite failed
 * before the request) is removed again.
 */
export class GrantRewriteChangeRequests implements IGrantRewriter {
  constructor(
    private readonly deps: {
      versionControl: Pick<IVersionControlService, 'createBranch' | 'deleteBranch' | 'commitChanges' | 'openChangeRequest'>;
      workspace: GrantRewriteWorkspace;
      walker: Pick<ITreeWalker, 'walkKb'>;
      kb: { readonly defaultBranch: string; readonly kbDirName: string; defaultWorkspaceId(): string };
      /** An access file: `access.md` at any depth, `roles.yaml`, a group file. Its grants are rewritten anywhere in it. */
      isAccessFile: (repoRelativePath: string) => boolean;
      /** A file whose own frontmatter carries access lines (`.md`, `.tool`, an overlay's kinds). Only its frontmatter is rewritten. */
      hasOwnAccessLines: (repoRelativePath: string) => boolean;
    },
  ) {}

  /** Every file that can carry a grant, keyed by repo-relative path; throws when a folder cannot be listed. */
  private async grantCarryingFiles(workspaceId: string): Promise<Record<string, string>> {
    const { workspace, walker, kb, isAccessFile, hasOwnAccessLines } = this.deps;
    const repoDir = path.join(await workspace.getWorkspacePath(workspaceId), kb.kbDirName);
    const paths: string[] = [];
    await walker.walkKb(
      repoDir,
      [
        {
          onFile(dir, name) {
            const rel = dir ? `${dir}/${name}` : name;
            if (isAccessFile(rel) || hasOwnAccessLines(rel)) paths.push(rel);
          },
        },
      ],
      { unreadable: 'throw' },
    );
    const texts: Record<string, string> = {};
    for (const rel of paths) texts[rel] = await workspace.readFile(workspaceId, `${kb.kbDirName}/${rel}`);
    return texts;
  }

  async open(by: AuthUser, from: string, to: string, botIds: readonly string[]): Promise<number | null> {
    const { versionControl, workspace, kb, isAccessFile } = this.deps;
    const live = kb.defaultWorkspaceId();
    // The branch first, and the grants read from ITS checkout: a fresh clone
    // of the committed default branch, the very tree the request merges into.
    // The default branch's own working copy also holds what is not committed
    // (an unzip's extracted files, a save still landing); read from there, a
    // file the target does not hold would be added by the request, whose
    // merge then fails on the untracked copy and, once that is saved,
    // conflicts add/add.
    const branch = `bots/domain-${to.replace(/[^a-z0-9.-]/g, '-')}-${Date.now().toString(36)}`;
    await versionControl.createBranch(live, branch, kb.defaultBranch);
    let rewritten: (readonly [string, string])[];
    let ws: { id: string };
    try {
      ws = await workspace.getOrCreateForBranch(branch);
      const texts = await this.grantCarryingFiles(ws.id);
      rewritten = Object.entries(texts).flatMap(([rel, text]) => {
        const next = rewriteBotGrants(rel, text, botIds, from, to, isAccessFile);
        return next === null ? [] : [[rel, next] as const];
      });
      if (rewritten.length > 0) {
        for (const [rel, text] of rewritten) await workspace.writeFile(ws.id, `${kb.kbDirName}/${rel}`, text);
        await versionControl.commitChanges(ws.id, by, `Address bots at ${to} instead of ${from}`);
      }
    } catch (err) {
      // No request will come from the branch: it goes, and the failure that
      // stopped the rewrite is what the caller hears.
      await this.dropBranch(live, branch, by);
      throw err;
    }
    if (rewritten.length === 0) {
      await this.dropBranch(live, branch, by);
      return null;
    }

    const detail = await versionControl.openChangeRequest(ws.id, by, {
      sourceBranch: branch,
      targetBranch: kb.defaultBranch,
      title: `Bots' domain: ${from} → ${to}`,
      description:
        `The bots' domain changed from ${from} to ${to}, so every bot's address changed with it. ` +
        `This rewrites the ${rewritten.length} file(s) whose grants still name a bot at ${from}. ` +
        `Until it is merged, a grant at ${from} still counts for its bot.`,
    });
    log.info(`bots' domain change: change request #${detail.number} rewrites ${rewritten.length} file(s)`);
    return detail.number;
  }

  /**
   * Removes a rewrite branch no request comes from. Its failure is logged
   * (scrubbed: git quotes its remote back) and not thrown: the caller's answer
   * — the request, none, or the failure that stopped it — is already decided
   * and stays true; what is left is an unreferenced branch an admin can delete.
   */
  private async dropBranch(live: string, branch: string, by: AuthUser): Promise<void> {
    try {
      await this.deps.versionControl.deleteBranch(live, branch, by);
    } catch (err) {
      log.warn(
        `bots' domain change: could not remove the unused branch ${branch}: ` +
          redactSecret(err instanceof Error ? err.message : String(err)),
      );
    }
  }
}

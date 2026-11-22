import path from 'node:path';
import type { AuthUser, IVersionControlService } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
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
 */
export class GrantRewriteChangeRequests implements IGrantRewriter {
  constructor(
    private readonly deps: {
      versionControl: Pick<IVersionControlService, 'createBranch' | 'commitChanges' | 'openChangeRequest'>;
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
    const texts = await this.grantCarryingFiles(live);
    const rewritten = Object.entries(texts).flatMap(([rel, text]) => {
      const next = rewriteBotGrants(rel, text, botIds, from, to, isAccessFile);
      return next === null ? [] : [[rel, next] as const];
    });
    if (rewritten.length === 0) return null;

    const branch = `bots/domain-${to.replace(/[^a-z0-9.-]/g, '-')}-${Date.now().toString(36)}`;
    await versionControl.createBranch(live, branch, kb.defaultBranch);
    const ws = await workspace.getOrCreateForBranch(branch);
    for (const [rel, text] of rewritten) await workspace.writeFile(ws.id, `${kb.kbDirName}/${rel}`, text);
    await versionControl.commitChanges(ws.id, by, `Address bots at ${to} instead of ${from}`);
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
}

import type { AuthUser, IVersionControlService } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import { isAbsence } from '../../shared/fs.contract.js';
import { rewriteBotGrants } from './bot-domain.js';

const log = logger('bots');

/** What opening the grant-rewriting change request needs of the workspace. */
export interface GrantRewriteWorkspace {
  getOrCreateForBranch(branch: string): Promise<{ id: string }>;
  readFile(workspaceId: string, wsPath: string): Promise<string>;
  writeFile(workspaceId: string, wsPath: string, content: string): Promise<void>;
  /** Every `.md` file of the knowledge base, keyed by repo-relative path. */
  readAllKbFiles(workspaceId: string): Promise<Record<string, string>>;
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
 */
export class GrantRewriteChangeRequests implements IGrantRewriter {
  constructor(
    private readonly deps: {
      versionControl: Pick<IVersionControlService, 'createBranch' | 'commitChanges' | 'openChangeRequest'>;
      workspace: GrantRewriteWorkspace;
      kb: { readonly defaultBranch: string; readonly kbDirName: string; defaultWorkspaceId(): string };
      isAccessFile: (repoRelativePath: string) => boolean;
      /** The non-markdown access files to rewrite too (`roles.yaml`, the group files). */
      yamlAccessFiles: readonly string[];
    },
  ) {}

  async open(by: AuthUser, from: string, to: string, botIds: readonly string[]): Promise<number | null> {
    const { versionControl, workspace, kb, isAccessFile } = this.deps;
    const live = kb.defaultWorkspaceId();
    const texts: Record<string, string> = { ...(await workspace.readAllKbFiles(live)) };
    for (const file of this.deps.yamlAccessFiles) {
      try {
        texts[file] = await workspace.readFile(live, `${kb.kbDirName}/${file}`);
      } catch (err) {
        if (!isAbsence(err)) throw err;
      }
    }
    const rewritten = Object.entries(texts).flatMap(([path, text]) => {
      const next = rewriteBotGrants(path, text, botIds, from, to, isAccessFile);
      return next === null ? [] : [[path, next] as const];
    });
    if (rewritten.length === 0) return null;

    const branch = `bots/domain-${to.replace(/[^a-z0-9.-]/g, '-')}-${Date.now().toString(36)}`;
    await versionControl.createBranch(live, branch, kb.defaultBranch);
    const ws = await workspace.getOrCreateForBranch(branch);
    for (const [path, text] of rewritten) await workspace.writeFile(ws.id, `${kb.kbDirName}/${path}`, text);
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

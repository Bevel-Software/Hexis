import { createHash } from 'node:crypto';
import path from 'node:path';
import { logger } from '../../shared/logging.js';
import type { KbContext } from '../../shared/kb-context.js';
import type { ITreeWalker } from '../../shared/fs.contract.js';
import { pathUnderRoot, type IWorkspaceService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../access/index.js';
import {
  AGENT_FILE_EXTENSION,
  AgentFileError,
  normalizeEntryPath,
  parseAgentFile,
  type AgentFileDefinition,
} from './agent-file.js';
import { ConnectionScope } from './connection-scope.js';
import type { AgentChoice, IAgentScopeResolver } from './agent-scope.contract.js';

const log = logger('agent-scope');

/**
 * The plugins a `plugins:` entry stands for, with the skills each links from
 * elsewhere — the plugin link index's answer (`modules/plugins`), which
 * already resolves every manifest against the released catalog.
 */
export interface PluginFoldersPort {
  membership(): Promise<{
    byPlugin: ReadonlyMap<string, { folder: string; linkedSkills: readonly string[] }>;
  }>;
}

/**
 * Resolves connections' scopes from the `.agent` files of the default branch
 * — see {@link IAgentScopeResolver}.
 *
 * Read access is applied twice, and both times as the PERSON: to the
 * `.agent` file (a file they may not read is one they cannot connect as, and
 * one they can no longer read loads nothing), and — by every surface that
 * consults the scope — to each skill and connector the lists name, which
 * those surfaces only ever ask about after their own read gate. So a list
 * naming something the person may not read loads nothing for it, and a list
 * can never add to what they may read.
 */
export class AgentScopeService implements IAgentScopeResolver {
  constructor(
    private readonly workspaceService: Pick<IWorkspaceService, 'getOrCreateForBranch' | 'getWorkspacePath' | 'readFile'>,
    private readonly accessControl: Pick<IAccessControl, 'canReadBatch'>,
    private readonly kb: Pick<KbContext, 'kbDirName' | 'defaultBranch'>,
    private readonly disk: Pick<ITreeWalker, 'walkFiles'>,
    private readonly plugins: PluginFoldersPort,
  ) {}

  async resolve(userEmail: string | undefined, agentPath: string | null | undefined): Promise<ConnectionScope> {
    if (agentPath === null || agentPath === undefined || agentPath === '') return ConnectionScope.everything();
    const rel = normalizeEntryPath(agentPath);
    const gone = (): ConnectionScope => ConnectionScope.gone(rel ?? agentPath);
    if (!userEmail || rel === null || !rel.endsWith(AGENT_FILE_EXTENSION)) return gone();
    const read = await this.readAgent(userEmail, rel);
    if (read === null) return gone();
    if (read.kind === 'invalid') {
      return ConnectionScope.unavailable(
        { path: rel, name: rel },
        `This connection was made as the agent file \`${rel}\`, which is not a valid agent definition ` +
          `(${read.reason}), so it loads no tools and no skills until the file is fixed.`,
        `agent\u0000${rel}\u0000${read.digest}`,
      );
    }
    const def = read.definition;
    // Each `plugins:` entry is a plugin folder or a folder above several:
    // every plugin at or under it, by the folders the link index knows, with
    // the skills its manifest links from elsewhere.
    const pluginFolders: string[] = [];
    const linkedSkills: string[] = [];
    if (def.plugins.length > 0) {
      const { byPlugin } = await this.plugins.membership();
      for (const plugin of byPlugin.values()) {
        if (!def.plugins.some((entry) => pathUnderRoot(plugin.folder, entry))) continue;
        pluginFolders.push(plugin.folder);
        linkedSkills.push(...plugin.linkedSkills);
      }
    }
    return ConnectionScope.narrowed(
      { path: rel, name: def.name },
      {
        skills: [...def.skills, ...pluginFolders, ...linkedSkills],
        connectors: [...def.connectors, ...pluginFolders],
        platformTools: def.platformTools,
      },
      `agent\u0000${rel}\u0000${read.digest}`,
    );
  }

  async listChoices(userEmail: string): Promise<AgentChoice[]> {
    // A branch that cannot be opened is a failed listing, not "no agents": the
    // consent step and the key-mint dialog say so instead of offering
    // Everything as though nothing else existed.
    const located = await this.openDefaultBranch();
    const found = await this.disk.walkFiles(located.kbRoot, (name) => name.endsWith(AGENT_FILE_EXTENSION));
    const candidates = found.map((p) => p.split(path.sep).join('/'));
    if (candidates.length === 0) return [];
    const readable = await this.accessControl.canReadBatch(located.wsId, userEmail, candidates);
    const choices: AgentChoice[] = [];
    for (const rel of candidates) {
      // Fail closed, as every catalog does: only an explicit `true` is readable.
      if (readable.get(rel) !== true) continue;
      const read = await this.readFrom(located.wsId, rel);
      if (read?.kind !== 'ok') continue;
      choices.push({ path: rel, name: read.definition.name, description: read.definition.description });
    }
    return choices.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }

  async choosable(userEmail: string, agentPath: string): Promise<string | null> {
    const rel = normalizeEntryPath(agentPath);
    if (rel === null || !rel.endsWith(AGENT_FILE_EXTENSION)) return null;
    const read = await this.readAgent(userEmail, rel);
    return read?.kind === 'ok' ? rel : null;
  }

  /**
   * The file at `rel` on the default branch, when `userEmail` may read it —
   * null when they may not OR it is not there: the two are one answer.
   */
  private async readAgent(userEmail: string, rel: string): Promise<AgentRead | null> {
    const located = await this.defaultCheckout();
    if (!located) return null;
    const readable = await this.accessControl.canReadBatch(located.wsId, userEmail, [rel]);
    if (readable.get(rel) !== true) return null;
    return this.readFrom(located.wsId, rel);
  }

  private async readFrom(wsId: string, rel: string): Promise<AgentRead | null> {
    let content: string;
    try {
      content = await this.workspaceService.readFile(wsId, `${this.kb.kbDirName}/${rel}`);
    } catch {
      return null;
    }
    const digest = createHash('sha256').update(content).digest('hex');
    try {
      return { kind: 'ok', definition: parseAgentFile(content, rel), digest };
    } catch (err) {
      if (err instanceof AgentFileError) return { kind: 'invalid', reason: err.message, digest };
      throw err;
    }
  }

  /** The default branch's clone; rejects when it cannot be had. */
  private async openDefaultBranch(): Promise<{ wsId: string; kbRoot: string }> {
    const wsId = (await this.workspaceService.getOrCreateForBranch(this.kb.defaultBranch)).id;
    const kbRoot = path.join(await this.workspaceService.getWorkspacePath(wsId), this.kb.kbDirName);
    return { wsId, kbRoot };
  }

  /**
   * The default branch's clone, or null when it cannot be had — which reading
   * one chosen file takes as "not there", so its connection loads nothing.
   */
  private async defaultCheckout(): Promise<{ wsId: string; kbRoot: string } | null> {
    try {
      return await this.openDefaultBranch();
    } catch (err) {
      log.warn('the default branch could not be opened to read agent files:', { err });
      return null;
    }
  }
}

type AgentRead =
  | { kind: 'ok'; definition: AgentFileDefinition; digest: string }
  | { kind: 'invalid'; reason: string; digest: string };

import {
  PLUGINS_DIR,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
  DEFAULT_BRANCH,
  pluginOfPath,
  type ChangeRequest,
  type IWorkflowService,
} from '@bevel-software/platform-shared';
import { type WorkspaceService } from '../workspace/workspace.service.js';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { readAt, visibleProposedFiles } from '../../shared/pending-proposals.js';
import { baseName, normalizeToolManual } from './tool-manuals.service.js';
import { descriptorsFromMcpJson } from './mcp-json-discovery.js';
import type {
  IPendingToolService,
  IToolManualService,
  PendingTool,
  ToolManualDescriptor,
} from './tool-manuals.contract.js';

/**
 * Tools that exist only on an open change request — proposed, not released.
 *
 * The exact counterpart of `PendingSkillsService`, and for the same bug: the
 * catalog is built from the DEFAULT branch, so a tool an agent proposes is
 * nowhere in the product until somebody merges it — not for the author, who
 * asked for it, and not for the person who has to approve it. A card here is a
 * REVIEW surface and nothing more: nothing registers it, nothing calls it, and
 * the library refuses to open it as a tool page.
 *
 * Two declaration surfaces produce a tool, so both produce a proposal:
 *  - a `.tool` UTCP manual anywhere under the plugins root;
 *  - a server added to a plugin's `mcp.json` (the authoritative location for
 *    MCP servers).
 *
 * ADDITIONS ONLY. "Added" is judged by the catalog's own identity, the UTCP
 * manual NAME: a declaration whose name the default branch already serves is an
 * EDIT of a live tool, and that already has a home — the tool's own page, which
 * lists the change requests against its file. Showing it here too would put a
 * second, ghost card beside every tool under review.
 *
 * Who may see a proposal, and how it is read at its own branch, is
 * `shared/pending-proposals.ts` — one answer for skills and tools alike.
 */
export class PendingToolsService implements IPendingToolService {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly accessControl: IAccessControl,
    private readonly toolManuals: Pick<IToolManualService, 'listAllSummaries'>,
    private readonly workflow: IWorkflowService,
  ) {}

  async listPendingTools(userEmail: string): Promise<PendingTool[]> {
    // The released set, UNFILTERED by the caller's read access — the same
    // reasoning as the skill surface: a tool someone else can read and this
    // caller cannot is still released, and counting it as pending would invent
    // a review that is not happening.
    let released: Set<string>;
    try {
      released = new Set((await this.toolManuals.listAllSummaries()).map((s) => s.name));
    } catch {
      return [];
    }

    const proposed = await visibleProposedFiles(
      {
        workspaceService: this.workspaceService,
        accessControl: this.accessControl,
        workflow: this.workflow,
      },
      userEmail,
      isToolDeclaration,
    );

    const out: PendingTool[] = [];
    for (const { cr, path, content, isAuthor } of proposed) {
      for (const descriptor of await this.declarationsIn(cr, path, content)) {
        if (released.has(descriptor.name)) continue;
        out.push({
          slug: descriptor.slug,
          name: descriptor.name,
          path: descriptor.path,
          type: descriptor.type,
          ...(descriptor.description ? { description: descriptor.description } : {}),
          plugin: pluginOfPath(descriptor.path),
          changeRequestNumber: cr.number,
          branch: cr.branch,
          authorName: cr.appAuthor?.name ?? cr.author.name ?? 'Someone',
          createdAt: cr.createdAt,
          isAuthor,
        });
      }
    }
    // Oldest first, and by name within one request — the request that has been
    // waiting longest is the one that needs answering, and a list that reorders
    // as requests arrive moves under the pointer.
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
  }

  /**
   * The tools one proposed file declares, parsed exactly as the catalog scanner
   * would parse it — a `.tool` is one manual, an `mcp.json` is a manual per
   * server. A file that does not parse declares nothing: a malformed `.tool` is
   * skipped by the catalog too, and a card for something that will never load
   * is worse than no card.
   */
  private async declarationsIn(
    cr: ChangeRequest,
    path: string,
    content: string,
  ): Promise<ToolManualDescriptor[]> {
    if (!isMcpJson(path)) {
      try {
        return [normalizeToolManual(baseName(path), path, content)];
      } catch {
        return [];
      }
    }
    // The plugin's own manifest carries what the portable `mcp.json` may not:
    // the descriptions and the `local: true` that exempts a localhost server
    // from the reachability gate. Read at the same branch, best-effort — a
    // missing manifest costs a sentence, not the card. No separate access
    // check: this caller already passed the write gate on the `mcp.json`
    // beside it, which is the plugin folder's own verdict.
    const pluginFolder = path.slice(`${PLUGINS_DIR}/`.length, -(PLUGIN_MCP_FILE.length + 1));
    const manifest = await readAt(
      this.workspaceService,
      workspaceIdForBranch(DEFAULT_BRANCH),
      cr.branch,
      `${PLUGINS_DIR}/${pluginFolder}/${PLUGIN_MANIFEST_FILE}`,
    );
    return descriptorsFromMcpJson(pluginFolder, content, manifest);
  }
}

/** `Plugins/<…>/mcp.json` — a plugin's MCP server declarations. */
function isMcpJson(repoRelPath: string): boolean {
  const segments = repoRelPath.split('/');
  return (
    segments[0] === PLUGINS_DIR &&
    segments.length >= 3 &&
    segments[segments.length - 1] === PLUGIN_MCP_FILE
  );
}

/**
 * Is this touched path something the tool catalog would read?
 *
 * A `.tool` anywhere under the plugins root — including one loose at the root,
 * which the catalog scanner picks up and which therefore has to be reviewable —
 * or a plugin's `mcp.json`. `Plugins/mcp.json` is not one: there is no plugin
 * there for its servers to belong to.
 */
function isToolDeclaration(repoRelPath: string): boolean {
  const segments = repoRelPath.split('/');
  if (segments[0] !== PLUGINS_DIR || segments.length < 2) return false;
  const last = segments[segments.length - 1] ?? '';
  // Case-insensitive, matching the catalog's own walk.
  if (last.toLowerCase().endsWith('.tool')) return true;
  return isMcpJson(repoRelPath);
}

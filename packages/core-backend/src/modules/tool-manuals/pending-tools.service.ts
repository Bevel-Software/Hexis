import {
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
  pluginOfPath,
  type ChangeRequest,
  type IWorkflowService,
  type KbLayout,
} from '@bevel-software/platform-shared';
import { type WorkspaceService } from '../workspace/workspace.service.js';
import type { KbContext } from '../../shared/kb-context.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { readAt, visibleProposedFiles } from '../../shared/pending-proposals.js';
import { utcpNamespacePrefix } from '../../shared/utcp-namespace.js';
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
 * NAMESPACE the manual name resolves to: a declaration whose namespace the
 * default branch already serves is an EDIT of a live tool, and that already has
 * a home — the tool's own page, which lists the change requests against its
 * file. Showing it here too would put a second, ghost card beside every tool
 * under review. The namespace rather than the raw name because that is the
 * identity `scanDisk` dedups by, and the two are not the same function: an
 * `mcp.json` server key may carry a `-`, which namespaces to the same `__` as a
 * `.tool` id's `_`, so `a-b` and `a_b` are one tool as far as the catalog (and
 * its secret vault) is concerned.
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
    private readonly kb: KbContext,
  ) {}

  async listPendingTools(userEmail: string): Promise<PendingTool[]> {
    // The released set, UNFILTERED by the caller's read access — the same
    // reasoning as the skill surface: a tool someone else can read and this
    // caller cannot is still released, and counting it as pending would invent
    // a review that is not happening.
    let released: Set<string>;
    try {
      released = new Set(
        (await this.toolManuals.listAllSummaries()).map((s) => utcpNamespacePrefix(s.name)),
      );
    } catch {
      return [];
    }

    const layout = this.kb.layout;
    const proposed = await visibleProposedFiles(
      {
        workspaceService: this.workspaceService,
        accessControl: this.accessControl,
        workflow: this.workflow,
        kb: this.kb,
      },
      userEmail,
      (p) => isToolDeclaration(p, layout),
    );

    const out: PendingTool[] = [];
    for (const { cr, path, content, isAuthor } of proposed) {
      for (const descriptor of await this.declarationsIn(cr, path, content, layout)) {
        if (released.has(utcpNamespacePrefix(descriptor.name))) continue;
        out.push({
          slug: descriptor.slug,
          name: descriptor.name,
          path: descriptor.path,
          type: descriptor.type,
          ...(descriptor.description ? { description: descriptor.description } : {}),
          plugin: pluginOfPath(descriptor.path, layout),
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
    layout: KbLayout,
  ): Promise<ToolManualDescriptor[]> {
    if (!isMcpJson(path, layout)) {
      let descriptor: ToolManualDescriptor;
      try {
        descriptor = normalizeToolManual(baseName(path), path, content);
      } catch {
        return [];
      }
      // The filename is only the PROVISIONAL slug the parser needs when the
      // frontmatter names nothing; the catalog overwrites it with the resolved
      // manual name and serves that as the route (`scanDisk`). Do the same here
      // or the two disagree the moment a `.tool` declares its own `id`, or the
      // moment a filename is not route-safe to begin with (`My Weather.tool`).
      descriptor.slug = descriptor.name;
      return [descriptor];
    }
    // The plugin's own manifest carries what the portable `mcp.json` may not:
    // the descriptions and the `local: true` that exempts a localhost server
    // from the reachability gate. Read at the same branch, best-effort — a
    // missing manifest costs a sentence, not the card. No separate access
    // check: this caller already passed the write gate on the `mcp.json`
    // beside it, which is the plugin folder's own verdict.
    const pluginFolder = path.slice(`${layout.pluginsDir}/`.length, -(PLUGIN_MCP_FILE.length + 1));
    const manifest = await readAt(
      this.workspaceService,
      this.kb.defaultWorkspaceId(),
      cr.branch,
      `${layout.pluginsDir}/${pluginFolder}/${PLUGIN_MANIFEST_FILE}`,
    );
    return descriptorsFromMcpJson(pluginFolder, content, manifest, layout);
  }
}

/** `Plugins/<…>/mcp.json` — a plugin's MCP server declarations. */
function isMcpJson(repoRelPath: string, layout: KbLayout): boolean {
  const segments = repoRelPath.split('/');
  return (
    segments[0] === layout.pluginsDir &&
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
function isToolDeclaration(repoRelPath: string, layout: KbLayout): boolean {
  const segments = repoRelPath.split('/');
  if (segments[0] !== layout.pluginsDir || segments.length < 2) return false;
  const last = segments[segments.length - 1] ?? '';
  // Case-insensitive, matching the catalog's own walk.
  if (last.toLowerCase().endsWith('.tool')) return true;
  return isMcpJson(repoRelPath, layout);
}

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_BRANCH,
  HEXIS_EXTENSION_NS,
  PLUGINS_DIR,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
  type AuthUser,
} from '@bevel-software/platform-shared';
import { workspaceIdForBranch, type WorkspaceService } from '../workspace/workspace.service.js';
import { assertSafeFetchUrl } from '../../shared/ssrf.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import type { IToolManualService, ToolVariable } from './tool-manuals.contract.js';

/**
 * Server-scoped editing of one MCP server — the form the tool page uses
 * instead of dropping a writer into raw `mcp.json`.
 *
 * One server's truth spans TWO files (the spec's split, not ours): the
 * portable half in `mcp.json` (transport, url, literal headers) and our half
 * in `plugin.json`'s `extensions["software.bevel.hexis"].mcpServers[<name>]`
 * (auth headers carrying `${VAR}` vault references, variable declarations,
 * description, `local`). This service is the ONE writer that keeps the two in
 * step: a save rewrites both entries and commits them together, because a
 * server whose auth landed without its url — or the reverse — is a broken
 * tool with no author to blame.
 *
 * RENAME IS DESTRUCTIVE BY DESIGN and the route says so: the `mcpServers` key
 * is the namespace vault secrets bind to (`<name>_<VAR>`), so renaming a
 * server orphans every configured secret and completed sign-in under the old
 * key. The frontend counts what disconnects (it already holds per-variable
 * status) and confirms; this service just refuses a rename onto a taken key.
 */

export type McpTransport = 'streamable-http' | 'sse' | 'stdio';

export interface McpServerView {
  name: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Portable headers, stored in mcp.json. Never carry a `${VAR}`. */
  literalHeaders: Record<string, string>;
  /** Auth headers with vault references, stored in the extensions block. */
  authHeaders: Record<string, string>;
  variables: ToolVariable[];
  description?: string;
  local: boolean;
  canWrite: boolean;
}

export interface McpServerWrite {
  newName?: string;
  transport: McpTransport;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  literalHeaders?: Record<string, string>;
  authHeaders?: Record<string, string>;
  variables?: ToolVariable[];
  description?: string;
  local?: boolean;
}

export class McpServerEditError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'McpServerEditError';
  }
}

/** Same shape the discovery accepts: the key is a namespace, not prose. */
const SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

const hasVarRef = (v: string): boolean => /\$\{[^}]+\}/.test(v);

/**
 * The same reserved-reference policy discovery enforces, applied at SAVE: a
 * `${…API_URL}`/`${…CONNECTION_KEY}` persisted here would make discovery drop
 * the server on its next scan — an editor that can save self-invalidating
 * config is worse than a 422 naming the reference.
 */
function findReservedRef(doc: unknown): string | null {
  const text = JSON.stringify(doc) ?? '';
  for (const match of text.matchAll(/\$\{\s*([A-Za-z0-9_]+)\s*\}|\$([A-Za-z0-9_]+)/g)) {
    const varName = match[1] ?? match[2] ?? '';
    if (varName.endsWith('API_URL') || varName.endsWith('CONNECTION_KEY')) return match[0];
  }
  return null;
}

interface CommitDriver {
  runPendingCommit(
    workspaceId: string,
    branch: string,
    targetPath: string,
    user: AuthUser,
    opts?: { systemAuthorized?: boolean },
  ): Promise<void>;
}

export class McpServerEditService {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly commits: CommitDriver,
    private readonly accessControl: IAccessControl,
    private readonly toolManuals: IToolManualService,
    private readonly kbDirName: string,
  ) {}

  /** The merged view of one server, or null when unknown/unreadable (indistinguishable, fail closed). */
  async getServer(userEmail: string, slug: string): Promise<McpServerView | null> {
    const located = await this.locate(userEmail, slug);
    if (!located) return null;
    const { folder, name, wsId, mcpJsonPath } = located;
    const { mcp, manifest } = await this.readFiles(folder);
    const entry = (mcp?.mcpServers as Record<string, unknown> | undefined)?.[name];
    if (!entry || typeof entry !== 'object') return null;
    const raw = entry as Record<string, unknown>;
    const ext = this.extensionEntry(manifest, name);
    return {
      name,
      transport: (raw.type as McpTransport) ?? 'streamable-http',
      ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
      ...(typeof raw.command === 'string' ? { command: raw.command } : {}),
      ...(Array.isArray(raw.args) ? { args: raw.args.map(String) } : {}),
      ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
      ...(raw.env && typeof raw.env === 'object' ? { env: raw.env as Record<string, string> } : {}),
      literalHeaders: (raw.headers as Record<string, string>) ?? {},
      authHeaders: (ext.headers as Record<string, string>) ?? {},
      variables: (ext.variables as ToolVariable[]) ?? [],
      ...(typeof ext.description === 'string' ? { description: ext.description } : {}),
      local: ext.local === true || raw.type === 'stdio',
      canWrite: await this.accessControl.canWrite(wsId, userEmail, mcpJsonPath),
    };
  }

  /** Rewrite one server across both files, in one commit. Returns the (possibly new) name. */
  async putServer(user: AuthUser, slug: string, write: McpServerWrite): Promise<{ name: string }> {
    const located = await this.locate(user.email, slug);
    if (!located) throw new McpServerEditError('No such tool.', 404);
    const { folder, name, wsId, mcpJsonPath } = located;
    if (!(await this.accessControl.canWrite(wsId, user.email, mcpJsonPath))) {
      throw new McpServerEditError("You don't have permission to edit this plugin's servers.", 403);
    }
    const { mcp, manifest, mcpAbs, manifestAbs } = await this.readFiles(folder);
    if (!mcp?.mcpServers || typeof mcp.mcpServers !== 'object') {
      throw new McpServerEditError(`${PLUGIN_MCP_FILE} is missing or unparsable — fix the file first.`, 422);
    }
    const servers = mcp.mcpServers as Record<string, unknown>;
    if (!(name in servers)) throw new McpServerEditError('No such server.', 404);

    if (write.transport !== 'streamable-http' && write.transport !== 'sse' && write.transport !== 'stdio') {
      // Persisting an unknown transport would save an entry discovery then
      // refuses — an unusable server with no error at the moment it was made.
      throw new McpServerEditError(`Unknown transport "${String(write.transport)}".`, 422);
    }
    // The WHOLE writable surface, mirroring what discovery scans: a reserved
    // ref smuggled through a stdio arg (`--url=${X_API_URL}`), env value, cwd
    // or description would save with a 200 and then vanish from the catalog
    // on the next scan — the exact self-invalidating state this 422 prevents.
    const reservedRef = findReservedRef({
      url: write.url,
      command: write.command,
      args: write.args,
      env: write.env,
      cwd: write.cwd,
      description: write.description,
      literalHeaders: write.literalHeaders,
      authHeaders: write.authHeaders,
      variables: write.variables,
    });
    if (reservedRef !== null) {
      throw new McpServerEditError(
        `"${reservedRef}" references a platform-seeded variable (API_URL / CONNECTION_KEY) — ` +
          'discovery refuses servers that name them, so this cannot be saved.',
        422,
      );
    }
    const target = write.newName?.trim() || name;
    if (!SERVER_NAME_RE.test(target)) {
      throw new McpServerEditError(
        'A server name is its secret namespace: lowercase alphanumeric with `_`/`-`.',
        422,
      );
    }
    if (target !== name && target in servers) {
      throw new McpServerEditError(`A server named "${target}" already exists here.`, 409);
    }

    // Defense in depth on the portable file: a `${VAR}` in mcp.json would be
    // transmitted literally by a conformant client AND violate the spec's
    // no-credentials rule — reroute it to the extensions block instead of
    // trusting the frontend's split.
    const literal: Record<string, string> = {};
    const auth: Record<string, string> = { ...(write.authHeaders ?? {}) };
    for (const [k, v] of Object.entries(write.literalHeaders ?? {})) {
      if (hasVarRef(v)) auth[k] = v;
      else literal[k] = v;
    }

    let entry: Record<string, unknown>;
    if (write.transport === 'stdio') {
      const command = write.command?.trim();
      if (!command) throw new McpServerEditError('A stdio server needs a command.', 422);
      entry = {
        type: 'stdio',
        command,
        ...(write.args && write.args.length > 0 ? { args: write.args } : {}),
        ...(write.env && Object.keys(write.env).length > 0 ? { env: write.env } : {}),
        ...(write.cwd ? { cwd: write.cwd } : {}),
      };
    } else {
      let parsed: URL;
      try {
        parsed = new URL(write.url ?? '');
      } catch {
        throw new McpServerEditError('The server needs a valid http(s) URL.', 422);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new McpServerEditError('The server needs a valid http(s) URL.', 422);
      }
      // The same SSRF gate discovery applies on read: without it here, a save
      // succeeds and the server then silently disappears from the catalog —
      // an edit flow that eats its own output. Local-only servers are exempt;
      // loopback is what local means.
      if (write.local !== true) {
        try {
          assertSafeFetchUrl(write.url ?? '', { label: 'Server URL' });
        } catch (err) {
          throw new McpServerEditError(
            `${err instanceof Error ? err.message : 'The URL is not reachable from the workspace'} — ` +
              'mark the server local-only if it is deliberately private.',
            422,
          );
        }
      }
      entry = {
        type: write.transport,
        url: write.url,
        ...(Object.keys(literal).length > 0 ? { headers: literal } : {}),
      };
    }

    if (target !== name) delete servers[name];
    servers[target] = entry;

    // The extensions half: rewrite our entry, drop the old key on rename.
    // A missing/unparsable manifest refuses the save when there is auth to
    // store — silently dropping a credential mapping is worse than an error.
    const extEntry = {
      ...(Object.keys(auth).length > 0 ? { headers: auth } : {}),
      ...(write.variables && write.variables.length > 0 ? { variables: write.variables } : {}),
      ...(write.description ? { description: write.description } : {}),
      ...(write.local === true && write.transport !== 'stdio' ? { local: true } : {}),
    };
    if (manifest === null && Object.keys(extEntry).length > 0) {
      throw new McpServerEditError(`${PLUGIN_MANIFEST_FILE} is missing or unparsable — fix the file first.`, 422);
    }
    if (manifest !== null) {
      // A wrong-TYPED extensions chain (a string, an array) would throw a
      // TypeError below and surface as a 500. It is also not ours to silently
      // replace: an array `extensions` may be another tool's data, malformed
      // or not, and a save aimed at one server should not discard it.
      const badShape = (v: unknown): boolean => v !== undefined && (typeof v !== 'object' || v === null || Array.isArray(v));
      const ext = (manifest.extensions ??= {}) as Record<string, unknown>;
      if (badShape(manifest.extensions)) {
        throw new McpServerEditError(`${PLUGIN_MANIFEST_FILE} has a malformed \`extensions\` block — fix the file first.`, 422);
      }
      if (badShape(ext[HEXIS_EXTENSION_NS]) || badShape((ext[HEXIS_EXTENSION_NS] as Record<string, unknown> | undefined)?.mcpServers)) {
        throw new McpServerEditError(`${PLUGIN_MANIFEST_FILE} has a malformed \`extensions\` block — fix the file first.`, 422);
      }
      const ns = (ext[HEXIS_EXTENSION_NS] ??= {}) as Record<string, unknown>;
      const extServers = (ns.mcpServers ??= {}) as Record<string, unknown>;
      delete extServers[name];
      if (Object.keys(extEntry).length > 0) extServers[target] = extEntry;
    }

    // All-or-nothing for real: snapshot both files first, and on ANY failure
    // past the first write put the originals back — the API reporting failure
    // while the workspace keeps half the edit is the state this exists to
    // prevent.
    // Rollback scope is the WRITES only. A failed write restores both files
    // (a half-written pair is the state this exists to prevent); a failed
    // COMMIT must not — the pending-commit pipeline may already have created
    // a local commit before the push refused, and rewriting the working tree
    // to pre-edit bytes would leave it dirty AGAINST that commit, a state the
    // workflow layer's own pull-rebase recovery then misreads. Commit-stage
    // failures propagate as-is and the pipeline's recovery owns the cleanup.
    const [mcpBefore, manifestBefore] = await Promise.all([
      fs.readFile(mcpAbs, 'utf8').catch(() => null),
      fs.readFile(manifestAbs, 'utf8').catch(() => null),
    ]);
    try {
      await fs.writeFile(mcpAbs, `${JSON.stringify(mcp, null, 2)}\n`, 'utf8');
      if (manifest !== null) {
        await fs.writeFile(manifestAbs, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      }
    } catch (err) {
      if (mcpBefore !== null) await fs.writeFile(mcpAbs, mcpBefore, 'utf8').catch(() => {});
      if (manifestBefore !== null) await fs.writeFile(manifestAbs, manifestBefore, 'utf8').catch(() => {});
      throw err;
    }
    // One folder-scoped commit, ungated beyond the caller's own write access —
    // both files or neither. The catalog cache is stale the moment it lands.
    await this.commits.runPendingCommit(
      workspaceIdForBranch(DEFAULT_BRANCH),
      DEFAULT_BRANCH,
      `${this.kbDirName}/${PLUGINS_DIR}/${folder}`,
      user,
    );
    this.toolManuals.invalidate();
    return { name: target };
  }

  /** Resolve a slug to an mcp.json-backed server the caller can READ; null otherwise. */
  private async locate(
    userEmail: string,
    slug: string,
  ): Promise<{ folder: string; name: string; wsId: string; mcpJsonPath: string } | null> {
    const summaries = await this.toolManuals.listAccessible(userEmail);
    const found = summaries.find((s) => s.slug === slug);
    if (!found || found.type !== 'mcp' || !found.path.endsWith(`/${PLUGIN_MCP_FILE}`)) return null;
    const segments = found.path.split('/');
    const folder = segments[1];
    if (!folder) return null;
    return {
      folder,
      name: found.name,
      wsId: workspaceIdForBranch(DEFAULT_BRANCH),
      mcpJsonPath: found.path,
    };
  }

  private async readFiles(folder: string): Promise<{
    mcp: Record<string, unknown> | null;
    manifest: Record<string, unknown> | null;
    mcpAbs: string;
    manifestAbs: string;
  }> {
    const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
    await this.workspaceService.getOrCreateForBranch(DEFAULT_BRANCH);
    const wsDir = await this.workspaceService.getWorkspacePath(wsId);
    const pluginDir = path.join(wsDir, this.kbDirName, PLUGINS_DIR, folder);
    const mcpAbs = path.join(pluginDir, PLUGIN_MCP_FILE);
    const manifestAbs = path.join(pluginDir, PLUGIN_MANIFEST_FILE);
    return {
      mcp: await readJson(mcpAbs),
      manifest: await readJson(manifestAbs),
      mcpAbs,
      manifestAbs,
    };
  }

  private extensionEntry(manifest: Record<string, unknown> | null, name: string): Record<string, unknown> {
    const ns = (manifest?.extensions as Record<string, unknown> | undefined)?.[HEXIS_EXTENSION_NS];
    const servers = (ns as Record<string, unknown> | undefined)?.mcpServers;
    const entry = (servers as Record<string, unknown> | undefined)?.[name];
    return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
  }
}

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(p, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

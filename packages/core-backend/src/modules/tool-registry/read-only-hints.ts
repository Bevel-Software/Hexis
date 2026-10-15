import express, { type Request, type RequestHandler } from 'express';
import { META_TOOL_NAMES, META_TOOL_READ_ONLY, READ_ONLY_TAG } from '@bevel-software/platform-mcp-core';
import type { IToolRegistry, UtcpTool } from './tool.contract.js';
import type { IAdminAccessService } from '../admin/admin.interface.js';
import {
  parseToolReadOnlyOverrides,
  type DeploymentSettingsService,
} from '../settings/deployment-settings.service.js';
import { logger } from '../../shared/logging.js';
import '../auth/auth.middleware.js'; // Express Request augmentation (req.userId, req.userEmail)

const log = logger('tool-read-only-hints');

/** The deployment setting the overrides live in — see `CORE_SETTINGS`. */
export const TOOL_READ_ONLY_SETTING = 'toolReadOnlyOverrides';

/**
 * What MCP clients are told about each platform tool's effect.
 *
 * Every platform tool declares whether it writes (the `write` tag `toolDef`
 * puts on it), and that declaration is its BUILT-IN read-only hint: a tool
 * that declares no write only reads. The same declaration already decides
 * branch handling and the write gate, so a tool cannot be a reader there and
 * a writer here. The code-mode meta-tools are not in the manual, so theirs is
 * `META_TOOL_READ_ONLY`.
 *
 * An admin may override either kind per deployment, in either direction, from
 * the Tools page. The override is the `toolReadOnlyOverrides` deployment
 * setting, read from the database on every use — so a change made on one
 * replica is in the next listing of every other, without a restart.
 *
 * Carried to the two MCP servers in two ways, both from here: the hosted
 * endpoint reads the `read-only` tag this puts on each tool of the agent
 * manual (`GET /agent/utcp`), and the local `hexis-mcp` — whose discovery goes
 * through the MCP endpoint, where tags do not survive — reads
 * `GET /agent/tool-hints`. Tools from the knowledge base (`.tool` manuals,
 * plugin MCP servers) are not the registry's and are untouched.
 */
export interface ToolReadOnlyEntry {
  name: string;
  /** `platform`: an endpoint of this deployment. `meta`: a feature of the MCP servers. */
  kind: 'platform' | 'meta';
  /** What the tool's own declaration makes it. */
  builtIn: boolean;
  /** The admin's override, or null when there is none. */
  override: boolean | null;
  /** What clients are told: the override when set, else the built-in value. */
  readOnly: boolean;
}

type SettingsPort = Pick<DeploymentSettingsService, 'reload' | 'recordIfAbsent' | 'swapIfValue'>;

/** A name that is neither a platform tool nor a meta-tool. */
export class UnknownToolError extends Error {
  constructor(readonly toolName: string) {
    super(`"${toolName}" is not a platform tool or a code-mode meta-tool of this deployment.`);
    this.name = 'UnknownToolError';
  }
}

function declaresWrite(tool: Pick<UtcpTool, 'tags'>): boolean {
  return (tool.tags ?? []).includes('write');
}

export class ToolReadOnlyHints {
  constructor(
    private readonly registry: Pick<IToolRegistry, 'listExternal'>,
    private readonly settings: SettingsPort,
  ) {}

  /** The overrides in effect, as the database has them now. An unreadable value is no override. */
  async overrides(): Promise<Record<string, boolean>> {
    const raw = await this.settings.reload(TOOL_READ_ONLY_SETTING);
    const parsed = parseToolReadOnlyOverrides(raw);
    if (parsed === null) {
      log.warn(`the stored ${TOOL_READ_ONLY_SETTING} is not a map of tool names to booleans — ignoring it.`);
      return {};
    }
    return parsed;
  }

  /**
   * The agent manual's tools, each tagged `read-only` exactly when its
   * effective hint is true. New objects: the registry's own defs are shared
   * by every request and are never written to.
   */
  async apply(tools: UtcpTool[]): Promise<UtcpTool[]> {
    // An override that cannot be read must not cost clients the manual: the
    // tools go out on their built-in hints, as on a deployment with none.
    let overrides: Record<string, boolean> = {};
    try {
      overrides = await this.overrides();
    } catch (err) {
      log.warn(`could not read ${TOOL_READ_ONLY_SETTING}; listing the built-in hints:`, { err });
    }
    return tools.map((tool) => {
      const override = Object.hasOwn(overrides, tool.name) ? overrides[tool.name] : undefined;
      const readOnly = override ?? !declaresWrite(tool);
      const tags = (tool.tags ?? []).filter((t) => t !== READ_ONLY_TAG);
      return { ...tool, tags: readOnly ? [...tags, READ_ONLY_TAG] : tags };
    });
  }

  /** Every platform tool, then every meta-tool, with its built-in, override and effective value. */
  async describe(): Promise<ToolReadOnlyEntry[]> {
    const [tools, overrides] = await Promise.all([this.registry.listExternal({}), this.overrides()]);
    const entry = (name: string, kind: ToolReadOnlyEntry['kind'], builtIn: boolean): ToolReadOnlyEntry => {
      const override = Object.hasOwn(overrides, name) ? overrides[name]! : null;
      return { name, kind, builtIn, override, readOnly: override ?? builtIn };
    };
    const seen = new Set<string>();
    const platform: ToolReadOnlyEntry[] = [];
    for (const tool of tools) {
      // A registry copy of a meta-tool's name is never listed as itself; the
      // meta-tool below is what that name means to a client.
      if (META_TOOL_NAMES.has(tool.name) || seen.has(tool.name)) continue;
      seen.add(tool.name);
      platform.push(entry(tool.name, 'platform', !declaresWrite(tool)));
    }
    const meta = [...META_TOOL_NAMES].map((name) => entry(name, 'meta', META_TOOL_READ_ONLY[name] === true));
    return [...platform, ...meta];
  }

  /** Every tool's effective hint, by name — what `hexis-mcp` lists. */
  async hints(): Promise<Record<string, boolean>> {
    return Object.fromEntries((await this.describe()).map((e) => [e.name, e.readOnly]));
  }

  /**
   * Set one tool's override, or remove it (`null`), and answer the tool as it
   * now stands. A compare-and-swap on the stored map, retried, so two admins
   * saving different tools at once both land.
   *
   * `updatedBy` is the admin's USER ID, never their email: it lands in
   * `deployment_settings.updated_by`, a uuid referencing `users.id`, and
   * anything else is refused by the database.
   */
  async set(name: string, readOnly: boolean | null, updatedBy: string | null): Promise<ToolReadOnlyEntry> {
    const known = (await this.describe()).find((e) => e.name === name);
    if (!known) throw new UnknownToolError(name);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.settings.reload(TOOL_READ_ONLY_SETTING);
      // Own properties throughout, so a name like `__proto__` is stored as itself.
      const map = Object.fromEntries(
        Object.entries(parseToolReadOnlyOverrides(current) ?? {}).filter(([key]) => key !== name),
      );
      if (readOnly !== null) Object.defineProperty(map, name, { value: readOnly, enumerable: true, writable: true, configurable: true });
      const next = Object.keys(map).length ? JSON.stringify(map) : null;
      const done = !current
        ? next === null || (await this.settings.recordIfAbsent(TOOL_READ_ONLY_SETTING, next, updatedBy))
        : next === current || (await this.settings.swapIfValue(TOOL_READ_ONLY_SETTING, current, next, updatedBy));
      if (done) {
        const override = readOnly;
        return { ...known, override, readOnly: override ?? known.builtIn };
      }
    }
    throw new Error('The read-only override kept changing under this save; try again.');
  }
}

/**
 * The routes over {@link ToolReadOnlyHints}:
 *
 *   GET /agent/tool-hints     — every tool's effective hint, for `hexis-mcp`
 *                               (behind `manualAuth`, like the manual itself)
 *   GET /tool-hints           — every tool with its built-in, override and
 *                               effective value, for the Tools page; any
 *                               signed-in person, plus whether they may edit
 *   PUT /tool-hints/:name     — `{ readOnly: true | false | null }`, admins only;
 *                               null removes the override
 *
 * The agent route is returned separately so it can mount on the tools router,
 * ahead of the JWT `/api` mounts; the other two mount behind `authMiddleware`.
 */
export function createToolHintsAgentRoutes(hints: ToolReadOnlyHints, manualAuth: RequestHandler): express.Router {
  const router = express.Router();
  router.get('/agent/tool-hints', manualAuth, async (_req, res) => {
    try {
      res.json({ tools: await hints.hints() });
    } catch (err) {
      log.error('tool-hints failed:', { err });
      res.status(500).json({ error: 'Failed to read the tool hints' });
    }
  });
  return router;
}

export function createToolHintsRoutes(
  hints: ToolReadOnlyHints,
  adminAccess: Pick<IAdminAccessService, 'isAdmin'>,
): express.Router {
  const router = express.Router();

  router.get('/tool-hints', async (req: Request, res) => {
    try {
      const [tools, canEdit] = await Promise.all([hints.describe(), adminAccess.isAdmin(req.userEmail)]);
      res.json({ canEdit, tools });
    } catch (err) {
      log.error('tool-hints listing failed:', { err });
      res.status(500).json({ error: 'Failed to read the tool hints' });
    }
  });

  router.put('/tool-hints/:name', express.json(), async (req: Request, res) => {
    if (!(await adminAccess.isAdmin(req.userEmail))) {
      res.status(403).json({ error: 'Only an admin can change what clients are told about a tool.' });
      return;
    }
    const readOnly = (req.body as { readOnly?: unknown } | undefined)?.readOnly;
    if (readOnly !== true && readOnly !== false && readOnly !== null) {
      res.status(400).json({ error: '`readOnly` must be true, false, or null to remove the override.' });
      return;
    }
    try {
      const name = String(req.params.name);
      // The user ID, as the setup routes record it: `updated_by` is a uuid column.
      const entry = await hints.set(name, readOnly, req.userId ?? null);
      log.info(`${req.userEmail ?? 'an admin'} set the read-only hint of "${name}" to ${readOnly === null ? 'its built-in value' : String(readOnly)}`);
      res.json(entry);
    } catch (err) {
      if (err instanceof UnknownToolError) {
        res.status(404).json({ error: err.message });
        return;
      }
      log.error('tool-hints save failed:', { err });
      res.status(500).json({ error: 'Failed to save the override' });
    }
  });

  return router;
}

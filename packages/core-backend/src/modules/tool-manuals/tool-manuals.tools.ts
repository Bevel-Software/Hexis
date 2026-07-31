import type { Router, RequestHandler } from 'express';
import { DEFAULT_BRANCH } from '@bevel-software/shared';
import type { IToolRegistry, UtcpTool } from '../tool-registry/tool.contract.js';
import type { ToolContext } from '../tool-helpers/tool.contract.js';
import { toolDef } from '../tool-helpers/tool-def.js';
import type { ToolHandlerFactory } from '../tool-helpers/tool-handler.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { workspaceIdForBranch } from '../workspace/workspace.service.js';
import { utcpNamespacedKey } from '../../shared/utcp-namespace.js';
import type { IToolManualService } from './tool-manuals.contract.js';

/**
 * What `list_tool_setup` needs from the secrets vault (structurally satisfied
 * by `ISecretsVaultService.statusFor`). A local port keeps this module free of
 * a secrets-vault import — the same decoupling discipline as
 * `McpAuthDiscoveryPort` in the service.
 */
export interface VariableStatusPort {
  statusFor(
    userId: string,
    keys: string[],
  ): Promise<{ key: string; adminConfigured: boolean; userConfigured: boolean; userAuthorized?: boolean }[]>;
}

/**
 * Registers the tool-manual catalog tools (both surfaces) and hosts their
 * endpoints:
 *
 *  - `list_local_tools` — local-only manuals (`remote: false`) the remote proxy
 *    can't serve; the agent reads their `.tool` path and self-configures.
 *  - `list_tool_setup` — configuration status of every accessible manual, so an
 *    agent can EXPLAIN the remaining setup to the admin. Deliberately
 *    read-only: secret VALUES are never set (or returned) through a tool — the
 *    admin pastes them into the tool editor; users sign in on /connect.
 */
export function registerToolManualsTools(
  registry: IToolRegistry,
  router: Router,
  toolAuth: RequestHandler,
  toolHandler: ToolHandlerFactory,
  toolManualService: IToolManualService,
  deps: {
    accessControl: IAccessControl;
    variableStatus: VariableStatusPort;
  },
): void {
  registry.registerExternalTool((ctx) => buildListLocalToolsDef(toolManualService, ctx.userEmail));
  registry.registerInternalTool((ctx) => buildListLocalToolsDef(toolManualService, ctx.userEmail));

  router.post(
    '/agent/tools/list_local_tools',
    toolAuth,
    toolHandler(async (_args, ctx: ToolContext) => ({
      tools: await toolManualService.listLocalOnly(ctx.user.email),
    })),
  );

  const defaultWs = workspaceIdForBranch(DEFAULT_BRANCH);
  const varKey = (manualName: string, varName: string) => utcpNamespacedKey(manualName, varName);

  const listSetupDef = toolDef({
    name: 'list_tool_setup',
    description:
      'Configuration status of every `.tool` the current user can access: what each tool needs set up and ' +
      'what is already configured. Results are scoped to the caller — a `.tool` the caller cannot READ is ' +
      'absent entirely, and all status flags reflect the caller\'s own state. Per tool: `setup` describes ' +
      'an MCP server\'s sign-in requirement (`open` = none; `oauth-auto` = sign-in was configured ' +
      'automatically; `oauth-manual` = the provider does not support automatic registration, so a writer ' +
      'must declare the OAuth provider in the `.tool` file and paste its client secret into the tool ' +
      'editor). Per variable: whether the shared (admin) value is set, whether the CURRENT user has ' +
      'set/authorized their own, and whether it is an OAuth sign-in (users authorize those on the /connect ' +
      'page, never by typing a value). `canWrite` = the caller may write THAT `.tool` FILE (per-file access ' +
      'from its frontmatter `write:`/`owner:` verbs and the access.md chain — NOT a platform role), which ' +
      'is exactly what gates setting its shared secrets: the people who manage the file configure the tool. ' +
      'Secret VALUES are never returned and can never be set through a tool — an admin enters them in the ' +
      'tool editor; users sign in on /connect.',
    path: '/api/agent/tools/list_tool_setup',
    inputs: { type: 'object', properties: {}, required: [], additionalProperties: false },
    outputs: {
      type: 'object',
      properties: {
        tools: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slug: { type: 'string' },
              name: { type: 'string', description: 'The manual id — the namespace secrets bind to.' },
              path: { type: 'string' },
              type: { type: 'string' },
              setup: {
                type: ['object', 'null'],
                description: 'MCP auto-discovery setup requirement; null for non-mcp tools.',
                properties: { kind: { type: 'string' }, reason: { type: 'string' } },
              },
              canWrite: { type: 'boolean' },
              variables: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    scope: { type: 'string', description: '`admin` (one shared value) or `user` (per user).' },
                    label: { type: ['string', 'null'] },
                    oauth: { type: 'boolean', description: 'Filled by signing in on /connect, not by a value.' },
                    adminConfigured: {
                      type: 'boolean',
                      description:
                        'Shared value set (plain admin vars), or the owner finished provider setup (OAuth vars).',
                    },
                    userConfigured: { type: 'boolean' },
                    authorized: { type: ['boolean', 'null'], description: 'OAuth vars: current user signed in.' },
                  },
                  required: ['name', 'scope', 'oauth', 'adminConfigured', 'userConfigured'],
                },
              },
            },
            required: ['slug', 'name', 'path', 'type', 'canWrite', 'variables'],
          },
        },
      },
      required: ['tools'],
    },
    tags: ['tools'],
  });
  registry.registerInternalTool(listSetupDef);
  registry.registerExternalTool(listSetupDef);
  router.post(
    '/agent/tools/list_tool_setup',
    toolAuth,
    toolHandler(async (_args, ctx: ToolContext) => {
      const manuals = await toolManualService.listAccessible(ctx.user.email);
      const allKeys = manuals.flatMap((m) => (m.variables ?? []).map((v) => varKey(m.name, v.name)));
      const status = await deps.variableStatus.statusFor(ctx.user.id, allKeys);
      const statusByKey = new Map(status.map((s) => [s.key, s]));
      const tools = await Promise.all(
        manuals.map(async (m) => ({
          slug: m.slug,
          name: m.name,
          path: m.path,
          type: m.type,
          setup: m.setup ?? null,
          canWrite: await deps.accessControl.canWrite(defaultWs, ctx.user.email, m.path),
          variables: (m.variables ?? []).map((v) => {
            const st = statusByKey.get(varKey(m.name, v.name));
            const isOAuth = v.oauth != null;
            return {
              name: v.name,
              scope: v.scope,
              label: v.label ?? null,
              oauth: isOAuth,
              adminConfigured: st?.adminConfigured ?? false,
              userConfigured: st?.userConfigured ?? false,
              authorized: isOAuth ? (st?.userAuthorized ?? false) : null,
            };
          }),
        })),
      );
      return { tools };
    }),
  );
}

/** "Local-only tools configured for you: `a`, `b`." (or a none note), filtered to what the caller may read. */
async function localToolsLine(svc: IToolManualService, userEmail?: string): Promise<string> {
  if (!userEmail) return 'No local-only tools are currently configured.';
  const tools = await svc.listLocalOnly(userEmail);
  if (tools.length === 0) return 'No local-only tools are currently configured.';
  return `Local-only tools configured for you: ${tools.map((t) => `\`${t.name}\``).join(', ')}.`;
}

async function buildListLocalToolsDef(svc: IToolManualService, userEmail?: string): Promise<UtcpTool> {
  return toolDef({
    name: 'list_local_tools',
    description:
      'List tools your workspace admins configured that run ONLY in a local environment ' +
      '(e.g. a self-hosted MCP server on localhost) and therefore cannot be called through this ' +
      'remote endpoint. Each entry gives the tool’s name and its `.tool` file path in the knowledge ' +
      'base — read that file with `read_file` and configure the tool yourself in your local setup ' +
      '(e.g. add the MCP server to your client). ' +
      (await localToolsLine(svc, userEmail)),
    path: '/api/agent/tools/list_local_tools',
    inputs: { type: 'object', properties: {}, additionalProperties: false },
    outputs: {
      type: 'object',
      properties: {
        tools: {
          type: 'array',
          description: 'Local-only tools (name + KB path).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              path: { type: 'string', description: 'KB path of the `.tool` file (read it with read_file).' },
            },
          },
        },
      },
    },
    tags: ['tools'],
  });
}

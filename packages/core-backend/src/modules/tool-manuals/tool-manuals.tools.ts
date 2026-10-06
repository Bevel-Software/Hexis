import type { Router, RequestHandler } from 'express';
import type { IToolRegistry, UtcpTool } from '../tool-registry/tool.contract.js';
import type { KbContext } from '../../shared/kb-context.js';
import type { ToolContext } from '../tool-helpers/tool.contract.js';
import { toolDef } from '../tool-helpers/tool-def.js';
import type { ToolHandlerFactory } from '../tool-helpers/tool-handler.js';
import type { IAccessControl } from '../access/access-control.interface.js';
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
    /** Which branch tools are served from, and its clone. */
    kb: Pick<KbContext, 'defaultBranch' | 'defaultWorkspaceId'>;
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

  // A FUNCTION, not a constant — this factory runs at boot, and on a
  // setup-screen deployment the branch model is applied AFTER boot. Only a
  // read inside a handler body sees the configured default branch; a
  // construction-time capture would hold the empty pre-setup id until restart.
  const defaultWs = () => deps.kb.defaultWorkspaceId();
  const varKey = (manualName: string, varName: string) => utcpNamespacedKey(manualName, varName);

  const listSetupDef = toolDef({
    name: 'list_tool_setup',
    // What each FIELD means is documented on the field, in `outputs` below:
    // `setup.kind`, `variables` and `invalid` each carried a paragraph here,
    // which made this description two thousand characters and so the first
    // thing a client cut. The description says what the tool answers and the
    // three things an agent cannot read off a field.
    description:
      'Configuration status of every `.tool` the current user can access: what each tool needs set up and what is ' +
      'already configured, as `{ tools, invalid, onBranchOnly, note? }`. Scoped to the CALLER — a `.tool` it cannot ' +
      'READ is absent entirely, and every flag is the caller\'s own state. ' +
      'Secret VALUES are never returned and can never be set through a tool: an admin enters them in the tool editor, ' +
      'and users sign in on /connect rather than typing a value. ' +
      'What gates setting a tool\'s shared secrets is `canWrite` on the `.tool` FILE — per-file access from its ' +
      'frontmatter `write:`/`owner:` verbs and the access.md chain, NOT a platform role: the people who manage the ' +
      'file configure the tool. ' +
      'The listing is the RELEASED catalog, built from the default branch only: a server or `.tool` you declared on a ' +
      'draft is not listed, not callable and not signed-in-able until that draft is merged. Pass `branch` (the draft ' +
      'you wrote the declaration on) and `onBranchOnly` names every tool declared there that the default branch does ' +
      'not serve yet — open a change request and ask the user to merge it in the app to activate it.',
    path: '/api/agent/tools/list_tool_setup',
    inputs: {
      type: 'object',
      properties: {
        branch: {
          type: 'string',
          description:
            'Optional: the draft branch you are working on. Tools declared there but not yet on the default ' +
            'branch are reported in `onBranchOnly`. Omit (or pass the default branch) for the catalog alone.',
        },
      },
      required: [],
      additionalProperties: false,
    },
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
                description: "An MCP server's sign-in requirement; null for non-mcp tools.",
                properties: {
                  kind: {
                    type: 'string',
                    description:
                      '`open` = no sign-in; `oauth-auto` = sign-in was configured automatically; `oauth-manual` = the ' +
                      'sign-in needs an OAuth app the owner registers with the provider: a writer declares its client ' +
                      'id on a `user`-scoped variable with an `oauth` block — in the plugin.json extensions entry for ' +
                      'an mcp.json server (endpoints are discovered from the server; PKCE is on by default), or in the ' +
                      '`.tool` file with explicit URLs — and pastes the client secret on the tool\'s page.',
                  },
                  reason: {
                    type: 'string',
                    description: 'Present only while something still blocks the sign-in, and says what.',
                  },
                },
              },
              canWrite: {
                type: 'boolean',
                description: 'You may write this `.tool` FILE, which is what gates setting its shared secrets.',
              },
              variables: {
                type: 'array',
                description:
                  'What this tool needs configured, and by whom: per variable, whether the shared (admin) value is ' +
                  'set and whether the CURRENT user has set or authorized their own.',
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
        invalid: {
          type: 'array',
          description:
            '`.tool` files the scan refused — the ONLY tools missing from `tools`; every other tool is listed and ' +
            'callable. Each names the file and why it was refused, with the line/column or field where the validation ' +
            'failed. Fix the file (or delete it) and the next call lists it as a normal tool, with nothing to restart ' +
            'or reconnect. Never contains a secret value.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'KB path of the refused `.tool` file (read it with `read_file`).' },
              reason: { type: 'string', description: 'The validation message, with its location where there is one.' },
            },
            required: ['path', 'reason'],
          },
        },
        onBranchOnly: {
          type: 'array',
          description:
            'Tools declared on `branch` that the default branch does not serve yet — absent from `tools` and ' +
            'from every tool surface until the branch is merged. Empty without `branch`.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              path: { type: 'string' },
              type: { type: 'string' },
              branch: { type: 'string' },
            },
            required: ['name', 'path', 'type', 'branch'],
          },
        },
        note: {
          type: 'string',
          description: 'Present when `onBranchOnly` is non-empty: what it takes for those tools to go live.',
        },
      },
      required: ['tools', 'invalid', 'onBranchOnly'],
    },
    tags: ['tools'],
  });
  registry.registerInternalTool(listSetupDef);
  registry.registerExternalTool(listSetupDef);
  router.post(
    '/agent/tools/list_tool_setup',
    toolAuth,
    toolHandler(async (args, ctx: ToolContext) => {
      // The in-app agent is focused on its own draft; an external caller names it.
      const branch = typeof args.branch === 'string' && args.branch ? args.branch : ctx.focusedBranch;
      // The catalog comes back whole — what parsed AND what was refused — from
      // ONE scan, so the refused files cost no second walk of the workspace and
      // the two halves cannot disagree about which files made it.
      const [{ tools: manuals, invalid }, pending] = await Promise.all([
        toolManualService.listAccessibleCatalog(ctx.user.email),
        branch ? toolManualService.listDeclaredOnlyOnBranch(ctx.user.email, branch) : Promise.resolve([]),
      ]);
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
          canWrite: await deps.accessControl.canWrite(defaultWs(), ctx.user.email, m.path),
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
      const onBranchOnly = pending.map((p) => ({ ...p, branch: branch! }));
      if (onBranchOnly.length === 0) return { tools, invalid, onBranchOnly };
      return {
        tools,
        invalid,
        onBranchOnly,
        note:
          `${onBranchOnly.map((p) => `\`${p.name}\``).join(', ')} ${onBranchOnly.length === 1 ? 'is' : 'are'} declared on ` +
          `\`${branch}\` only. Tools are served from \`${deps.kb.defaultBranch}\`, so ${onBranchOnly.length === 1 ? 'it stays' : 'they stay'} ` +
          'unlisted, uncallable and without a sign-in until that branch is merged: open a change request with ' +
          `\`open_change_request\` (target \`${deps.kb.defaultBranch}\`), then ask the user to review and merge it in the app.`,
      };
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
      'remote endpoint. To CALL them, run the workspace as a local MCP server instead of this one: ' +
      '`npx @bevel-software/hexis-mcp --url <workspace-url> --key <connection-key>` serves every tool ' +
      'you have here plus these, because it runs where they exist — and it resolves each tool\'s ' +
      'declared variables from this workspace\'s secrets, so nothing has to be hand-placed on that ' +
      'machine. Otherwise each entry gives the tool’s name and its `.tool` file ' +
      'path in the knowledge base — read that file with `read_file` and wire the tool into your local ' +
      'setup by hand. ' +
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
              slug: { type: 'string', description: 'How the tool is addressed on this API.' },
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

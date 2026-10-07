import { resolveKbLayout, type KbLayout } from '@bevel-software/platform-shared';
import type { KbContext } from '../../shared/kb-context.js';
import type { IToolRegistry, UtcpTool } from '../tool-registry/tool.contract.js';
import { toolDef } from '../tool-helpers/tool-def.js';

/**
 * The two plugin tools an agent has, both surfaces — DESCRIPTIONS of the
 * app's own creation endpoints, not a second implementation of them:
 *
 *  - `my_plugin`     → `POST /api/plugins/personal`
 *  - `create_plugin` → `POST /api/plugins`
 *
 * The endpoints are the same ones the New plugin button and the first-visit
 * personal-folder ensure call; they sit behind a gate that admits an agent's
 * connection key as well as a session (`keyOrSessionAuth`), so one route
 * serves both. Without these an agent asked to "put my skills in Hexis" had
 * nowhere to write: the personal folder is created lazily by the web app
 * under a name derived from the user's id, and a non-admin's plain write
 * under the plugins root is refused by the root rules.
 *
 * Every rule the app enforces — names, reserved prefixes, twins, where a
 * plugin may go, the one commit — is the endpoint's, so it holds for an
 * agent exactly as for a person; a refusal comes back as the endpoint's own
 * 4xx with its message.
 */
export function registerPluginsTools(registry: IToolRegistry, kb: KbContext): void {
  // ONE object on both surfaces, so the rewrite below reaches both of them.
  // The registry holds this object, and re-registering under the same name
  // would throw as a duplicate.
  const myPlugin = myPluginDef(kb.layout);
  registry.registerExternalTool(myPlugin);
  registry.registerInternalTool(myPlugin);
  /**
   * `my_plugin`'s description NAMES the knowledge root, so its text has to
   * follow the layout: the save that completes first-run setup applies the
   * names the admin just chose in that same request, without a restart, and a
   * description built once at registration would go on sending notes to a
   * folder this deployment no longer has. Rewritten in place, exactly as the
   * workspace tools' descriptions are (see `workspace.tools.ts`).
   */
  kb.onLayoutApplied(() => {
    myPlugin.description = myPluginDescription(kb.layout);
  });
  registry.registerExternalTool(CREATE_PLUGIN);
  registry.registerInternalTool(CREATE_PLUGIN);
}

/** The endpoint's answer, `ProvisionedPlugin` — see `PluginProvisionService`. */
const PROVISIONED_OUTPUT = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'The plugin folder, repo-relative (e.g. `Plugins/personal-abc`, `Plugins/Teams/GTM`) — the path the file tools address.' },
    skillsDir: { type: 'string', description: 'Where its skills go: `<path>/skills`. Each skill is a subfolder holding a `SKILL.md`.' },
    folder: { type: 'string', description: 'The same folder as its path below the plugins root.' },
    name: { type: 'string', description: 'The plugin identity (its manifest name), as grants and the marketplace spell it.' },
    displayName: { type: 'string', description: 'What people see it called — the manifest `displayName`, exactly as persisted: for `create_plugin`, the name that was asked for, trimmed; for `my_plugin`, the personal folder\'s own label.' },
    created: { type: 'boolean', description: 'False when the folder already existed.' },
  },
} as const;

/**
 * What an agent reads about the personal plugin, for the layout in effect.
 *
 * THE RULE COMES FIRST, and the order is the substance of it rather than a
 * matter of style. A personal plugin holds its owner's skills and tools;
 * nothing under the plugins root is part of the knowledge graph, and a
 * personal plugin is readable only by its owner — so a note filed there is
 * never found as knowledge again, by anyone, including its author's next
 * agent. Agents asked to "save this for me" were reading the old opening,
 * "their personal space in the knowledge base", as an invitation to do
 * precisely that.
 *
 * Stated ahead of the mechanics of writing a skill, not after them, because
 * claude.ai cuts a tool description near `CLIENT_SHORT_CUT` characters (see
 * `tool-registry/description-length.ts`) counted from the guide-first sentence
 * the registry puts in front of every listed tool. What survives that cut is
 * decided by ORDER, so the rule sits inside it and the `skillsDir` detail —
 * which the guide states in full anyway — is what a short client loses.
 * The root is named ONCE, after the rule rather than inside it: a folder name
 * may run to 255 bytes, and repeated within the rule it could push the rule
 * itself past the cut and the whole text past `TOOL_DESCRIPTION_CAP`.
 * `plugins.tools.test.ts` pins that placement rather than trusting this note.
 *
 * It REFUSES nothing. The write gate accepts every file in a personal plugin
 * exactly as it did before; this text is the whole of the change.
 */
export function myPluginDescription(layout: KbLayout): string {
  const knowledge = `\`${resolveKbLayout(layout).knowledgeBaseDir}/\``;
  return (
    "The caller's personal plugin: their own skills and tools, created on first use. " +
    'Notes, knowledge and other documents do NOT go here; they go under the knowledge root. ' +
    'For something the user wants kept private, ask where under the knowledge root it should go and say a ' +
    'folder there can be restricted so only they can read it; never write it here, even if asked. ' +
    `The knowledge root here is ${knowledge}. ` +
    'Returns its folder and where skills go inside it (`skillsDir`); write a skill there as ' +
    '`<skillsDir>/<skill-name>/SKILL.md` with the file tools, opening with the Agent Skills frontmatter ' +
    '(`name`, `description`, and `metadata.version` such as `"1.0.0"`). Readable only by its owner — not even admins — and ' +
    'never listed as a shared plugin. Idempotent: calling it again returns the same folder.'
  );
}

/**
 * The `my_plugin` definition for `layout`. Everything but the description is
 * the same on every deployment and byte-identical to what it has always been:
 * the same endpoint, the same (empty) inputs, the same outputs, the same tags.
 */
export function myPluginDef(layout: KbLayout): UtcpTool {
  return toolDef({
    name: 'my_plugin',
    description: myPluginDescription(layout),
    path: '/api/plugins/personal',
    inputs: { type: 'object', properties: {}, additionalProperties: false },
    outputs: PROVISIONED_OUTPUT,
    // `write`: both make folders and commit — a read-scoped caller's manual
    // must not advertise them (see `isWriteTool` in the manual routes).
    tags: ['plugins', 'skills', 'write'],
  });
}

export const CREATE_PLUGIN: UtcpTool = toolDef({
  name: 'create_plugin',
  description:
    "Create a shared plugin under the plugins root, exactly as the app's New plugin button does: the caller " +
    'runs it (read, write and owner), and it is discoverable by everyone so people can ask to join. Pass ' +
    '`parent` to make it inside an existing grouping folder under the plugins root (e.g. `Teams`); a plugin ' +
    'cannot be made inside another plugin. Returns the folder and where its skills go. A refusal carries ' +
    '`error` in words. 4xx means the input will not do: 409 when a plugin of that name (or its identifier) ' +
    'exists, 422 for a name the knowledge base cannot carry or a parent that may not hold a plugin, 404 when ' +
    'the parent folder is not there. 503 means the plugin list could not be read completely just now — ' +
    'nothing is wrong with the input; try again shortly.',
  path: '/api/plugins',
  inputs: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, description: 'The plugin name, e.g. `Design`. Becomes the folder name and the display name people see; its identifier is the kebab-case slug.' },
      parent: {
        type: 'string',
        description: 'Optional grouping folder below the plugins root to create it in, e.g. `Teams` or `Teams/EU`. Omit for the root.',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
  outputs: PROVISIONED_OUTPUT,
  // `write`: both make folders and commit — a read-scoped caller's manual
  // must not advertise them (see `isWriteTool` in the manual routes).
  tags: ['plugins', 'skills', 'write'],
});

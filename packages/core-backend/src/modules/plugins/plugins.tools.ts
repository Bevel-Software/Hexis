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
export function registerPluginsTools(registry: IToolRegistry): void {
  registry.registerExternalTool(MY_PLUGIN);
  registry.registerInternalTool(MY_PLUGIN);
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
    created: { type: 'boolean', description: 'False when the folder already existed.' },
  },
} as const;

export const MY_PLUGIN: UtcpTool = toolDef({
  name: 'my_plugin',
  description:
    "The caller's own private plugin — their personal space in the knowledge base, created on first use. " +
    'Returns its folder and where skills go inside it (`skillsDir`); write a skill there as ' +
    '`<skillsDir>/<skill-name>/SKILL.md` with the file tools. Readable only by its owner — not even admins — and ' +
    'never listed as a shared plugin. Idempotent: calling it again returns the same folder.',
  path: '/api/plugins/personal',
  inputs: { type: 'object', properties: {}, additionalProperties: false },
  outputs: PROVISIONED_OUTPUT,
  tags: ['plugins', 'skills'],
});

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
      name: { type: 'string', minLength: 1, description: 'The plugin name, e.g. `Design`. Becomes the folder name; its identifier is the kebab-case slug.' },
      parent: {
        type: 'string',
        description: 'Optional grouping folder below the plugins root to create it in, e.g. `Teams` or `Teams/EU`. Omit for the root.',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
  outputs: PROVISIONED_OUTPUT,
  tags: ['plugins', 'skills'],
});

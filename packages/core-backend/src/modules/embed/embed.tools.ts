import type { Router, RequestHandler } from 'express';
import type { IToolRegistry } from '../tool-registry/tool.contract.js';
import { ToolError } from '../tool-helpers/tool.contract.js';
import { toolDef } from '../tool-helpers/tool-def.js';
import type { ToolHandlerFactory } from '../tool-helpers/tool-handler.js';
import type { ToolContext } from '../tool-helpers/tool.contract.js';
import type { KbContext } from '../../shared/kb-context.js';
import type { ReadForTool } from '../workspace/workspace.tools.js';
import type { IEmbedService } from './embed.interface.js';
import { requireExternalSource } from '../tool-auth/tool-auth.middleware.js';
import { SESSION_ID_INPUT, type ToolDescriptionNotes } from '../workspace/agent-access.gate.js';
import { sessionIdInputOf } from '../workspace/workspace.tools.js';

/** The tool name, in one place: the app manifest keys its view by it. */
export const OPEN_PAGE_TOOL = 'open_page';

/** What `open_page` answers when the deployment cannot be framed. */
export const HTTP_DEPLOYMENT_NOTE =
  'This deployment is reached over plain http, so no chat host can show the page inline — ' +
  'an embedded view needs an https deployment. The page is above, and its address in the app ' +
  'opens the whole thing.';

/** What a path outside the knowledge base is told. */
export const OUTSIDE_REPO = (kbDirName: string): string =>
  `open_page shows a knowledge-base page, so \`path\` has to name a file under \`${kbDirName}/\`.`;

export interface EmbedToolsDeps {
  embedService: IEmbedService;
  kb: KbContext;
  /** `read_file`'s own read — see {@link ReadForTool}. */
  readForTool: ReadForTool;
  /** Whether a chat host's sandbox can load from this deployment's public address at all (https). */
  canBeReached: () => boolean;
  /** The file's address in the app, for the answer and for the view's fallback link. */
  appUrlFor: (repoRelative: string, slug?: string) => string;
  /** The notes a deployment registers for the gated tools — `read_file`'s, and so this tool's. */
  notes: ToolDescriptionNotes;
}

/**
 * `open_page`: the knowledge-base page, in the chat.
 *
 * The tool answers the file's TEXT exactly as `read_file` does — the same
 * read hook, the same access gate, the same refusals — and adds the address
 * of an embedded view that renders the page with the app's own renderer, so a
 * host that supports MCP Apps shows it inline and lets the reader edit it or
 * propose a change. A host that does not support them shows the text and the
 * app address, and nothing errors: the answer stands on its own.
 *
 * `read_file` is deliberately untouched (Decision 2). Carrying a view on it
 * would mint a token and render an iframe on every read an agent makes, for
 * every file it reads while thinking.
 *
 * No `branch` argument, by decision: the embedded view is editable, and an
 * editable embed targets the default branch only. The branch it rendered
 * comes back in the answer so nothing is implied.
 */
export function registerEmbedTools(
  registry: IToolRegistry,
  router: Router,
  toolAuth: RequestHandler,
  toolHandler: ToolHandlerFactory,
  deps: EmbedToolsDeps,
): void {
  const { kbDirName } = deps.kb;
  const DESCRIPTION =
    'Show a knowledge-base page to the person you are talking to, rendered inside this chat. ' +
    'Returns the same `{ path, content }` `read_file` returns — the page as text, for you to read — ' +
    'plus `embedUrl` (the view the chat renders), `appUrl` (the page in the app), and `branch` ' +
    "(always the default branch). The rendered view uses the app's own renderer for the file's type, " +
    'and offers the reader Edit when they may write the page and Propose changes when they may not, ' +
    'as that same person — not as you. Use it when somebody wants to SEE or FIX a page; use `read_file` ' +
    'when you only need to read one yourself. A chat host that cannot render a view shows the text, ' +
    'so calling this is never worse than reading.';
  const def = toolDef({
    name: OPEN_PAGE_TOOL,
    description: DESCRIPTION + deps.notes.gatedToolNote(),
    path: `/api/agent/tools/${OPEN_PAGE_TOOL}`,
    inputs: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          description:
            `Path of the page to show, under \`${kbDirName}/\` (e.g. \`${kbDirName}/KnowledgeBase/Foo.md\`), ` +
            'with or without a leading slash — a path without that prefix is placed under ' +
            `\`${kbDirName}/\`. The page is always shown from the default branch.`,
        },
        heading: {
          type: 'string',
          description:
            'Optional: the anchor slug of one heading (e.g. `problem-statement`) the view should open at. ' +
            'The whole page is shown either way — this only says where to start reading.',
        },
        // As `read_file` takes it: the read is `read_file`'s own, and a
        // deployment whose read hook wants the session must be able to get it.
        sessionId: SESSION_ID_INPUT,
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputs: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The path that was shown (echoes the input).' },
        heading: {
          type: 'string',
          description: 'The heading the view opens at (echoes the input). Absent when none was named.',
        },
        content: { type: 'string', description: "The page's text, exactly as `read_file` answers it." },
        embedUrl: {
          type: 'string',
          description:
            'The address of the view the chat renders. Absent when this deployment cannot be framed — ' +
            'see `note`.',
        },
        appUrl: { type: 'string', description: "The page's address in the app." },
        branch: { type: 'string', description: 'The branch the page was rendered from — the default branch.' },
        note: {
          type: 'string',
          description: 'Present only when there is no `embedUrl`: why there is no embedded view.',
        },
      },
      required: ['path', 'content', 'appUrl', 'branch'],
    },
    tags: ['workspace'],
  });
  // EXTERNAL only. The view exists for a chat somewhere else; the in-app
  // agent's reader is already looking at the app, where every page is a
  // click away — handing it an iframe of the page it is standing on would be
  // a tool that cannot help.
  registry.registerExternalTool(def);
  // The read is `read_file`'s own, so what the agent reads about it is too:
  // the note a deployment registers for the gated tools, and the `sessionId`
  // description with its note — applied now and on every later registration,
  // exactly as the file tools apply them (`sessionIdInputOf` is theirs).
  const redescribe = (): void => {
    def.description = DESCRIPTION + deps.notes.gatedToolNote();
    const sessionId = sessionIdInputOf(def);
    if (sessionId) sessionId.description = deps.notes.sessionIdDescription();
  };
  redescribe();
  deps.notes.onChange(redescribe);

  router.post(
    `/agent/tools/${OPEN_PAGE_TOOL}`,
    toolAuth,
    // Registered external-only above; the route holds the same line, so an
    // in-process agent that guessed the endpoint is refused here too.
    requireExternalSource,
    toolHandler(async (args, ctx: ToolContext) => {
      const raw = typeof args.path === 'string' ? args.path.trim() : '';
      if (!raw) throw new ToolError('`path` is required.', 400);
      const heading = typeof args.heading === 'string' && args.heading.trim() ? args.heading.trim() : undefined;
      const repoRelative = toRepoRelative(raw, kbDirName);
      if (repoRelative === null) throw new ToolError(OUTSIDE_REPO(kbDirName), 400);
      const branch = deps.kb.defaultBranch;
      const wsPath = `${kbDirName}/${repoRelative}`;

      // The read comes FIRST, and it is `read_file`'s own: a path the caller
      // may not read, or one that is not there, is refused here in the words
      // `read_file` refuses it — and no token is minted, because the mint is
      // below this line.
      const result = await deps.readForTool(branch, wsPath, ctx);
      const content =
        result.kind === 'text' ? result.text : result.kind === 'image' ? result.note : result.message;

      const appUrl = deps.appUrlFor(repoRelative, heading);
      // The heading goes back beside the path: the view calls this tool again
      // with both when its token runs out (see `mcp-app/page.html`), and a
      // result is all it is told.
      const echoed = heading ? { heading } : {};
      // No view on a plain-http deployment (Decision 8): a host's https
      // sandbox cannot load from it. The text and the app address are still
      // the answer, and the tool says why there is no view rather than
      // handing back an address no host can open.
      if (!deps.canBeReached()) {
        return { path: raw, ...echoed, content, appUrl, branch, note: HTTP_DEPLOYMENT_NOTE };
      }
      // Minted for the identity THIS MCP session authenticated — the
      // signed-in user, or the owner of the connection key the agent carries.
      // Whoever is in the chat therefore sees and may change exactly what
      // that person may, and the audit log attributes it to them.
      const { embedUrl } = await deps.embedService.mintForUser({
        userId: ctx.user.id,
        reference: heading ? `${repoRelative}#${heading}` : repoRelative,
      });
      return { path: raw, ...echoed, content, embedUrl, appUrl, branch };
    }),
  );
}

/**
 * `path` as a repo-relative path, or null when it names nothing inside the
 * knowledge base. Accepts it with or without the `<kbDir>/` prefix and with
 * or without a leading slash, which is what `read_file` documents.
 */
export function toRepoRelative(path: string, kbDirName: string): string | null {
  // A backslash is refused, not read as a separator — `read_file`'s contract,
  // and a token must never name a file other than the one the caller wrote.
  if (path.includes('\\')) return null;
  const norm = path.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  if (!norm) return null;
  const rel = norm === kbDirName ? '' : norm.startsWith(`${kbDirName}/`) ? norm.slice(kbDirName.length + 1) : norm;
  if (!rel) return null;
  // Traversal and the odd segment are refused HERE rather than deeper: the
  // path is about to become part of a signed token, and a token is the one
  // place a bad path would outlive the request that sent it.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(rel)) return null;
  if (!rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')) return null;
  return rel;
}

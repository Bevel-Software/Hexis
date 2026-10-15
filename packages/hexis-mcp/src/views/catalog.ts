/**
 * Knowledge views as MCP Apps.
 *
 * Every HTML knowledge view the caller can read (a page built with the
 * `html-knowledge-view` skill, recognised by its `kb-snapshot` block) becomes
 * a tool whose result an MCP Apps host renders: the page itself, in the chat,
 * with live data. Nothing about a view is configured here; the knowledge base
 * is the catalog, and a view a team approves into it shows up as a tool.
 *
 * Per view:
 * - a tool, `show_<name>`, whose `_meta.ui.resourceUri` points at the view. It
 *   reads the view's data live and returns a text summary for the model, plus
 *   the snapshot for the page in `_meta` (which hosts hand the view, not the
 *   model);
 * - a `ui://hexis/views/<name>.html` resource: the page as committed, with the
 *   bridge (bridge.ts) and the compact presentation (native.ts) injected.
 *
 * And one app-only tool, `hexis_view_data`, the bridge's fallback for live
 * data when no tool result reached it.
 *
 * Reads go through the caller's own KB tools (`/api/agent/tools/*`), so the
 * caller's read access decides what a view can show, exactly as in the app.
 *
 * SPEED. Finding the views is one search over the whole knowledge base (about
 * five seconds on a large one), so it never sits in front of a listing twice:
 * it starts the moment the catalog exists, and what it found is kept on disk
 * (`~/.hexis/views/<deployment>.json`, readable only by the owner, like the
 * sign-in beside it) together with each page and each view's last live data.
 * A restart answers from that copy at once and refreshes behind it; a change
 * found by the refresh is announced with `list_changed` notifications.
 */
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Resource, Tool as McpTool, CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { HexisMcpConfig } from '../config.js';
import { callKbTool } from '../deployment.js';
import { hexisHome, hostKey } from '../materialize.js';
import { injectBridge, VIEW_META_KEY, type BridgeConfig } from './bridge.js';
import {
  buildSnapshot,
  isKnowledgeView,
  mirrorFiles,
  readEmbeddedSnapshot,
  replaceEmbeddedSnapshot,
  type KbReader,
  type Selection,
  type Snapshot,
} from './snapshot.js';

/** The MCP Apps resource type (`text/html;profile=mcp-app`). */
export const VIEW_MIME_TYPE = 'text/html;profile=mcp-app';
export const VIEW_DATA_TOOL = 'hexis_view_data';
const VIEW_TOOL_PREFIX = 'show_';
const URI_PREFIX = 'ui://hexis/views/';
/** The repository's folder in KB tool paths and workspace URLs, until a search names it. */
const DEFAULT_KB_DIR = 'knowledge-base';
const DEFAULT_BRANCH = 'main';
/** How long a catalog is trusted before the next use refreshes it (in the background). */
const CATALOG_TTL_MS = 5 * 60_000;
/** How long a page is served without asking the knowledge base whether it changed. */
const PAGE_TTL_MS = 30_000;
/**
 * With a list kept from the last run, the refresh waits this long: the search
 * is heavy on the knowledge base, and right after a start is exactly when the
 * first view's live read wants it.
 */
const KEPT_REFRESH_DELAY_MS = 20_000;
/** Nodes the model's summary lists before it says how many more there are. */
const SUMMARY_NODES = 80;
const CACHE_VERSION = 1;
/**
 * The search matches the snapshot block alone, one line per view, so its
 * result cap is spent on views. A title pattern beside it matched the title of
 * every HTML page in the knowledge base and filled the cap with pages that are
 * not views. Titles come from the pages, which are read anyway.
 */
const SNAPSHOT_LINE = /<script\b[^>]*\bid=["']kb-snapshot["']/i;
const TITLE_LINE = /<title>([^<]+)<\/title>/i;
/** The search's cap, the most the grep tool allows. */
const SEARCH_CAP = 1000;

export interface ViewEntry {
  tool: string;
  uri: string;
  /** Repo path, without the repository folder (`knowledge-base/`). */
  path: string;
  title: string;
}

type CallKb = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface ViewCatalogOptions {
  /** How the KB tools are called; the deployment's `/api/agent/tools/*` by default. */
  callKb?: CallKb;
  /** Where the catalog is kept between runs; `null` keeps it in memory only. Default `~/.hexis/views`. */
  cacheDir?: string | null;
  /** Called when a background refresh changed the list of views. */
  onChange?: () => void;
}

/** `To-Do-List.html` -> `To Do List`: the file name as a reader would say it. */
export function titleFromPath(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1).replace(/\.html?$/i, '');
  return base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A tool name for a view, unique among `taken`: `show_to_do_list`, then `show_to_do_list_2`. */
export function viewToolName(p: string, taken: Set<string>): string {
  const slug =
    titleFromPath(p)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'view';
  let name = `${VIEW_TOOL_PREFIX}${slug}`;
  for (let n = 2; taken.has(name); n += 1) name = `${VIEW_TOOL_PREFIX}${slug}_${n}`;
  taken.add(name);
  return name;
}

const splitRepoPath = (raw: string): { dir: string; rel: string } | null => {
  const full = raw.replace(/^\/+/, '');
  const slash = full.indexOf('/');
  return slash < 0 ? null : { dir: full.slice(0, slash), rel: full.slice(slash + 1) };
};

/**
 * The knowledge views in a search result, as repo paths, plus the repository's
 * folder name (every KB tool path starts with it). Only lines that are a
 * snapshot block count; skill templates are left out.
 */
export function viewPathsFromGrep(result: unknown): { kbDir: string | null; paths: string[] } {
  const matches = (result as { matches?: { path?: unknown; text?: unknown }[] } | null)?.matches ?? [];
  const paths = new Set<string>();
  let kbDir: string | null = null;
  for (const m of matches) {
    if (typeof m.path !== 'string' || typeof m.text !== 'string' || !SNAPSHOT_LINE.test(m.text)) continue;
    const split = splitRepoPath(m.path);
    if (!split) continue;
    kbDir ??= split.dir;
    if (!/\.html?$/i.test(split.rel)) continue;
    // A skill's own template carries an (empty) snapshot block too: not a view.
    if (/(^|\/)skills\/[^/]+\/assets\//.test(split.rel)) continue;
    paths.add(split.rel);
  }
  return { kbDir, paths: [...paths].sort() };
}

/** The model's view of a snapshot: one line per node, the short fields only. */
export function summarize(snapshot: Snapshot, limit = SUMMARY_NODES): string {
  const nodes = Object.values(snapshot.nodes);
  const lines = nodes.slice(0, limit).map((n) => {
    const name = n.fields.Name?.text || n.fields.Title?.text || n.file_path.split('/').pop();
    const facts = Object.entries(n.fields)
      .filter(([k, f]) => !['Name', 'Title', 'name', 'title'].includes(k) && f.text && f.text.length <= 60 && !f.text.includes('\n'))
      .map(([k, f]) => `${k} ${f.text}`);
    return `- [${n.node_type}] ${name}${facts.length ? ` · ${facts.join(' · ')}` : ''} (${n.file_path})`;
  });
  if (nodes.length > limit) lines.push(`- …and ${nodes.length - limit} more`);
  return lines.join('\n');
}

export interface ViewCatalog {
  /** Start finding the views now (idempotent): a listing later finds them ready. */
  prefetch(): void;
  handles(tool: string): boolean;
  listTools(): Promise<McpTool[]>;
  callTool(tool: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** Whether `uri` is a knowledge view's address, whether or not that view exists. */
  handlesResource(uri: string): boolean;
  listResources(): Promise<{ resources: Resource[] }>;
  readResource(uri: string): Promise<ReadResourceResult>;
}

/** What is kept between runs, per deployment. */
interface CacheFile {
  version: number;
  baseUrl: string;
  kbDir: string;
  at: number;
  views: ViewEntry[];
  pages: Record<string, { at: number; html: string }>;
  snapshots: Record<string, Snapshot>;
}

const sameViews = (a: ViewEntry[], b: ViewEntry[]): boolean => JSON.stringify(a) === JSON.stringify(b);

export function createViewCatalog(config: HexisMcpConfig, options: ViewCatalogOptions = {}): ViewCatalog {
  const call: CallKb = options.callKb ?? ((tool, args) => callKbTool(config, tool, args));
  const webBase = config.baseUrl.replace(/\/+$/, '');
  const cacheFile =
    options.cacheDir === null ? null : path.join(options.cacheDir ?? path.join(hexisHome(), 'views'), `${hostKey(config.baseUrl)}.json`);

  // -- state, seeded from the last run --------------------------------------------------
  let kbDir = DEFAULT_KB_DIR;
  let views: ViewEntry[] | null = null;
  let viewsAt = 0;
  const pages = new Map<string, { at: number; html: string }>();
  const snapshots = new Map<string, Snapshot>();
  if (cacheFile) {
    try {
      const saved = JSON.parse(readFileSync(cacheFile, 'utf8')) as CacheFile;
      if (saved.version === CACHE_VERSION && saved.baseUrl === config.baseUrl && Array.isArray(saved.views)) {
        kbDir = saved.kbDir || DEFAULT_KB_DIR;
        views = saved.views;
        viewsAt = saved.at;
        for (const [p, page] of Object.entries(saved.pages ?? {})) pages.set(p, page);
        for (const [p, snap] of Object.entries(saved.snapshots ?? {})) snapshots.set(p, snap);
      }
    } catch {
      // No copy yet, or an unreadable one: the first search builds it.
    }
  }

  let saveTimer: NodeJS.Timeout | null = null;
  const save = (): void => {
    if (!cacheFile || saveTimer) return;
    // Coalesced: a burst of page and snapshot reads costs one write.
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const known = new Set((views ?? []).map((v) => v.path));
      const body: CacheFile = {
        version: CACHE_VERSION,
        baseUrl: config.baseUrl,
        kbDir,
        at: viewsAt,
        views: views ?? [],
        pages: Object.fromEntries([...pages].filter(([p]) => known.has(p))),
        snapshots: Object.fromEntries([...snapshots].filter(([p]) => known.has(p))),
      };
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      void fs
        .mkdir(path.dirname(cacheFile), { recursive: true, mode: 0o700 })
        .then(() => fs.writeFile(tmp, JSON.stringify(body), { mode: 0o600 }))
        .then(() => fs.rename(tmp, cacheFile))
        .catch((err: unknown) =>
          console.error(`[hexis-mcp] could not keep the views catalog: ${err instanceof Error ? err.message : String(err)}`),
        );
    }, 250);
    saveTimer.unref?.();
  };

  // One KB session for every view read: views only read, so the
  // one-ontology-per-session write boundary never comes into play.
  let session: Promise<string> | null = null;
  const sessionId = (): Promise<string> => {
    session ??= call('start_session', {}).then(
      (r) => {
        const id = (r as { sessionId?: unknown } | null)?.sessionId;
        if (typeof id !== 'string') throw new Error('start_session returned no sessionId');
        return id;
      },
      (err: unknown) => {
        session = null; // a failed mint is retried by the next read
        throw err;
      },
    );
    return session;
  };
  const kb = async (tool: string, body: Record<string, unknown>): Promise<unknown> =>
    call(tool, { ...body, sessionId: await sessionId() });
  const reader = (branch: string): KbReader => ({
    list: async (p) => {
      const r = (await kb('list_files', { branch, path: `${kbDir}/${p}` })) as { entries?: { name: string; type: string }[] };
      return r?.entries ?? [];
    },
    read: async (p) => {
      const r = (await kb('read_file', { branch, path: `${kbDir}/${p}` })) as { content?: unknown };
      if (typeof r?.content !== 'string') throw new Error(`no text content for ${p}`);
      return r.content;
    },
  });

  // -- finding the views ----------------------------------------------------------------
  let refreshing: Promise<ViewEntry[]> | null = null;
  const refresh = (): Promise<ViewEntry[]> => {
    refreshing ??= (async () => {
      try {
        // Case-insensitive, as the pattern's own `i` is: `.source` drops the flag.
        const result = await kb('grep', {
          branch: DEFAULT_BRANCH,
          pattern: SNAPSHOT_LINE.source,
          ignore_case: true,
          max_results: SEARCH_CAP,
        });
        const found = viewPathsFromGrep(result);
        if (found.kbDir) kbDir = found.kbDir;
        let paths = found.paths;
        if ((result as { truncated?: unknown } | null)?.truncated) {
          // A capped search says nothing about the views it did not reach, so
          // those are kept rather than dropped. A view deleted meanwhile stays
          // listed until a search completes.
          console.error('[hexis-mcp] the views search hit its result cap; views it did not reach are kept from before.');
          paths = [...new Set([...paths, ...(views ?? []).map((v) => v.path)])].sort();
        }
        const taken = new Set<string>();
        const next: ViewEntry[] = paths.map((p) => {
          const tool = viewToolName(p, taken);
          return { tool, uri: `${URI_PREFIX}${tool.slice(VIEW_TOOL_PREFIX.length)}.html`, path: p, title: titleFromPath(p) };
        });
        // Each title from its page, which this also warms so the first view
        // opened is served from memory. A page that cannot be read keeps the
        // title its file name gives.
        await Promise.all(
          next.map(async (v) => {
            const title = await page(v, DEFAULT_BRANCH).then((html) => html.match(TITLE_LINE)?.[1]?.trim(), () => undefined);
            if (title) v.title = title;
          }),
        );
        const changed = views !== null && !sameViews(views, next);
        views = next;
        viewsAt = Date.now();
        save();
        console.error(`[hexis-mcp] ${next.length} knowledge view(s) served as MCP Apps.`);
        if (changed) options.onChange?.();
        return next;
      } catch (err) {
        console.error(`[hexis-mcp] knowledge views unavailable: ${err instanceof Error ? err.message : String(err)}`);
        // Keep serving what was found before rather than dropping every view.
        return views ?? [];
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };
  /** The views now: the known list at once (refreshed behind it when old), or the first search. */
  const current = async (): Promise<ViewEntry[]> => {
    if (views === null) return refresh();
    if (Date.now() - viewsAt > CATALOG_TTL_MS) void refresh();
    return views;
  };
  const byTool = async (tool: string): Promise<ViewEntry | undefined> =>
    (await current()).find((v) => v.tool === tool) ?? (await refresh()).find((v) => v.tool === tool);

  // -- a view's page and its live data ---------------------------------------------------------
  const pageReads = new Map<string, Promise<string>>();
  /** The page, from memory when fresh; read again (once at a time) when not. */
  const fetchPage = (view: ViewEntry, branch: string): Promise<string> => {
    const key = `${branch}\n${view.path}`;
    let read = pageReads.get(key);
    if (!read) {
      read = reader(branch)
        .read(view.path)
        .then((html) => {
          if (branch === DEFAULT_BRANCH) {
            pages.set(view.path, { at: Date.now(), html });
            save();
          }
          return html;
        })
        .finally(() => pageReads.delete(key));
      pageReads.set(key, read);
    }
    return read;
  };
  async function page(view: ViewEntry, branch: string): Promise<string> {
    if (branch !== DEFAULT_BRANCH) return fetchPage(view, branch);
    const kept = pages.get(view.path);
    if (!kept) return fetchPage(view, branch);
    // Stale while revalidating: the page is a shell, its data comes live anyway.
    if (Date.now() - kept.at > PAGE_TTL_MS) void fetchPage(view, branch).catch(() => {});
    return kept.html;
  }

  async function liveSnapshot(view: ViewEntry, branch: string): Promise<{ snapshot: Snapshot; errors: string[] }> {
    const embedded = readEmbeddedSnapshot(await page(view, branch));
    const selection = embedded?.selection as Selection | undefined;
    const mirror = selection?.mirror;
    if (!selection || !mirror) {
      throw new Error(
        'this page records no mirror configuration (its snapshot was built from a folder, or by hand), so it cannot be read live',
      );
    }
    const { files, errors } = await mirrorFiles(reader(branch), mirror);
    const snapshot = buildSnapshot(files, selection, branch);
    if (branch === DEFAULT_BRANCH) {
      snapshots.set(view.path, snapshot);
      save();
    }
    return { snapshot, errors };
  }

  const branchOf = (args: Record<string, unknown>): string =>
    typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : DEFAULT_BRANCH;

  const viewTool = (view: ViewEntry): McpTool => ({
    name: view.tool,
    title: view.title,
    description:
      `Show the "${view.title}" view from the Hexis knowledge base (${view.path}) to the user as an interactive ` +
      'page in the chat, with live data. Returns a summary of what the view shows (each item with its file path), so ' +
      'you can act on it: edit those files with the knowledge-base tools when the user asks for a change. In clients ' +
      'without MCP Apps the summary is all that is shown.',
    inputSchema: {
      type: 'object',
      properties: { branch: { type: 'string', description: `Branch to read the view and its data from (default ${DEFAULT_BRANCH}).` } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    // Both spellings: `ui.resourceUri` is current, `ui/resourceUri` is what older hosts read.
    _meta: { ui: { resourceUri: view.uri }, 'ui/resourceUri': view.uri },
  });

  const dataTool: McpTool = {
    name: VIEW_DATA_TOOL,
    title: 'Knowledge view data',
    description:
      'Used by Hexis knowledge views to load their live data. Not for direct use: call a show_* tool to show a view.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', description: "The view's show_* tool name." },
        branch: { type: 'string', description: `Branch (default ${DEFAULT_BRANCH}).` },
      },
      required: ['view'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] } },
  };

  const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  return {
    prefetch() {
      // Nothing known: search now, alongside discovery. A list kept from the
      // last run already answers, so its refresh steps aside for a while.
      if (views === null) {
        void refresh();
        return;
      }
      const later = setTimeout(() => void refresh(), KEPT_REFRESH_DELAY_MS);
      later.unref?.();
    },

    handles: (tool) => tool === VIEW_DATA_TOOL || (views ?? []).some((v) => v.tool === tool),

    async listTools() {
      const list = await current();
      return list.length ? [...list.map(viewTool), dataTool] : [];
    },

    async callTool(tool, args) {
      if (tool === VIEW_DATA_TOOL) {
        const view = await byTool(String(args.view ?? ''));
        if (!view) return { isError: true, content: [{ type: 'text', text: `Unknown view "${String(args.view)}".` }] };
        try {
          const { snapshot } = await liveSnapshot(view, branchOf(args));
          return {
            content: [{ type: 'text', text: `${Object.keys(snapshot.nodes).length} node(s), live.` }],
            structuredContent: { snapshot },
          };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: errorText(err) }] };
        }
      }
      const view = await byTool(tool);
      if (!view) return { isError: true, content: [{ type: 'text', text: `Unknown view "${tool}".` }] };
      const branch = branchOf(args);
      try {
        const { snapshot, errors } = await liveSnapshot(view, branch);
        const count = Object.keys(snapshot.nodes).length;
        const lines = [
          `Showing "${view.title}" (${view.path}), live from branch ${branch}: ${count} item(s). ` +
            'The user sees the page rendered in the chat; changes they make there arrive as a message.',
        ];
        if (errors.length) lines.push(`Some files could not be read (${errors.length}): ${errors.slice(0, 3).join('; ')}`);
        lines.push('', summarize(snapshot));
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          _meta: { [VIEW_META_KEY]: { path: view.path, branch, snapshot } },
        };
      } catch (err) {
        // The page still renders, from the snapshot it carries.
        return {
          content: [
            {
              type: 'text',
              text: `Showing "${view.title}" (${view.path}) from its embedded snapshot; live data did not load: ${errorText(err)}`,
            },
          ],
          _meta: { [VIEW_META_KEY]: { path: view.path, branch, liveError: errorText(err) } },
        };
      }
    },

    handlesResource: (uri) => uri.startsWith(URI_PREFIX),

    async listResources() {
      return {
        resources: (await current()).map((v) => ({
          uri: v.uri,
          name: v.tool,
          title: v.title,
          description: `Knowledge view ${v.path}`,
          mimeType: VIEW_MIME_TYPE,
        })),
      };
    },

    async readResource(uri) {
      const view = (await current()).find((v) => v.uri === uri) ?? (await refresh()).find((v) => v.uri === uri);
      if (!view) throw new Error(`Unknown resource ${uri}`);
      let html = await page(view, DEFAULT_BRANCH);
      if (!isKnowledgeView(html)) throw new Error(`${view.path} is no longer a knowledge view`);
      // The last live read, when there is one, is fresher than what the page
      // was committed with: the first paint uses it, live data follows.
      const last = snapshots.get(view.path);
      if (last) html = replaceEmbeddedSnapshot(html, last);
      const bridge: BridgeConfig = {
        view: view.tool,
        dataTool: VIEW_DATA_TOOL,
        pagePath: view.path,
        branch: DEFAULT_BRANCH,
        webBase,
        kbDir,
      };
      return {
        contents: [
          {
            uri,
            mimeType: VIEW_MIME_TYPE,
            text: injectBridge(html, bridge),
            // Self-contained pages: no network origins to declare.
            _meta: { ui: { prefersBorder: true, csp: {} } },
          },
        ],
      };
    },
  };
}

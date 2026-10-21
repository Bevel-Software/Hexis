import { AgentScopeService } from '../index.js';

/**
 * A knowledge base held in memory, for driving the REAL `AgentScopeService`
 * through its four collaborators: the default branch's files, the person's
 * read gate, the walk that finds `.agent` files, and the plugin link index.
 * Mutate `files`, `hidden` or `plugins` and the next resolve sees it.
 */
export interface InMemoryKb {
  /** Repo-relative path → content. */
  files: Map<string, string>;
  /** Paths the reader may NOT read. Everything else `reader` may. */
  hidden: Set<string>;
  plugins: { folder: string; linkedSkills: string[] }[];
  /** The one person who may read anything at all. */
  reader: string;
}

export function inMemoryKb(files: Record<string, string>, extra: Partial<InMemoryKb> = {}): InMemoryKb {
  return { files: new Map(Object.entries(files)), hidden: new Set(), plugins: [], reader: 'ada@example.com', ...extra };
}

export function agentScopeOver(kb: InMemoryKb): AgentScopeService {
  return new AgentScopeService(
    {
      getOrCreateForBranch: async () => ({ id: 'ws-main' }) as never,
      getWorkspacePath: async () => '/ws/main',
      readFile: async (_ws: string, p: string) => {
        const content = kb.files.get(p.replace(/^knowledge-base\//, ''));
        if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return content;
      },
    },
    {
      canReadBatch: async (_ws: string, email: string, paths: string[]) =>
        new Map(paths.map((p) => [p, email === kb.reader && !kb.hidden.has(p)])),
    },
    { kbDirName: 'knowledge-base', defaultBranch: 'main' },
    {
      walkFiles: async (_root: string, match: (b: string) => boolean) =>
        [...kb.files.keys()].filter((p) => match(p.slice(p.lastIndexOf('/') + 1))),
    },
    { membership: async () => ({ byPlugin: new Map(kb.plugins.map((p) => [p.folder, p])) }) },
  );
}

/** An `.agent` file: the definition in its fence, prose after. */
export function agentFile(definition: string): string {
  return `---\n${definition}\n---\n\nNotes for people.\n`;
}

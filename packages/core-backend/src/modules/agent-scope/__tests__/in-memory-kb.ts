import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { pathUnderRoot } from '@bevel-software/platform-shared';
import { ConnectionScope, type IAgentScopeResolver, type AgentChoice } from '../index.js';

/**
 * A distribution's agent configurations, held in memory, resolved the way a
 * distribution resolves them — so core's surfaces are driven through the
 * REAL contract (`IAgentScopeResolver`) by a stand-in for the one thing core
 * does not own: what a configuration is. Here it is a `---` fenced YAML
 * definition (`name`, `description`, `plugins`, `skills`, `connectors`,
 * `platformTools`) at a repo-relative path, read through the reader's read
 * gate, its `plugins:` expanded by a link index. Mutate `files`, `hidden` or
 * `plugins` and the next resolve sees it.
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

/** The extension the stand-in distribution gives its configurations. */
const EXTENSION = '.agent';

interface Definition {
  name: string;
  description: string;
  plugins: string[];
  skills: string[];
  connectors: string[];
  platformTools: string[] | null;
}

function list(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  throw new Error(`its \`${key}\` is not a list of names`);
}

const clean = (p: string): string | null => {
  const n = p.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return n && !n.split('/').some((s) => s === '..' || s === '.') ? n : null;
};

function parse(content: string, path: string): Definition {
  const m = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!m) throw new Error('it has no `---` fenced definition at the top');
  const obj = (parseYaml(m[1]!) ?? {}) as Record<string, unknown>;
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.agent$/i, '');
  const fold = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  return {
    name: fold(obj.name) || base,
    description: fold(obj.description),
    plugins: list(obj, 'plugins').map(clean).filter((p): p is string => p !== null),
    skills: list(obj, 'skills').map(clean).filter((p): p is string => p !== null),
    connectors: list(obj, 'connectors').map(clean).filter((p): p is string => p !== null),
    platformTools: Object.prototype.hasOwnProperty.call(obj, 'platformTools')
      ? list(obj, 'platformTools').map((s) => s.trim()).filter((s) => s.length > 0)
      : null,
  };
}

/** The stand-in distribution's resolver over `kb`. */
export function agentScopeOver(kb: InMemoryKb): IAgentScopeResolver {
  const readable = (email: string | undefined, path: string): boolean => email === kb.reader && !kb.hidden.has(path);
  const normalize = (agentPath: string): string | null => {
    const n = clean(agentPath.replace(/\\/g, '/').replace(/\/{2,}/g, '/'));
    return n !== null && n.endsWith(EXTENSION) ? n : null;
  };
  return {
    async resolve(userEmail, agentPath) {
      if (!agentPath) return ConnectionScope.everything();
      const rel = normalize(agentPath);
      if (rel === null || !readable(userEmail, rel)) return ConnectionScope.gone(rel ?? agentPath);
      const content = kb.files.get(rel);
      if (content === undefined) return ConnectionScope.gone(rel);
      const digest = createHash('sha256').update(content).digest('hex');
      const fingerprint = `agent\u0000${rel}\u0000${digest}`;
      let def: Definition;
      try {
        def = parse(content, rel);
      } catch (err) {
        return ConnectionScope.unavailable(
          { path: rel, name: rel },
          `This connection was made as the agent \`${rel}\`, which is not a valid agent definition ` +
            `(${(err as Error).message}), so it loads no tools and no skills until the file is fixed.`,
          fingerprint,
        );
      }
      const pluginFolders: string[] = [];
      const linked: string[] = [];
      for (const p of kb.plugins) {
        if (!def.plugins.some((entry) => pathUnderRoot(p.folder, entry))) continue;
        pluginFolders.push(p.folder);
        linked.push(...p.linkedSkills);
      }
      return ConnectionScope.narrowed(
        { path: rel, name: def.name },
        {
          skills: [...def.skills, ...pluginFolders, ...linked],
          connectors: [...def.connectors, ...pluginFolders],
          platformTools: def.platformTools,
        },
        fingerprint,
      );
    },
    async listChoices(userEmail) {
      const choices: AgentChoice[] = [];
      for (const [path, content] of kb.files) {
        if (!path.endsWith(EXTENSION) || !readable(userEmail, path)) continue;
        try {
          const def = parse(content, path);
          choices.push({ path, name: def.name, description: def.description });
        } catch {
          // Not a valid definition: not offered.
        }
      }
      return choices.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    },
    async choosable(userEmail, agentPath) {
      const rel = normalize(agentPath);
      if (rel === null || !readable(userEmail, rel)) return null;
      const content = kb.files.get(rel);
      if (content === undefined) return null;
      try {
        parse(content, rel);
        return rel;
      } catch {
        return null;
      }
    },
  };
}

/** A configuration as the stand-in distribution writes it: the definition in its fence, prose after. */
export function agentFile(definition: string): string {
  return `---\n${definition}\n---\n\nNotes for people.\n`;
}

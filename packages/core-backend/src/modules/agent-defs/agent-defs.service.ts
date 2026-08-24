import path from 'node:path';
import fs from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_BRANCH, AGENTS_DIR } from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { extractFrontmatter, resolveDeclaredId, isValidId, dedupeById } from '../../shared/frontmatter-id.js';
import { walkFiles } from '../../shared/fs-walk.js';
import { TtlCache } from '../../shared/ttl-cache.js';
import type {
  AgentDefinitionSummary,
  AgentEnvVariable,
  IAgentDefinitionService,
} from './agent-defs.contract.js';

const CACHE_TTL_MS = 60_000;

/**
 * How many `env:` entries one `.agent` may declare. Author-written input, and
 * every vault entry is one secrets-UI row and one decryption per resolve.
 */
const MAX_ENV_VARIABLES = 50;

/**
 * The vault key an `.agent`'s vault variable binds to.
 *
 * `agent:<slug>:<VAR>` — namespaced by agent for the same reason a `.tool`'s
 * secrets are namespaced by manual: an `.agent` file may resolve ONLY the
 * secrets provisioned for it. Agents write to the knowledge base, so a newly
 * landed `.agent` naming `GITHUB_TOKEN` must come up empty rather than inherit
 * someone else's credential.
 *
 * The colons matter. Tool namespaces are built by `utcpNamespacePrefix`, which
 * maps every non-word character to `_` — so no `.tool`, whatever it is called,
 * can ever produce a key containing `:`. That keeps the two namespaces provably
 * disjoint in one flat keyspace, rather than disjoint by naming convention.
 */
export function agentVaultKey(agentSlug: string, varName: string): string {
  return `agent:${agentSlug}:${varName}`;
}

/**
 * Split a vault key back into agent slug + variable name, or null if it is not
 * an agent key. Used by the scope resolver, which sees one flat keyspace.
 */
export function parseAgentVaultKey(key: string): { slug: string; name: string } | null {
  const parts = key.split(':');
  if (parts.length !== 3 || parts[0] !== 'agent' || !parts[1] || !parts[2]) return null;
  return { slug: parts[1], name: parts[2] };
}

/**
 * Reads `*.agent` files from the DEFAULT-branch workspace — never the caller's
 * branch — so the set of agents, and therefore the set of secrets any of them
 * may be handed, is the released one. An unmerged branch cannot widen it.
 *
 * Any read failure degrades to an empty list: an unreadable `.agent` must mean
 * "no secrets" rather than "no check".
 */
export class AgentDefinitionService implements IAgentDefinitionService {
  private readonly cache: TtlCache<AgentDefinitionSummary[]>;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly accessControl: IAccessControl,
    private readonly kbDirName: string,
    now: () => number = Date.now,
  ) {
    this.cache = new TtlCache(CACHE_TTL_MS, now);
  }

  invalidate(): void {
    this.cache.invalidate();
  }

  async listAll(): Promise<AgentDefinitionSummary[]> {
    return this.scan();
  }

  async listAccessible(userEmail: string): Promise<AgentDefinitionSummary[]> {
    const agents = await this.scan();
    if (agents.length === 0) return [];
    const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
    const allowed = await this.accessControl.canReadBatch(
      wsId,
      userEmail,
      agents.map((a) => a.path),
    );
    // Fail closed, as the tool catalog does: only an explicit `true` keeps it.
    return agents.filter((a) => allowed.get(a.path) === true);
  }

  async getAccessible(userEmail: string, slug: string): Promise<AgentDefinitionSummary | null> {
    return (await this.listAccessible(userEmail)).find((a) => a.slug === slug) ?? null;
  }

  private async scan(): Promise<AgentDefinitionSummary[]> {
    const cached = this.cache.get();
    if (cached) return cached;
    const agents = await this.scanDisk();
    this.cache.set(agents);
    return agents;
  }

  private async scanDisk(): Promise<AgentDefinitionSummary[]> {
    let wsId: string;
    try {
      wsId = (await this.workspaceService.getOrCreateForBranch(DEFAULT_BRANCH)).id;
    } catch {
      return [];
    }
    const root = path.join(
      await this.workspaceService.getWorkspacePath(wsId),
      this.kbDirName,
      AGENTS_DIR,
    );

    const parsed: AgentDefinitionSummary[] = [];
    for (const rel of await walkFiles(root, (n) => n.toLowerCase().endsWith('.agent'))) {
      let content: string;
      try {
        content = await fs.readFile(path.join(root, rel), 'utf-8');
      } catch {
        continue;
      }
      try {
        parsed.push(normalizeAgentDefinition(baseName(rel), `${AGENTS_DIR}/${rel}`, content));
      } catch {
        // A malformed `.agent` is skipped, not fatal — one bad file must not
        // take every other agent's secrets out of the catalog.
        continue;
      }
    }
    // The slug is the vault namespace, so it has to be unique. A collision is
    // refused rather than suffixed: auto-suffixing would silently rebind a
    // provisioned secret to a different file.
    return dedupeById(
      parsed,
      (a) => a.slug,
      (a, id) =>
        console.warn(
          `[agent-defs] skipping "${a.path}": agent id "${id}" is already used by another ` +
            '`.agent` — give it a unique `id` (the id is the secret-variable namespace).',
        ),
    );
  }
}

// --- parsing ------------------------------------------------------------------

/**
 * Parse an `.agent` into the narrow shape the PLATFORM needs — identity plus
 * the declared environment. The execution layer parses the same file for what
 * it needs (harness, model, prompt, tools); this reader deliberately ignores
 * all of it, so no field the platform doesn't understand can influence which
 * secrets it hands out.
 *
 * Shape follows `.tool`: the whole file is one `---` fenced YAML document with
 * access verbs as ordinary keys inside it, and anything after the closing fence
 * is free-form notes. A fence-less file is read as the object itself.
 */
export function normalizeAgentDefinition(
  provisionalSlug: string,
  repoPath: string,
  content: string,
): AgentDefinitionSummary {
  const fm = extractFrontmatter(content);
  const parsed = parseYaml(fm ? fm.frontmatter : content) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('`.agent` file must be a YAML object (in the `---` block when fenced)');
  }
  const obj = parsed as Record<string, unknown>;

  const explicitId = typeof obj.id === 'string' ? obj.id.trim() : '';
  let slug: string;
  if (explicitId) {
    if (!isValidId(explicitId)) {
      throw new Error(`agent id "${explicitId}" must be lowercase snake_case (letters, digits, underscores)`);
    }
    slug = explicitId;
  } else {
    slug = agentSlug(resolveDeclaredId(obj, provisionalSlug));
  }

  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : slug;
  const description = typeof obj.description === 'string' ? obj.description.trim() : '';

  return {
    slug,
    name,
    path: repoPath,
    ...(description ? { description } : {}),
    vaultVariables: normalizeEnv(obj.env),
  };
}

/**
 * The `env:` block, reduced to its `from: vault` entries.
 *
 * A malformed entry THROWS rather than being dropped: the whole point of this
 * list is that it is an allowlist, and an allowlist that silently loses an
 * entry it could not read is an allowlist nobody can reason about. Entries
 * resolved `from: params` are the pipeline's business and are simply absent
 * here — the platform never sees a parameter value.
 */
function normalizeEnv(raw: unknown): AgentEnvVariable[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('`env` must be an array');
  if (raw.length > MAX_ENV_VARIABLES) {
    throw new Error(`\`env\` declares ${raw.length} variables (max ${MAX_ENV_VARIABLES})`);
  }
  const seen = new Set<string>();
  const out: AgentEnvVariable[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('each `env` entry must be an object');
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    // POSIX environment variable grammar. A name outside it cannot be exported
    // to a subprocess reliably, and `:` would break the vault key's own shape.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`env variable name "${name}" must match [A-Za-z_][A-Za-z0-9_]*`);
    }
    if (seen.has(name)) throw new Error(`duplicate env variable "${name}"`);
    seen.add(name);
    const from = typeof e.from === 'string' ? e.from.toLowerCase().trim() : '';
    if (from !== 'params' && from !== 'vault') {
      throw new Error(`env variable "${name}" needs \`from: params\` or \`from: vault\``);
    }
    if (from !== 'vault') continue;
    const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim() : undefined;
    out.push({ name, from: 'vault', ...(label ? { label } : {}) });
  }
  return out;
}

/** Sanitize a declared name into a vault-safe slug (`delivery-coder` → `delivery_coder`). */
function agentSlug(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug || /^[0-9]/.test(slug)) return `agent_${slug}`;
  return slug;
}

/** `delivery-coder.agent` → `delivery-coder` (the provisional slug before sanitizing). */
function baseName(rel: string): string {
  const file = rel.split('/').pop() ?? rel;
  return file.replace(/\.agent$/i, '');
}

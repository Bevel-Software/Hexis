import path from 'node:path';
import fs from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { DEFAULT_BRANCH, GROUPS_DIR, LEGACY_SKILLS_DIR } from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { workspaceIdForBranch } from '../workspace/workspace.service.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { extractFrontmatter, resolveDeclaredId, dedupeById } from '../../shared/frontmatter-id.js';
import { walkFiles } from '../../shared/fs-walk.js';
import { TtlCache } from '../../shared/ttl-cache.js';
import type {
  ISkillService,
  GetSkillResult,
  Skill,
  SkillSummary,
} from './skills.contract.js';

const CACHE_TTL_MS = 60_000;

interface ParsedSkill {
  summary: SkillSummary;
  body: string;
  allowedTools?: string[];
  files: string[];
}

/**
 * Reads skills from the DEFAULT-branch workspace (never the caller's branch), so
 * the catalog is one global, released set. Results are cached briefly and on a
 * merge to default the cache should be dropped via `invalidate()`.
 */
export class SkillService implements ISkillService {
  private readonly cache: TtlCache<ParsedSkill[]>;

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

  async listSkills(userEmail?: string): Promise<SkillSummary[]> {
    const skills = await this.scan();
    const summaries = skills.map((s) => s.summary);
    if (!userEmail) return summaries;
    const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
    const allowed = await this.accessControl.canReadBatch(
      wsId,
      userEmail,
      summaries.map((s) => `${s.path}/SKILL.md`),
    );
    // Fail closed: keep a skill only on an explicit `true` verdict — a missing
    // entry counts as denied, matching the KB's default-deny read model (and the
    // tool-manuals catalog). `!== false` would silently EXPOSE a skill any time
    // the checker skips a path.
    return summaries.filter((s) => allowed.get(`${s.path}/SKILL.md`) === true);
  }

  async getSkill(userEmail: string, name: string, file?: string): Promise<GetSkillResult> {
    if (!isSafeName(name)) return { ok: false, error: 'not_found' };
    const found = (await this.scan()).find((s) => s.summary.name === name);
    if (!found) return { ok: false, error: 'not_found' };

    const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
    if (!(await this.accessControl.canRead(wsId, userEmail, `${found.summary.path}/SKILL.md`))) {
      return { ok: false, error: 'forbidden' };
    }

    if (file !== undefined) {
      if (!isSafeRelFile(file)) return { ok: false, error: 'invalid_file' };
      const repoPath = `${found.summary.path}/${file}`;
      try {
        const content = await this.workspaceService.readFile(wsId, `${this.kbDirName}/${repoPath}`);
        return { ok: true, kind: 'file', file: { name, file, path: repoPath, content } };
      } catch {
        return { ok: false, error: 'not_found' };
      }
    }

    const skill: Skill = {
      ...found.summary,
      body: found.body,
      allowedTools: found.allowedTools,
      files: found.files,
    };
    return { ok: true, kind: 'skill', skill };
  }

  // --- internal ---------------------------------------------------------------

  private async scan(): Promise<ParsedSkill[]> {
    const cached = this.cache.get();
    if (cached) return cached;
    const skills = await this.scanDisk();
    this.cache.set(skills);
    return skills;
  }

  private async scanDisk(): Promise<ParsedSkill[]> {
    // Ensure the default-branch clone exists, then scan its Skills/ dir. Any
    // failure (no workspace, no Skills/ dir) degrades to an empty catalog — the
    // manual/tools must never break because skills can't be read.
    let wsId: string;
    try {
      wsId = (await this.workspaceService.getOrCreateForBranch(DEFAULT_BRANCH)).id;
    } catch {
      return [];
    }
    const kbRoot = path.join(await this.workspaceService.getWorkspacePath(wsId), this.kbDirName);

    // Skills may be grouped in category subfolders (each carrying its own
    // access.md), so a SKILL.md can live at any depth under the root. Walk the
    // tree and treat every folder that directly contains a SKILL.md as a skill;
    // don't descend past it — its inner files are bundled assets, not nested
    // skills. The skill name is the leaf folder name; its path is the full
    // Skills-relative folder (e.g. `Skills/Development/coding-guidelines`).
    const out: ParsedSkill[] = [];
    const walk = async (dir: string, relFolder: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
        let raw: string;
        try {
          raw = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf-8');
        } catch {
          return;
        }
        const fm = parseSkillFrontmatter(raw);
        // Identity via the shared rule: frontmatter `id` → `name` → folder name.
        // `getSkill()` refuses unsafe names (path separators, `.`/`..`), so a
        // declared id that fails the same check would list but never fetch —
        // fall back to the folder name (a readdir entry, safe by construction)
        // to keep listing and lookup consistent.
        const declared = resolveDeclaredId(fm.frontmatter, path.basename(dir));
        const name = isSafeName(declared) ? declared : path.basename(dir);
        out.push({
          summary: { name, description: fm.description, version: fm.version, path: relFolder },
          body: fm.body,
          allowedTools: fm.allowedTools,
          files: await listBundledFiles(dir, relFolder),
        });
        return; // a skill folder is a leaf — its subfolders hold assets, not skills
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        await walk(path.join(dir, entry.name), `${relFolder}/${entry.name}`);
      }
    };
    // `Groups/` is the merged layout; `Skills/` is read too so the catalog is
    // not empty against a KB that has not migrated yet. A repo has one or the
    // other in practice, and dedupeById below settles it if both exist.
    for (const dir of [GROUPS_DIR, LEGACY_SKILLS_DIR]) {
      await walk(path.join(kbRoot, dir), dir);
    }
    // A skill's id (frontmatter `id`/`name`, else folder name) is how getSkill()
    // resolves it, so it must be unique. Sort by (name, path) for a deterministic
    // winner, then REFUSE later duplicates via the shared dedup — the same rule
    // tools use (no silent auto-suffix that would rebind an id under the caller).
    out.sort(
      (a, b) =>
        a.summary.name.localeCompare(b.summary.name) ||
        a.summary.path.localeCompare(b.summary.path),
    );
    return dedupeById(out, (s) => s.summary.name, (s, id) =>
      console.warn(
        `[skills] skipping "${s.summary.path}": id "${id}" is already used by another skill — ` +
          'give it a unique `id`/`name` in its SKILL.md frontmatter.',
      ),
    );
  }
}

// --- helpers ------------------------------------------------------------------

/** Skill names are folder names; reject anything that could escape the folder. */
function isSafeName(name: string): boolean {
  return name.length > 0 && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..';
}

/** A bundled-file path must stay inside the skill folder. */
function isSafeRelFile(file: string): boolean {
  if (!file || file.includes('\\') || path.isAbsolute(file)) return false;
  return file.split('/').every((seg) => seg.length > 0 && seg !== '..');
}

function scalarToString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function parseSkillFrontmatter(raw: string): {
  description: string;
  version?: string;
  allowedTools?: string[];
  body: string;
  /** The parsed frontmatter object (for shared id resolution: `id`/`name`). */
  frontmatter: Record<string, unknown>;
} {
  const fm = extractFrontmatter(raw);
  if (!fm) return { description: '', body: raw.trimStart(), frontmatter: {} };

  const body = fm.body.trimStart();
  let data: Record<string, unknown> = {};
  try {
    // Resilient: `toJS` returns the best-effort value even if some entry is
    // malformed, so one bad field never drops the rest.
    const parsed = parseDocument(fm.frontmatter).toJS();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    /* keep empty metadata */
  }

  const description = typeof data.description === 'string' ? data.description.trim() : '';
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  const version = scalarToString(data.version) ?? scalarToString(metadata.version);

  // `allowed-tools` is a space-separated string (agentskills) or a YAML list.
  const at = data['allowed-tools'];
  const allowedTools = Array.isArray(at)
    ? at.map((t) => String(t))
    : typeof at === 'string'
      ? at.split(/\s+/).filter(Boolean)
      : undefined;

  return { description, version, allowedTools, body, frontmatter: data };
}

/** Repo-root-relative paths of every bundled file under a skill folder (excludes SKILL.md). */
async function listBundledFiles(dir: string, relFolder: string): Promise<string[]> {
  return (await walkFiles(dir, () => true))
    .filter((rel) => rel !== 'SKILL.md')
    .map((rel) => `${relFolder}/${rel}`);
}

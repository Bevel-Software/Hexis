import path from 'node:path';
import { logger } from '../../shared/logging.js';

const log = logger('skills');
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import type { KbContext } from '../../shared/kb-context.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import { extractFrontmatter, resolveDeclaredId, dedupeById } from '../../shared/frontmatter-id.js';
import type { IgnoreRules, ITreeWalker } from '../../shared/fs.contract.js';
import { TtlCache } from '../../shared/ttl-cache.js';
import type {
  GetSkillOptions,
  ISkillService,
  ListSkillsOptions,
  GetSkillResult,
  Skill,
  SkillHistorySource,
  SkillSummary,
} from './skills.contract.js';

const CACHE_TTL_MS = 60_000;

/**
 * How far back a `version` is looked for: commits of the skill's `SKILL.md`,
 * newest first. Bounded because each commit costs one read of the file at
 * that commit; a skill's own history is short, and a version older than two
 * hundred edits of one file is one nobody is going to ask an agent for.
 */
const VERSION_HISTORY_LIMIT = 200;

interface ParsedSkill {
  summary: SkillSummary;
  body: string;
  allowedTools?: string[];
  files: string[];
}

/**
 * One branch's skills and where they were read from. The workspace rides along
 * because every later question — may this caller read the skill, what does its
 * folder contain, what is in its history — has to be asked of the SAME clone
 * the skills were scanned out of, never of whichever branch happens to be the
 * default.
 */
interface Catalog {
  wsId: string;
  /** Absolute path of that workspace's KB clone; empty when there was none to read. */
  kbRoot: string;
  skills: ParsedSkill[];
  /**
   * Folder digests computed out of THIS catalog's clone, by skill folder —
   * filled lazily by `digestOf`, so it lives exactly as long as the catalog
   * does. On the released catalog that is the cache's TTL (and a merge to
   * default drops both together); on a branch catalog, which is never cached,
   * it is one call.
   */
  digests: Map<string, Promise<string | null>>;
}

/**
 * Reads skills from the DEFAULT-branch workspace, so the catalog is one global,
 * released set. Results are cached briefly and on a merge to default the cache
 * should be dropped via `invalidate()`.
 *
 * A caller may instead NAME a branch (`branch` on either method) and read the
 * skills as they are on that draft — what an agent needs to try a skill it has
 * just written, before anyone has approved it. That read is deliberately
 * austere: no cache (the draft changes under the agent's own hands), access
 * judged in that branch's own clone with that branch's rules, a 404 for a
 * branch nobody pushed, and everything the default branch does not already
 * serve marked `unmerged` — with one line at the top of a body saying it is
 * not approved.
 */
export class SkillService implements ISkillService {
  private readonly cache: TtlCache<Catalog>;
  /**
   * Where a `version` is read from — git, attached by the composition root
   * once the git service exists (it is built after this one). Without it a
   * `version` cannot be answered and is reported as not found, listing none.
   */
  private history: SkillHistorySource | null = null;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly accessControl: IAccessControl,
    private readonly kb: KbContext,
    private readonly disk: ITreeWalker,
    now: () => number = Date.now,
  ) {
    this.cache = new TtlCache(CACHE_TTL_MS, now);
  }

  private get kbDirName(): string {
    return this.kb.kbDirName;
  }

  /** Attach the history source a `version` is answered from. */
  setHistory(history: SkillHistorySource): void {
    this.history = history;
  }

  invalidate(): void {
    this.cache.invalidate();
  }

  async listSkills(userEmail?: string, options: ListSkillsOptions = {}): Promise<SkillSummary[]> {
    const { catalog, branch } = await this.catalogFor(options.branch);
    const visible = userEmail ? await this.readableSkills(catalog, userEmail) : catalog.skills;
    if (branch === undefined) return visible.map((s) => s.summary);
    // Marking reads both copies of a folder, so it happens only here, on a
    // branch read that asked for it — the released catalog every other surface
    // takes never pays for it. The released catalog is resolved ONCE for the
    // whole listing: per skill, a cold cache would start one scan of the
    // default branch per skill.
    const released = await this.defaultCatalog();
    return Promise.all(
      visible.map(async (s) =>
        (await this.differs(released, catalog, s)) ? { ...s.summary, unmerged: true as const, branch } : s.summary,
      ),
    );
  }

  async getSkill(
    userEmail: string,
    name: string,
    file?: string,
    options: GetSkillOptions = {},
  ): Promise<GetSkillResult> {
    if (!isSafeSkillName(name)) return { ok: false, error: 'not_found' };
    const { catalog, branch } = await this.catalogFor(options.branch);
    const found = catalog.skills.find((s) => s.summary.name === name);
    // A skill the branch deleted is not a skill as far as this answer goes:
    // the same `not_found` a name nobody ever used gets.
    if (!found) return { ok: false, error: 'not_found' };

    // Through `readable`, not a bare `canRead`: the two gates must never
    // disagree. `canRead` reads a file's own frontmatter rules off disk on
    // every call while `canReadBatch` resolves them through a per-workspace
    // memo, so the same skill at the same instant could be loadable by name
    // and absent from the listing — an author who writes a skill and then
    // lists them not seeing their own work, and an agent discovering by
    // listing unable to find a skill it could load. One resolver, one answer.
    //
    // The price of the shared gate is that this path now reads through that
    // memo rather than off disk, so a SKILL.md that rewrites its own `read:`
    // rules would be authorized against the previous verdict until the memo
    // expires. It is not: `registerCatalogCacheInvalidation` drops the gate on
    // the same default-branch signal that drops this catalog, so the listing
    // and the load are refreshed by one event or by neither. A branch read
    // caches no catalog of its own, so the same pair of gates still answers
    // for it — in that branch's workspace, where its own rules live.
    const allowed = await this.readable(catalog.wsId, userEmail, [found.summary.path]);
    if (allowed.get(`${found.summary.path}/SKILL.md`) !== true) {
      // On the default branch: `forbidden` — the skill is released, everyone
      // knows the catalog has it, and naming the refusal is what sends the
      // caller to ask for access.
      //
      // On a draft: the same answer a name nobody ever used gets. A skill
      // being written on a branch the caller cannot read there is one they
      // must not learn exists either, and the listing already hides it — a
      // load that answered `forbidden` would confirm it by the back door.
      return { ok: false, error: branch === undefined ? 'forbidden' : 'not_found' };
    }

    const result = await this.serve(catalog, found, name, file, options.version);
    if (branch === undefined || !result.ok) return result;
    // The mark and the line say "nobody approved this", so they go on exactly
    // what the default branch does not already serve. A skill the branch never
    // touched IS the released one — read through a draft's clone, but the same
    // bytes — and claiming otherwise would teach agents to ignore the warning.
    if (!(await this.differs(await this.defaultCatalog(), catalog, found))) return result;
    return asUnmerged(result, branch);
  }

  /**
   * The skill (or the one bundled file, or the copy a `version` names) out of
   * the catalog it was found in. Everything the caller is allowed to see has
   * been settled by `getSkill`; this only reads.
   */
  private async serve(
    catalog: Catalog,
    found: ParsedSkill,
    name: string,
    file: string | undefined,
    version: string | undefined,
  ): Promise<GetSkillResult> {
    // A version other than the one on disk now is read out of history —
    // after the access check above, which is the caller's access to the skill
    // as it is now. The version on disk IS the latest, whatever it is called,
    // so asking for it by name answers from disk like asking for nothing.
    const wanted = version?.trim();
    if (wanted !== undefined && wanted.length > 0 && wanted !== found.summary.version) {
      return this.getSkillAtVersion(catalog.wsId, found, name, wanted, file);
    }

    if (file !== undefined) {
      if (!isSafeRelFile(file)) return { ok: false, error: 'invalid_file' };
      const repoPath = `${found.summary.path}/${file}`;
      // Only a file the catalog LISTS is served: the listing already applied
      // the ignore rules, so a path that is not in it is one they hid.
      if (!found.files.includes(repoPath)) return { ok: false, error: 'not_found' };
      try {
        const content = await this.workspaceService.readFile(catalog.wsId, `${this.kbDirName}/${repoPath}`);
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

  /**
   * The skill as it was at the most recent commit of `wsId`'s clone whose
   * `SKILL.md` declared `wanted` — the default branch's history, or a named
   * branch's own — walking that file's history newest first,
   * so a version that was published, superseded and republished answers with
   * its latest copy. Every version the walk met is collected on the way, so
   * a miss can say what there is to ask for.
   *
   * The bundled files come from the tree at that commit, without the ignore
   * rules the live listing applies (those are the rules in force NOW, about a
   * tree that was different then); `SKILL.md` itself is left out as always.
   */
  private async getSkillAtVersion(
    wsId: string,
    found: ParsedSkill,
    name: string,
    wanted: string,
    file: string | undefined,
  ): Promise<GetSkillResult> {
    if (file !== undefined && !isSafeRelFile(file)) return { ok: false, error: 'invalid_file' };
    const history = this.history;
    if (!history) return { ok: false, error: 'version_not_found', versions: [] };
    const folder = found.summary.path;
    const skillMd = `${folder}/SKILL.md`;
    const versions: string[] = [];
    const seen = new Set<string>();
    const shas = await history.pathHistory(wsId, 'HEAD', skillMd, VERSION_HISTORY_LIMIT);
    for (const sha of shas) {
      const raw = await history.readFileAtRef(wsId, sha, skillMd);
      if (raw === null) continue;
      const fm = parseSkillFrontmatter(raw);
      if (fm.version === undefined) continue;
      if (!seen.has(fm.version)) {
        seen.add(fm.version);
        versions.push(fm.version);
      }
      if (fm.version !== wanted) continue;

      const files = (await history.listFilesAtRef(wsId, sha, folder))
        .filter((p) => p !== skillMd)
        .sort();
      if (file !== undefined) {
        const repoPath = `${folder}/${file}`;
        if (!files.includes(repoPath)) return { ok: false, error: 'not_found' };
        const content = await history.readFileAtRef(wsId, sha, repoPath);
        if (content === null) return { ok: false, error: 'not_found' };
        return { ok: true, kind: 'file', file: { name, file, path: repoPath, content } };
      }
      const skill: Skill = {
        ...found.summary,
        description: fm.description,
        version: fm.version,
        body: fm.body,
        allowedTools: fm.allowedTools,
        files,
      };
      return { ok: true, kind: 'skill', skill };
    }
    return { ok: false, error: 'version_not_found', versions };
  }

  /**
   * The ONE read gate both surfaces resolve through, keyed by each skill's
   * `SKILL.md`. Shared so `listSkills` and `getSkill` can only ever give the
   * same verdict about the same skill — see the note at the `getSkill` call.
   *
   * `wsId` is the workspace the skills were READ from, so a branch's answer is
   * judged by the `roles.yaml`, groups and `access.md` tree that branch has —
   * which is the point: a draft may be where a skill's access rules are being
   * changed, and judging it by the default branch's rules would answer about a
   * tree the caller is not reading.
   */
  private async readable(
    wsId: string,
    userEmail: string,
    skillFolders: string[],
  ): Promise<Map<string, boolean>> {
    return this.accessControl.canReadBatch(wsId, userEmail, skillFolders.map((p) => `${p}/SKILL.md`));
  }

  /** The skills of `catalog` this caller may read, by the gate above. */
  private async readableSkills(catalog: Catalog, userEmail: string): Promise<ParsedSkill[]> {
    const allowed = await this.readable(catalog.wsId, userEmail, catalog.skills.map((s) => s.summary.path));
    // Fail closed: keep a skill only on an explicit `true` verdict — a missing
    // entry counts as denied, matching the KB's default-deny read model (and the
    // tool-manuals catalog). `!== false` would silently EXPOSE a skill any time
    // the checker skips a path.
    return catalog.skills.filter((s) => allowed.get(`${s.summary.path}/SKILL.md`) === true);
  }

  /**
   * The catalog an answer comes out of, and the branch to MARK it with —
   * `branch` undefined when the answer is the released one, so every surface
   * that names no branch is answered exactly as it was before this input
   * existed.
   */
  private async catalogFor(branch?: string): Promise<{ catalog: Catalog; branch?: string }> {
    const named = branch?.trim();
    // A blank branch is a missing one, and the safe reading of a missing
    // branch is the released catalog: it serves only approved skills. A name
    // that is REAL but unknown is not reinterpreted that way — it is the 404
    // `readBranch` lets through. Naming the default branch is the same answer
    // as naming nothing, mark included: there is nothing unmerged about it.
    if (!named || named === this.kb.defaultBranch) return { catalog: await this.defaultCatalog() };
    return { catalog: await this.readBranch(named), branch: named };
  }

  private async defaultCatalog(): Promise<Catalog> {
    const cached = this.cache.get();
    if (cached) return cached;
    // Token first: a merge's `invalidate()` can land while the scan is still
    // reading the pre-merge tree, and storing that read afterwards would undo
    // the drop for a full TTL.
    const token = this.cache.begin();
    const catalog = await this.readDefault();
    this.cache.set(catalog, token);
    return catalog;
  }

  /**
   * The default branch's catalog. A workspace that cannot be resolved degrades
   * to an empty one — the manual/tools must never break because skills can't
   * be read. A NAMED branch does not degrade: see `readBranch`.
   */
  private async readDefault(): Promise<Catalog> {
    let wsId: string;
    try {
      wsId = (await this.workspaceService.getOrCreateForBranch(this.kb.defaultBranch)).id;
    } catch {
      return { wsId: this.kb.defaultWorkspaceId(), kbRoot: '', skills: [], digests: new Map() };
    }
    const kbRoot = path.join(await this.workspaceService.getWorkspacePath(wsId), this.kbDirName);
    return { wsId, kbRoot, skills: await this.scanTree(kbRoot), digests: new Map() };
  }

  /**
   * One branch's clone, scanned. Deliberately NOT cached and deliberately NOT
   * degraded:
   *  - no cache, because the caller of a branch read is usually the agent that
   *    just wrote the skill, and a minute-old answer would hide its own work;
   *  - no degrading, because a branch nobody ever pushed must answer the 404
   *    the file tools answer (`BranchNotFoundError`, naming the branch) — an
   *    empty list would read as "that branch has no skills", which is a
   *    different and untrue statement.
   *
   * Resolving the workspace clones the branch on first use, so a call naming a
   * branch for the first time waits for a clone.
   */
  private async readBranch(branch: string): Promise<Catalog> {
    const wsId = (await this.workspaceService.getOrCreateForBranch(branch)).id;
    const kbRoot = path.join(await this.workspaceService.getWorkspacePath(wsId), this.kbDirName);
    return { wsId, kbRoot, skills: await this.scanTree(kbRoot), digests: new Map() };
  }

  /**
   * Does this skill, as the branch has it, differ from the `released` copy —
   * by the content of its FOLDER? It is absent from the released catalog (or
   * listed there at another path), or one of the files the two catalogs list
   * for it differs byte for byte.
   *
   * Reading both folders is the price of saying something true, and it is paid
   * only on a branch read: a skill folder is instructions plus a few assets.
   * A file that cannot be read on either side counts as a difference — unable
   * to prove the branch's copy is the released one, the honest answer is that
   * it is not approved.
   *
   * Both sides go through `digestOf`, so the RELEASED side is read once per
   * cached catalog rather than once per skill per call: a listing of N skills
   * used to re-hash all N released folders on every call, and each `getSkill`
   * re-hashed one of them again.
   */
  private async differs(released: Catalog, branchCatalog: Catalog, skill: ParsedSkill): Promise<boolean> {
    const mirror = released.skills.find((s) => s.summary.name === skill.summary.name);
    if (!mirror || mirror.summary.path !== skill.summary.path) return true;
    const [onBranch, onDefault] = await Promise.all([
      this.digestOf(branchCatalog, skill),
      this.digestOf(released, mirror),
    ]);
    return onBranch === null || onDefault === null || onBranch !== onDefault;
  }

  /**
   * One skill folder's digest in one catalog's clone, computed at most once
   * for that catalog. The folder path is a unique key within a catalog — a
   * folder holds one `SKILL.md`, so it yields one skill — and the file list
   * the digest covers comes from that same catalog's scan.
   *
   * Memoizing means a released folder's ASSETS are now as stale as the rest
   * of the catalog that names them: both are refreshed by the TTL and dropped
   * together by `invalidate()` on a merge to the default branch. A branch
   * catalog is built per call and so is its memo, which is what a draft read
   * needs — the agent's own last write must show.
   */
  private digestOf(catalog: Catalog, skill: ParsedSkill): Promise<string | null> {
    const key = skill.summary.path;
    const memo = catalog.digests.get(key);
    if (memo) return memo;
    // The promise, not the value: skills asked for at once share one read.
    // A rejection is dropped rather than kept — `folderDigest` answers `null`
    // for a file it cannot read, so a throw here is a defect, and holding it
    // would answer with it for the catalog's whole life.
    const pending = folderDigest(catalog.kbRoot, skill);
    catalog.digests.set(key, pending);
    pending.catch(() => catalog.digests.delete(key));
    return pending;
  }

  /** Scan one clone's `Skills/` and `Plugins/` roots into a catalog's skills. */
  private async scanTree(kbRoot: string): Promise<ParsedSkill[]> {
    // Skills may be grouped in category subfolders (each carrying its own
    // access.md), so a SKILL.md can live at any depth under either root. Walk
    // the tree and treat every folder that directly contains a SKILL.md as a
    // skill; don't descend past it — its inner files are bundled assets, not
    // nested skills. The skill name is the leaf folder name; its path is the
    // full repo-relative folder (e.g. `Skills/Engineering/deploy`).
    //
    // `.bevelignore` files INSIDE a root are honoured on the way down, the
    // same layered rules the file tree applies: a repository that carries a
    // build output beside its source (a `dist/` holding compiled copies of
    // every skill) would otherwise list each skill twice and refuse the
    // duplicate — the wrong one, half the time. The REPO-ROOT file is
    // deliberately not consulted: it is where the template hides `Plugins/`
    // from the Knowledge tree, and a rule that hides a root from the browser
    // must not empty the catalog that root exists to feed.
    const out: ParsedSkill[] = [];
    const isSkillFolder = (entries: readonly { name: string; isFile(): boolean }[]) =>
      entries.some((e) => e.isFile() && e.name === 'SKILL.md');
    const disk = this.disk;
    const walkRoot = async (rootRel: string): Promise<void> => {
      await disk.walk(
        path.join(kbRoot, rootRel),
        {
          skip: (e) => e.isDirectory() && e.name.startsWith('.'),
          ignore: true,
          // A skill folder is a LEAF whatever the ignore rules say of it — so
          // judged on what is THERE: a rule naming its SKILL.md suppresses the
          // skill (below), it does not turn the folder's assets into skills of
          // their own.
          leaf: (dir) => isSkillFolder(dir.listed),
        },
        [
          {
            async onDir(rel, entries, { abs: dir, listed, ignore }) {
              if (!isSkillFolder(listed)) return;
              if (!isSkillFolder(entries)) return; // the SKILL.md is ignored: no skill
              const relFolder = rel ? `${rootRel}/${rel}` : rootRel;
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
              const name = isSafeSkillName(declared) ? declared : path.basename(dir);
              out.push({
                summary: {
                  name,
                  description: fm.description,
                  version: fm.version,
                  path: relFolder,
                },
                body: fm.body,
                allowedTools: fm.allowedTools,
                files: await listBundledFiles(disk, dir, relFolder, ignore),
              });
            },
          },
        ],
      );
    };
    // Each root starts its own ignore stack (the walk extends it with the
    // root's own file first). Order is cosmetic: the sort below is by name
    // then path, so a same-named pair resolves the same way regardless.
    const { skillsDir, pluginsDir } = this.kb.layout;
    await walkRoot(skillsDir);
    await walkRoot(pluginsDir);
    // A skill's id (frontmatter `id`/`name`, else folder name) is how getSkill()
    // resolves it, so it must be unique. Sort by (name, root, path) for a
    // deterministic winner — the shared root FIRST, since `Skills/` is a
    // skill's canonical home and a same-named inline copy is the stale one —
    // then REFUSE later duplicates via the shared dedup — the same rule tools
    // use (no silent auto-suffix that would rebind an id under the caller).
    const rootRank = (p: string) => (p === skillsDir || p.startsWith(`${skillsDir}/`) ? 0 : 1);
    out.sort(
      (a, b) =>
        a.summary.name.localeCompare(b.summary.name) ||
        rootRank(a.summary.path) - rootRank(b.summary.path) ||
        a.summary.path.localeCompare(b.summary.path),
    );
    return dedupeById(out, (s) => s.summary.name, (s, id) =>
      log.warn(
        `skipping "${s.summary.path}": id "${id}" is already used by another skill — ` +
          'give it a unique `id`/`name` in its SKILL.md frontmatter.',
      ),
    );
  }
}

// --- helpers ------------------------------------------------------------------

/**
 * The one line a skill read from an unmerged branch begins with. Exported
 * because the tool surface documents it and the tests assert it: there is one
 * sentence, in one place, and an agent that has read it once recognises it.
 */
export function unmergedSkillNotice(branch: string): string {
  return `This skill is read from the unmerged branch "${branch}" and is not approved.`;
}

/**
 * Say, on the answer itself, that it came off a branch that changed this skill.
 *
 * The body gets the line because the body is what an agent reads and acts on;
 * a bundled file gets the flags beside its content, never a sentence inside it
 * (prepending prose to a script is a syntax error, not a warning).
 */
function asUnmerged(result: Extract<GetSkillResult, { ok: true }>, branch: string): GetSkillResult {
  if (result.kind === 'file') {
    return { ...result, file: { ...result.file, unmerged: true, branch } };
  }
  return {
    ...result,
    skill: {
      ...result.skill,
      unmerged: true,
      branch,
      body: `${unmergedSkillNotice(branch)}\n\n${result.skill.body}`,
    },
  };
}

/**
 * A digest of a skill folder as its own catalog lists it: `SKILL.md` plus
 * every bundled file, each hashed under its relative name so a renamed,
 * added or dropped asset is a difference too — and so a file one branch's
 * ignore rules hide is one as well. `null` when a listed file cannot be read,
 * which the caller treats as "cannot prove it is the released copy".
 */
async function folderDigest(kbRoot: string, skill: ParsedSkill): Promise<string | null> {
  if (!kbRoot) return null;
  const folder = skill.summary.path;
  const rels = ['SKILL.md', ...skill.files.map((f) => f.slice(folder.length + 1))].sort();
  const hash = createHash('sha256');
  for (const rel of rels) {
    hash.update(`${rel}\0`);
    try {
      hash.update(await fs.readFile(path.join(kbRoot, folder, ...rel.split('/'))));
    } catch {
      return null;
    }
  }
  return hash.digest('hex');
}

/**
 * Skill names are folder names; reject anything that could escape the folder.
 *
 * Exported because the pending-skill surface resolves a name from a SKILL.md
 * that is not on disk yet and must land on the SAME id the catalog will give it
 * once merged — a second copy of this rule would drift.
 */
export function isSafeSkillName(name: string): boolean {
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

/** The mapping under `key`, or an empty one when there is none (or it is not a mapping). */
function nested(data: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = data[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Exported for the pending-skill surface, which parses a SKILL.md read at a
 * change request's ref rather than off disk. Same parser deliberately: a
 * proposed skill must be described by the same rules that will describe it once
 * it is released, or the card in review and the card after approval disagree.
 */
export function parseSkillFrontmatter(raw: string): {
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
  // `metadata.version` is where the Agent Skills format keeps a version and
  // what the platform writes; a top-level `version` and `lifecycle.version`
  // (other conventions a skill may arrive with) are read when it is absent.
  const version =
    scalarToString(nested(data, 'metadata').version) ??
    scalarToString(data.version) ??
    scalarToString(nested(data, 'lifecycle').version);

  // `allowed-tools` is a space-separated string (agentskills) or a YAML list.
  const at = data['allowed-tools'];
  const allowedTools = Array.isArray(at)
    ? at.map((t) => String(t))
    : typeof at === 'string'
      ? at.split(/\s+/).filter(Boolean)
      : undefined;

  return { description, version, allowedTools, body, frontmatter: data };
}

/**
 * Repo-root-relative paths of every bundled file under a skill folder
 * (excludes SKILL.md), under the same ignore rules the walk applied on the
 * way down — a rule in the skill's own `.bevelignore` or any folder above
 * hides an asset from the listing, and therefore (see `getSkill`) from
 * being served.
 */
async function listBundledFiles(disk: ITreeWalker, dir: string, relFolder: string, rules: IgnoreRules): Promise<string[]> {
  const rels: string[] = [];
  await disk.walkKb(
    dir,
    [
      {
        onFile(sub, name) {
          if (sub || name !== 'SKILL.md') rels.push(sub ? `${sub}/${name}` : name);
        },
      },
    ],
    // `rules` are those in force in the skill folder itself; the walk layers
    // its own file once more (a no-op) and any deeper one on the way down.
    { ignore: rules },
  );
  return rels.sort().map((rel) => `${relFolder}/${rel}`);
}

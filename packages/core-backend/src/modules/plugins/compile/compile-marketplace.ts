import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PLUGINS_DIR,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
  PLUGIN_MANIFEST_SCHEMA,
  PLUGIN_MCP_SCHEMA,
  SKILLS_DIR,
  pluginManifestName,
  pluginOfPath,
} from '@bevel-software/platform-shared';
import { walkFiles } from '../../../shared/fs-walk.js';
import { containsVariableReference } from '../../../shared/variable-refs.js';
import type { SkillSummary } from '../../skills/skills.contract.js';
import type { LinkMembership } from '../plugin-links.js';

/**
 * The compiler: SOURCE layout in, DISTRIBUTION layout out.
 *
 * Source is what lives in the knowledge base — shared skills under
 * `Skills/`, plugin folders under `Plugins/` whose manifests LINK to them.
 * Distribution is what an agent installs: a marketplace of self-contained
 * plugins, each physically holding its skills (Claude Code refuses paths
 * that escape a plugin's directory, and symlinks are out), in the vendor
 * layouts the clients read today — `.claude-plugin/plugin.json`,
 * `.codex-plugin/plugin.json`, `.mcp.json` — beside the Agent Plugins
 * `plugin.json` and `mcp.json`.
 *
 * What comes out, for one caller:
 *
 *   .claude-plugin/marketplace.json      Claude Code's catalogue
 *   .agents/plugins/marketplace.json     Codex's catalogue, every entry
 *                                        INSTALLED_BY_DEFAULT
 *   plugins/<slug>/…                     one per plugin the caller may read
 *                                        anything of: inline + linked skills,
 *                                        the portable half of mcp.json
 *   plugins/skills-<scope>/…             one per top-level Skills/ folder, so
 *                                        standalone skills are installable
 *   plugins/hexis-all/…                  a bundle whose only content is a
 *                                        dependency on every plugin above —
 *                                        Claude Code installs them all from
 *                                        one `claude plugin install`
 *   skills/<name>/…                      every readable skill once, flat, for
 *                                        `npx skills add <url> --all`
 *   README.md                            names the source commit
 *
 * FAIL CLOSED, per file: a skill is copied only when `readable` says yes for
 * its SKILL.md — the same per-path verdict the catalog filters on — so the
 * compiled tree for a caller holds exactly what that caller may read, and
 * nothing about a skill they may not. Plugins with nothing readable are
 * left out entirely. `access.md` and `.bevelignore` never ship; neither do
 * the hexis-only `.tool` manuals (no other client can run them), nor an
 * `mcp.json` header carrying a `${VAR}` vault reference (the extension block
 * that resolves it is ours, and a header a client would send verbatim must
 * not name a secret it cannot expand).
 *
 * A pure function of its inputs — it reads the KB tree it is pointed at and
 * returns a virtual tree; writing it somewhere (a git namespace, a folder, a
 * remote) is the sink's business.
 */

export interface MarketplaceOptions {
  /** The marketplace's name — a slug the clients key it on. */
  name: string;
  /** Shown as the marketplace owner. */
  owner: string;
  description?: string;
  /** The default-branch commit the tree was compiled from; also the bundle's version. */
  sourceCommit: string;
  /** The name of the one-install bundle plugin. */
  bundleName?: string;
}

export interface CompileInput {
  /** Absolute path of the KB checkout (the folder holding `Plugins/`, `Skills/`, …). */
  kbRoot: string;
  /** The released catalog, UNFILTERED — `readable` does the filtering. */
  skills: SkillSummary[];
  /** Which plugins hold which skills, from the link index. */
  membership: LinkMembership;
  /** The caller's read verdict on a repo-relative path (`<skillFolder>/SKILL.md`). */
  readable: (repoPath: string) => Promise<boolean>;
  options: MarketplaceOptions;
}

export interface VirtualTree {
  /** repo-relative POSIX path → file bytes. */
  files: Map<string, Buffer>;
  /** What was left out and why — name clashes, unparsable manifests. */
  warnings: string[];
  /** The plugin slugs the tree carries, in marketplace order. */
  plugins: string[];
}

const BUNDLE_NAME = 'hexis-all';
const NEVER_SHIPPED = new Set(['access.md', '.bevelignore']);

export async function compileMarketplace(input: CompileInput): Promise<VirtualTree> {
  const { kbRoot, skills, membership, readable, options } = input;
  const files = new Map<string, Buffer>();
  const warnings: string[] = [];
  const put = (rel: string, content: string | Buffer) =>
    files.set(rel, typeof content === 'string' ? Buffer.from(content, 'utf-8') : content);

  // One verdict per skill, resolved once: every plugin below reads from it.
  const readableSkills = new Map<string, SkillSummary>();
  for (const s of skills) {
    if (await readable(`${s.path}/SKILL.md`)) readableSkills.set(s.path, s);
  }

  interface PluginOut {
    slug: string;
    displayName: string;
    description?: string;
    version?: string;
    skills: SkillSummary[];
    /** Source folder for mcp.json (real plugins only). */
    folder?: string;
  }
  const out: PluginOut[] = [];

  // 1. Real plugins: inline skills (in the folder) + linked skills (from the
  //    manifest), each only if readable.
  for (const [folder, links] of [...membership.byPlugin.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const manifest = await readJson(path.join(kbRoot, PLUGINS_DIR, folder, PLUGIN_MANIFEST_FILE));
    if (manifest === undefined) {
      warnings.push(`${PLUGINS_DIR}/${folder}/${PLUGIN_MANIFEST_FILE} is not valid JSON — plugin skipped`);
      continue;
    }
    const inline = [...readableSkills.values()].filter((s) => pluginOfPath(s.path) === folder);
    const linked = links.linkedSkills
      .map((p) => readableSkills.get(p))
      .filter((s): s is SkillSummary => s !== undefined);
    const dedup = dedupeByName([...inline, ...linked], (s, other) =>
      warnings.push(
        `${folder}: skill "${s.name}" at ${s.path} shares its name with ${other.path} — the second is left out`,
      ),
    );
    const mcp = await portableMcp(path.join(kbRoot, PLUGINS_DIR, folder, PLUGIN_MCP_FILE));
    if (dedup.length === 0 && mcp === null) continue; // nothing this caller may see
    const slug = typeof manifest?.name === 'string' && manifest.name ? manifest.name : pluginManifestName(folder);
    out.push({
      slug,
      displayName: folder,
      description: typeof manifest?.description === 'string' ? manifest.description : undefined,
      version: typeof manifest?.version === 'string' ? manifest.version : undefined,
      skills: dedup,
      folder,
    });
    if (mcp !== null) {
      const text = `${JSON.stringify({ $schema: PLUGIN_MCP_SCHEMA, mcpServers: mcp }, null, 2)}\n`;
      put(`plugins/${slug}/${PLUGIN_MCP_FILE}`, text);
      put(`plugins/${slug}/.mcp.json`, `${JSON.stringify({ mcpServers: mcp }, null, 2)}\n`);
    }
  }

  // 2. Synthetic scope plugins: one per top-level folder under Skills/, holding
  //    every readable skill beneath it — how a skill in no plugin gets installed.
  const byScope = new Map<string, SkillSummary[]>();
  for (const s of readableSkills.values()) {
    const segments = s.path.split('/');
    if (segments[0] !== SKILLS_DIR) continue;
    // `Skills/<skill>` (no scope folder) lands in the root scope.
    const scope = segments.length > 2 ? segments[1] : '';
    byScope.set(scope, [...(byScope.get(scope) ?? []), s]);
  }
  for (const [scope, list] of [...byScope.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const slug = scope ? `skills-${pluginManifestName(scope)}` : 'skills';
    if (out.some((p) => p.slug === slug)) {
      warnings.push(`scope plugin "${slug}" collides with a plugin's manifest name — scope skipped`);
      continue;
    }
    out.push({
      slug,
      displayName: scope ? `Skills · ${scope}` : 'Skills',
      description: scope ? `Every shared skill under ${SKILLS_DIR}/${scope}` : `Shared skills at the ${SKILLS_DIR} root`,
      skills: dedupeByName(list, (s, other) =>
        warnings.push(`${slug}: "${s.name}" at ${s.path} shares its name with ${other.path} — left out`),
      ),
    });
  }

  // 3. Materialise every plugin: the three manifests + copied skill folders.
  for (const p of out) {
    const base = `plugins/${p.slug}`;
    const spec: Record<string, unknown> = { $schema: PLUGIN_MANIFEST_SCHEMA, name: p.slug };
    if (p.version) spec.version = p.version;
    if (p.description) spec.description = p.description;
    put(`${base}/${PLUGIN_MANIFEST_FILE}`, `${JSON.stringify(spec, null, 2)}\n`);
    const vendor: Record<string, unknown> = { name: p.slug };
    if (p.version) vendor.version = p.version;
    vendor.description = p.description ?? p.displayName;
    put(`${base}/.claude-plugin/plugin.json`, `${JSON.stringify(vendor, null, 2)}\n`);
    put(`${base}/.codex-plugin/plugin.json`, `${JSON.stringify(vendor, null, 2)}\n`);
    for (const s of p.skills) {
      await copySkill(kbRoot, s, `${base}/skills/${s.name}`, put);
    }
  }

  // 4. The one-install bundle: a Claude manifest with nothing but dependencies.
  const bundle = options.bundleName ?? BUNDLE_NAME;
  const slugs = out.map((p) => p.slug);
  if (slugs.length > 0) {
    const shortSha = options.sourceCommit.slice(0, 12) || '0';
    const description = `Everything in ${options.owner}'s marketplace you may read — one install.`;
    put(
      `plugins/${bundle}/.claude-plugin/plugin.json`,
      `${JSON.stringify({ name: bundle, version: `0.0.0-${shortSha}`, description, dependencies: slugs }, null, 2)}\n`,
    );
    put(
      `plugins/${bundle}/${PLUGIN_MANIFEST_FILE}`,
      `${JSON.stringify({ $schema: PLUGIN_MANIFEST_SCHEMA, name: bundle, description }, null, 2)}\n`,
    );
    put(
      `plugins/${bundle}/.codex-plugin/plugin.json`,
      `${JSON.stringify({ name: bundle, description }, null, 2)}\n`,
    );
  }

  // 5. The flat root skills/ folder, every readable skill once.
  const flat = dedupeByName(
    [...readableSkills.values()].sort((a, b) => a.path.localeCompare(b.path)),
    (s, other) => warnings.push(`skills/: "${s.name}" at ${s.path} shares its name with ${other.path} — left out`),
  );
  for (const s of flat) await copySkill(kbRoot, s, `skills/${s.name}`, put);

  // 6. The two catalogues + a README naming the source.
  const entries = [...out.map((p) => ({ slug: p.slug, description: p.description ?? p.displayName })), ...(slugs.length ? [{ slug: bundle, description: 'Everything you may read, one install' }] : [])];
  put(
    '.claude-plugin/marketplace.json',
    `${JSON.stringify(
      {
        name: options.name,
        owner: { name: options.owner },
        ...(options.description ? { description: options.description } : {}),
        plugins: entries.map((e) => ({ name: e.slug, source: `./plugins/${e.slug}`, description: e.description })),
      },
      null,
      2,
    )}\n`,
  );
  put(
    '.agents/plugins/marketplace.json',
    `${JSON.stringify(
      {
        name: options.name,
        plugins: entries.map((e) => ({
          name: e.slug,
          source: { source: 'local', path: `./plugins/${e.slug}` },
          policy: { installation: 'INSTALLED_BY_DEFAULT' },
          description: e.description,
        })),
      },
      null,
      2,
    )}\n`,
  );
  put(
    'README.md',
    [
      `# ${options.name}`,
      '',
      `Compiled from ${options.owner}'s knowledge base at commit \`${options.sourceCommit}\`.`,
      'This tree is generated: edit the knowledge base, not these files.',
      '',
      `Plugins: ${entries.map((e) => e.slug).join(', ') || 'none'}.`,
      '',
    ].join('\n'),
  );

  return { files, warnings, plugins: entries.map((e) => e.slug) };
}

// --- helpers ------------------------------------------------------------------

/** Copy a skill folder (minus what never ships) under `dest`. */
async function copySkill(
  kbRoot: string,
  skill: SkillSummary,
  dest: string,
  put: (rel: string, content: Buffer) => void,
): Promise<void> {
  const abs = path.join(kbRoot, skill.path);
  for (const rel of await walkFiles(abs, (name) => !NEVER_SHIPPED.has(name))) {
    put(`${dest}/${rel}`, await fs.readFile(path.join(abs, rel)));
  }
}

/** First by (name, path) order wins; the loser is reported to `onClash`. */
function dedupeByName(
  list: SkillSummary[],
  onClash: (loser: SkillSummary, winner: SkillSummary) => void,
): SkillSummary[] {
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  const seen = new Map<string, SkillSummary>();
  const out: SkillSummary[] = [];
  for (const s of sorted) {
    const winner = seen.get(s.name);
    if (winner) {
      if (winner.path !== s.path) onClash(s, winner);
      continue;
    }
    seen.set(s.name, s);
    out.push(s);
  }
  return out;
}

/**
 * The portable half of a plugin's mcp.json: transport, url, command, args,
 * env, cwd, and only those headers a client may send verbatim (no `${VAR}`
 * vault references). Null when the file is absent or holds no server.
 */
async function portableMcp(abs: string): Promise<Record<string, Record<string, unknown>> | null> {
  const parsed = await readJson(abs);
  if (!parsed || typeof parsed.mcpServers !== 'object' || parsed.mcpServers === null) return null;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, raw] of Object.entries(parsed.mcpServers as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const server = raw as Record<string, unknown>;
    const entry: Record<string, unknown> = {};
    for (const key of ['type', 'url', 'command', 'args', 'env', 'cwd'] as const) {
      if (server[key] !== undefined) entry[key] = server[key];
    }
    if (typeof server.headers === 'object' && server.headers !== null) {
      const headers: Record<string, string> = {};
      for (const [h, v] of Object.entries(server.headers as Record<string, unknown>)) {
        if (typeof v === 'string' && !containsVariableReference(v)) headers[h] = v;
      }
      if (Object.keys(headers).length > 0) entry.headers = headers;
    }
    if (typeof entry.url === 'string' && containsVariableReference(entry.url)) continue; // ours to expand, not theirs
    out[name] = entry;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Parsed JSON object; `null` when absent; `undefined` when present but unparsable. */
async function readJson(abs: string): Promise<Record<string, unknown> | null | undefined> {
  let text: string;
  try {
    text = await fs.readFile(abs, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

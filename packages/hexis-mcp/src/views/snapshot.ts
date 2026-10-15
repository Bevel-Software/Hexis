/**
 * The knowledge snapshot an HTML knowledge view renders from, built live.
 *
 * A view written with the `html-knowledge-view` skill carries a snapshot of
 * the nodes it shows (`<script id="kb-snapshot">`), and records in it how that
 * snapshot was chosen: which folders were mirrored, which NodeTypes and fields
 * were kept. Inside the Bevel app the page swaps the snapshot for the live
 * graph; everywhere else it stays as old as its last rebuild.
 *
 * This module is how a view shown OUTSIDE the app gets live data too. It reads
 * the same files the skill's `mirror.chain.js` reads, through the caller's own
 * KB tools (so the caller's read access decides what comes back), and parses
 * them exactly as the skill's `build_snapshot.py` does, which is itself a port
 * of the platform's markdown parser. The output is the same
 * `hexis-kb-snapshot/1` wire format, so the page's render code cannot tell the
 * difference.
 */

import { extractFrontmatter } from '@bevel-software/platform-shared';

export const SNAPSHOT_FORMAT = 'hexis-kb-snapshot/1';

/** How a page's snapshot was mirrored: the `CONFIG` of `mirror.chain.js`. */
export interface MirrorConfig {
  branch?: string;
  page?: string;
  dirs?: string[];
  deep?: boolean;
  paths?: string[];
  types?: string[];
  fields?: string[];
}

/** The flags that chose a snapshot's content (`selection` in the snapshot). */
export interface Selection {
  type?: string[];
  prefix?: string[];
  glob?: string[];
  node?: string[];
  with_neighbors?: boolean;
  fields?: string;
  keep_soi?: boolean;
  file?: string[];
  exclude?: string[];
  keep_restricted?: string[];
  mirror?: MirrorConfig;
}

export interface WireField {
  text?: string;
  links?: { text: string; path: string }[];
  sourceOfInformation?: SoiEntry[];
  children?: Record<string, WireField>;
}

export interface WireNode {
  node_type: string;
  id: string | null;
  owner: string | null;
  file_path: string;
  fields: Record<string, WireField>;
  links: Record<string, { text: string; path: string }[]>;
}

export interface Snapshot {
  format: string;
  takenAt: string;
  branch: string;
  nodes: Record<string, WireNode>;
  edges: { source: string; target: string; label: string; category: string }[];
  files: Record<string, { text: string }>;
  withheld: number;
  selection: Selection;
  keptRestricted: string[];
}

/** The two reads a mirror needs, against repo paths (no `knowledge-base/` prefix). */
export interface KbReader {
  list(path: string): Promise<{ name: string; type: string }[]>;
  read(path: string): Promise<string>;
}

// Regexes mirror build_snapshot.py one for one (which mirrors parser.ts).
const LINK_RE = /\[([^\]]*)\]\((?:<([^<>\n]+\.md)>|((?:[^()]|\([^()]*\))+?\.md))\)/g;
const ID_LINK_RE = /\[([^\]]*)\]\(([^)\s/:#.]+)\)/g;
const NODETYPE_RE = /^nodeType:\s*["']?\[([^\]]+)\]\(([^)]+)\)["']?\s*$/;
const ID_RE = /^id:\s*["']?([^"'\s]+)["']?\s*$/;
const OWNER_RE = /^owner:\s*["']?(.*?)["']?\s*$/;
const HEADER_RE = /^(#{1,6})\s+(.+)$/;
const PARAMS_RE = /^(.+?)\s*\(([^)]+)\)\s*$/;
const NODETYPE_PATH_RE = /(?:^|\/)NodeTypes\/[^/]+\.md$/;
const KNOWLEDGE_PATH_RE = /(?:^|\/)Knowledge\/.*\.md$/;
const SOI_EMDASH = /^\d+\.\s+(.+?)\s+\u2014\s+(.+?)\s+\((\d{4}-\d{2}-\d{2})\)\s*$/;
const SOI_HYPHEN = /^\d+\.\s+(.+?)\s+-\s+(.+?)\s+\((\d{4}-\d{2}-\d{2})\)\s*$/;

const splitLines = (text: string): string[] => {
  const lines = text.split(/\r\n|\r|\n/);
  // Python's splitlines() drops the empty string after a trailing newline.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
};
const stem = (p: string): string => {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
};

export function resolveLink(rel: string, sourceFile: string): string {
  const out = sourceFile.split('/').slice(0, -1);
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return rel; // would escape the repo root
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join('/');
}

interface Link {
  text: string;
  path: string;
  _id: string | null;
}

function extractLinks(text: string, sourceFile: string): Link[] {
  const links: Link[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const rel = (m[2] ?? m[3] ?? '').replace(/\\/g, '/');
    links.push({ text: m[1] ?? '', path: resolveLink(rel, sourceFile), _id: null });
  }
  for (const m of text.matchAll(ID_LINK_RE)) {
    links.push({ text: m[1] ?? '', path: '', _id: m[2] ?? null });
  }
  return links;
}

interface Frontmatter {
  typeName: string;
  typeLink: string;
  id: string | null;
  owner: string | null;
  /** The lines after the closing fence. */
  body: string[];
}

/**
 * A node's frontmatter: split off by the platform's one splitter
 * (platform-shared `extractFrontmatter`, the fence rule every reader asks),
 * then read for the three keys a snapshot carries.
 */
function parseFrontmatter(text: string): Frontmatter | null {
  const split = extractFrontmatter(text);
  if (!split) return null;
  let nt: RegExpMatchArray | null = null;
  let id: string | null = null;
  let owner: string | null = null;
  for (const raw of splitLines(split.frontmatter)) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if (nt === null && (m = line.match(NODETYPE_RE))) {
      nt = m;
      continue;
    }
    if (id === null && (m = line.match(ID_RE))) {
      id = m[1] || null;
      continue;
    }
    if (owner === null && (m = line.match(OWNER_RE))) owner = m[1] || null;
  }
  if (nt === null) return null;
  return { typeName: nt[1]!, typeLink: nt[2]!, id, owner, body: splitLines(split.body) };
}

/** Field name without its parameters, and its link category if any. */
function headerParams(raw: string): [string, string | null] {
  const m = raw.match(PARAMS_RE);
  if (!m) return [raw.trim(), null];
  let category: string | null = null;
  for (const p of m[2]!.split(',').map((x) => x.trim().toLowerCase())) {
    if (p.startsWith('link ')) category = p.slice(5).trim();
    else if (p === 'link') category = 'outbound';
  }
  return [m[1]!.trim(), category];
}

type SoiEntry = { source: string; validates: string; date: string; tier?: string } | { raw: string };

function soiTier(source: string): string | null {
  const s = source.trim();
  if (/^binding\b/i.test(s)) return 'binding-data';
  if (/<[^<>@\s]+@[^<>\s]+>/.test(s)) return null; // a person; the app refines it
  return 'data-source';
}

function extractSoi(lines: string[]): [SoiEntry[] | null, string[]] {
  const kept: string[] = [];
  let soi: SoiEntry[] | null = null;
  let i = 0;
  while (i < lines.length) {
    if (!/<details\b/i.test(lines[i]!)) {
      kept.push(lines[i]!);
      i += 1;
      continue;
    }
    let close = -1;
    for (let j = i; j < lines.length; j += 1) {
      if (/<\/details>/i.test(lines[j]!)) {
        close = j;
        break;
      }
    }
    if (close === -1) {
      kept.push(lines[i]!);
      i += 1;
      continue;
    }
    const region = lines.slice(i, close + 1);
    const isInfo = region.some((l) => /<summary[^>]*>[^<]*source of information/i.test(l));
    if (isInfo && soi === null) {
      soi = [];
      for (const l of region) {
        const t = l.trim();
        if (!t || /^<\/?(?:details|summary)\b/i.test(t)) continue;
        const m = t.match(SOI_EMDASH) ?? t.match(SOI_HYPHEN);
        if (m) {
          const entry: SoiEntry = { source: m[1]!.trim(), validates: m[2]!.trim(), date: m[3]! };
          const tier = soiTier(entry.source);
          if (tier) entry.tier = tier;
          soi.push(entry);
        } else {
          soi.push({ raw: t });
        }
      }
    } else {
      kept.push(...region);
    }
    i = close + 1;
  }
  return [soi, kept];
}

interface Field {
  text: string;
  links: Link[];
  children: Record<string, Field>;
  sourceOfInformation: SoiEntry[] | null;
}

const newField = (): Field => ({ text: '', links: [], children: {}, sourceOfInformation: null });

function parseFields(lines: string[], sourceFile: string): Record<string, Field> {
  const root: Record<string, Field> = {};
  let stack: [number, Field][] = [];
  let current: Field | null = null;
  let textLines: string[] = [];
  const flush = (): void => {
    if (current === null) return;
    const [soi, kept] = extractSoi(textLines);
    current.sourceOfInformation = soi;
    current.text = kept.join('\n').trim();
    current.links = extractLinks(current.text, sourceFile);
  };
  for (const line of lines) {
    const hm = line.trim().match(HEADER_RE);
    if (!hm) {
      textLines.push(line);
      continue;
    }
    flush();
    textLines = [];
    const level = hm[1]!.length;
    const [name] = headerParams(hm[2]!.trim());
    const field = newField();
    if (level === 1) {
      root[name] = field;
      stack = [[level, field]];
    } else {
      while (stack.length && stack[stack.length - 1]![0] >= level) stack.pop();
      (stack.length ? stack[stack.length - 1]![1].children : root)[name] = field;
      stack.push([level, field]);
    }
    current = field;
  }
  flush();
  return root;
}

/** Top-level field name -> link category, for one NodeType definition. */
function parseNodeType(text: string): Record<string, string | null> | null {
  const fm = parseFrontmatter(text);
  if (!fm || fm.typeName !== 'NodeType') return null;
  const categories: Record<string, string | null> = {};
  for (const line of fm.body) {
    const hm = line.trim().match(HEADER_RE);
    if (hm && hm[1]!.length === 1) {
      const [name, category] = headerParams(hm[2]!.trim());
      categories[name] = category;
    }
  }
  return categories;
}

function allLinks(field: Field): Link[] {
  const out = [...field.links];
  for (const child of Object.values(field.children)) out.push(...allLinks(child));
  return out;
}

interface ParsedNode {
  node_type: string;
  id: string | null;
  owner: string | null;
  file_path: string;
  fields: Record<string, Field>;
  links: Record<string, Link[]>;
}

export function parseGraph(files: Record<string, string>): Record<string, ParsedNode> {
  const types: Record<string, Record<string, string | null>> = {};
  for (const [rel, text] of Object.entries(files)) {
    if (NODETYPE_PATH_RE.test(rel) && stem(rel) !== 'NodeType') {
      const parsed = parseNodeType(text);
      if (parsed) types[rel] = parsed;
    }
  }

  const nodes: Record<string, ParsedNode> = {};
  for (const rel of Object.keys(files).filter((p) => KNOWLEDGE_PATH_RE.test(p)).sort()) {
    const fm = parseFrontmatter(files[rel]!);
    if (!fm) continue;
    const typePath = resolveLink(fm.typeLink.replace(/\\/g, '/'), rel);
    const fields = parseFields(fm.body, rel);
    const definition = types[typePath];
    const links: Record<string, Link[]> = {};
    for (const [fname, field] of Object.entries(fields)) {
      const category = (definition ? definition[fname] : null) || 'outbound';
      const found = allLinks(field);
      if (found.length) (links[category] ??= []).push(...found);
    }
    nodes[rel] = { node_type: fm.typeName, id: fm.id, owner: fm.owner, file_path: rel, fields, links };
  }

  const index = new Map<string, string>();
  for (const [rel, node] of Object.entries(nodes)) {
    if (node.id && !index.has(node.id)) index.set(node.id, rel);
  }
  const resolveIds = (field: Field): void => {
    for (const link of field.links) if (link._id !== null) link.path = index.get(link._id) ?? '';
    for (const child of Object.values(field.children)) resolveIds(child);
  };
  for (const node of Object.values(nodes)) {
    for (const field of Object.values(node.fields)) resolveIds(field);
    for (const bucket of Object.values(node.links)) {
      for (const link of bucket) if (link._id !== null) link.path = index.get(link._id) ?? '';
    }
  }
  return nodes;
}

function edgesBetween(nodes: Record<string, ParsedNode>, keep: Set<string>): Snapshot['edges'] {
  const seen = new Set<string>();
  const edges: Snapshot['edges'] = [];
  for (const rel of [...keep].sort()) {
    for (const [category, bucket] of Object.entries(nodes[rel]!.links)) {
      for (const link of bucket) {
        if (!keep.has(link.path)) continue;
        const [src, tgt] = category === 'inbound' || category === 'parent' ? [link.path, rel] : [rel, link.path];
        const key = JSON.stringify([src, tgt, link.text]);
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source: src, target: tgt, label: link.text, category });
      }
    }
  }
  return edges;
}

/** The `Field.toDict()` shape: empty members are omitted, like the app's. */
function toWire(field: Field, keepSoi: boolean): WireField {
  const out: WireField = {};
  if (field.text) out.text = field.text;
  const links = field.links.map((l) => ({ text: l.text, path: l.path }));
  if (links.length) out.links = links;
  if (keepSoi && field.sourceOfInformation && field.sourceOfInformation.length) {
    out.sourceOfInformation = field.sourceOfInformation;
  }
  const children = Object.entries(field.children);
  if (children.length) out.children = Object.fromEntries(children.map(([k, v]) => [k, toWire(v, keepSoi)]));
  return out;
}

/** fnmatch-style glob, where `*` crosses `/` as Python's does. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        let body = glob.slice(i + 1, end);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const stripKbDir = (p: string): string => p.replace(/^\/+/, '').replace(/^knowledge-base\//, '');

/**
 * Choose the nodes a snapshot keeps. LIVE, so `exclude` is ignored: the skill
 * excludes a node from the embedded snapshot because it must "show only live",
 * and this is the live read, made with the caller's own access.
 */
function select(nodes: Record<string, ParsedNode>, selection: Selection): Set<string> {
  const chosen = new Set<string>();
  const globs = (selection.glob ?? []).map(globToRegExp);
  for (const [rel, node] of Object.entries(nodes)) {
    if (selection.type?.includes(node.node_type)) chosen.add(rel);
    if (selection.prefix?.some((p) => rel.startsWith(p))) chosen.add(rel);
    if (globs.some((g) => g.test(rel))) chosen.add(rel);
  }
  for (const raw of selection.node ?? []) {
    const rel = stripKbDir(raw);
    if (rel in nodes) chosen.add(rel);
  }
  if (selection.with_neighbors) {
    const extra = new Set<string>();
    for (const rel of chosen) {
      for (const bucket of Object.values(nodes[rel]!.links)) {
        for (const l of bucket) if (l.path in nodes) extra.add(l.path);
      }
    }
    for (const [rel, node] of Object.entries(nodes)) {
      if (Object.values(node.links).some((bucket) => bucket.some((l) => chosen.has(l.path)))) extra.add(rel);
    }
    for (const rel of extra) chosen.add(rel);
  }
  return chosen;
}

/** Build a snapshot from mirrored files, with the page's recorded selection. */
export function buildSnapshot(
  files: Record<string, string>,
  selection: Selection,
  branch: string,
  takenAt: string = new Date().toISOString().slice(0, 10),
): Snapshot {
  const nodes = parseGraph(files);
  const keep = select(nodes, selection);
  const wanted = selection.fields ? new Set(selection.fields.split(',').map((f) => f.trim())) : null;
  const keepSoi = Boolean(selection.keep_soi);

  const outNodes: Record<string, WireNode> = {};
  for (const rel of [...keep].sort()) {
    const node = nodes[rel]!;
    const fields = Object.fromEntries(
      Object.entries(node.fields)
        .filter(([k]) => wanted === null || wanted.has(k) || ['Name', 'Title', 'name', 'title'].includes(k))
        .map(([k, v]) => [k, toWire(v, keepSoi)]),
    );
    const links = Object.fromEntries(
      Object.entries(node.links)
        .filter(([, b]) => b.length)
        .map(([c, b]) => [c, b.map((l) => ({ text: l.text, path: l.path }))]),
    );
    outNodes[rel] = { node_type: node.node_type, id: node.id, owner: node.owner, file_path: rel, fields, links };
  }

  const plain: Record<string, { text: string }> = {};
  for (const raw of selection.file ?? []) {
    const rel = stripKbDir(raw);
    if (rel in files) plain[rel] = { text: files[rel]! };
  }

  return {
    format: SNAPSHOT_FORMAT,
    takenAt,
    branch,
    nodes: outNodes,
    edges: edgesBetween(nodes, keep),
    files: plain,
    withheld: 0,
    selection,
    keptRestricted: [],
  };
}

// -- the mirror: mirror.chain.js, minus the access.md walk ---------------------

function nodeTypeOf(text: string): { name: string; link: string } | null {
  const split = extractFrontmatter(text);
  if (!split) return null;
  for (const raw of splitLines(split.frontmatter)) {
    const m = raw.trim().match(/^nodeType:\s*["']?\[([^\]]+)\]\(([^)]+)\)/);
    if (m) return { name: m[1]!, link: m[2]! };
  }
  return null;
}

/** Keep only the frontmatter and the wanted top-level fields, as the chain does. */
function reduceToFields(text: string, want: Set<string>): string {
  if (!want.size) return text;
  const split = extractFrontmatter(text);
  const out: string[] = split ? ['---', ...splitLines(split.frontmatter), '---'] : [];
  let keep = false;
  for (const line of (split ? split.body : text).split(/\r?\n/)) {
    const h = line.trim().match(/^(#{1,6})\s+(.+)$/);
    if (h && h[1]!.length === 1) {
      keep = want.has(h[2]!.replace(/\s*\([^)]*\)\s*$/, '').trim()) || /^(Name|Title)$/i.test(h[2]!.trim());
    }
    if (keep) out.push(line);
  }
  return out.join('\n');
}

/** Run `tasks` with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export interface MirrorResult {
  files: Record<string, string>;
  errors: string[];
}

/**
 * Read what a page's snapshot was built from: every node under `dirs` (of
 * `types`, cut to `fields`), every file in `paths`, and the NodeType
 * definitions those nodes point at (link categories come from there).
 */
export async function mirrorFiles(reader: KbReader, config: MirrorConfig, concurrency = 8): Promise<MirrorResult> {
  const want = new Set(config.fields ?? []);
  const types = config.types ?? [];
  const files: Record<string, string> = {};
  const typePaths = new Set<string>();
  const errors: string[] = [];
  const fail = (what: string, err: unknown): void => {
    errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  };

  const take = (path: string, text: string, filtered: boolean): boolean => {
    const nt = nodeTypeOf(text);
    if (!nt) return false;
    if (filtered && types.length && !types.includes(nt.name)) return false;
    files[path] = reduceToFields(text, want);
    typePaths.add(resolveLink(nt.link, path));
    return true;
  };

  // Walk the folders breadth-first, a level at a time, reading files in parallel.
  const nodeFiles: string[] = [];
  let level = (config.dirs ?? []).map((d) => stripKbDir(d).replace(/\/+$/, ''));
  while (level.length) {
    const nextLevel: string[] = [];
    await pool(level, concurrency, async (folder) => {
      try {
        for (const e of await reader.list(folder)) {
          const p = `${folder}/${e.name}`;
          if (e.type === 'directory') {
            if (config.deep && e.name !== 'transcripts' && e.name !== 'probes') nextLevel.push(p);
          } else if (e.name.endsWith('.md') && e.name !== 'access.md') {
            nodeFiles.push(p);
          }
        }
      } catch (err) {
        fail(`list ${folder}`, err);
      }
    });
    level = nextLevel;
  }
  await pool(nodeFiles, concurrency, async (p) => {
    try {
      take(p, await reader.read(p), true);
    } catch (err) {
      fail(p, err);
    }
  });
  await pool((config.paths ?? []).map(stripKbDir), concurrency, async (p) => {
    try {
      const text = await reader.read(p);
      if (!take(p, text, false)) files[p] = text;
    } catch (err) {
      fail(p, err);
    }
  });
  await pool(
    [...typePaths].filter((p) => !(p in files)),
    concurrency,
    async (p) => {
      try {
        files[p] = await reader.read(p);
      } catch (err) {
        fail(`NodeType ${p}`, err);
      }
    },
  );
  return { files, errors };
}

// -- the page's own snapshot block ---------------------------------------------

const SNAPSHOT_BLOCK = /(<script\b[^>]*\bid=["']kb-snapshot["'][^>]*>)([\s\S]*?)(<\/script>)/i;

/** The snapshot a page carries, or null when it has none (or it does not parse). */
export function readEmbeddedSnapshot(html: string): Partial<Snapshot> | null {
  const block = html.match(SNAPSHOT_BLOCK);
  if (!block) return null;
  const body = block[2]!.trim().match(/window\.KB_SNAPSHOT\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!body) return null;
  try {
    // `serialise` (like build_snapshot.py) writes `<!--` as `<\!--`, which
    // JavaScript reads as `<!--` and JSON rejects. `<` occurs only inside JSON
    // strings, so this undoes exactly that escape.
    return JSON.parse(body[1]!.replace(/<\\!--/g, '<!--')) as Partial<Snapshot>;
  } catch {
    return null;
  }
}

/** JSON that is safe inside a <script>: no `</script`, no `<!--` (build_snapshot.py's `serialise`). */
const serialise = (snapshot: unknown): string => JSON.stringify(snapshot).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');

/** The page with its snapshot block holding `snapshot` instead (build_snapshot.py's `inject`). */
export function replaceEmbeddedSnapshot(html: string, snapshot: Snapshot): string {
  return html.replace(SNAPSHOT_BLOCK, (_m, open: string, _body: string, close: string) =>
    `${open}\nwindow.KB_SNAPSHOT = ${serialise(snapshot)};\n${close}`);
}

/** True when the page is an html-knowledge-view page (it has a snapshot block). */
export function isKnowledgeView(html: string): boolean {
  return SNAPSHOT_BLOCK.test(html);
}

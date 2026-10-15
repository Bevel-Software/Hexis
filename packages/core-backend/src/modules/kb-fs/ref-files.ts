import fs from 'node:fs/promises';
import path from 'node:path';
import { isAbsence } from '../../shared/fs.contract.js';

/**
 * Where a ref points, read from the repository's own files instead of a
 * `git rev-parse` process.
 *
 * A branch tip is a small file git maintains: `refs/remotes/origin/<branch>`
 * as a loose file, or one line of `packed-refs`. Reading it costs a file read
 * and no fork, and it is exactly as current as the last fetch — the same
 * freshness a `rev-parse` has. A change-request listing resolves two tips per
 * open request and the access gates resolve every ref they decide at; with a
 * hundred open requests that was hundreds of forks per listing, each costing
 * tens of milliseconds of the main thread on a server holding a large heap.
 *
 * What is read, in git's own order: a loose file under the common directory
 * (a worktree shares `refs/` with the repository it belongs to; only `HEAD`
 * is its own), then `packed-refs`, with a `^` peel line honoured for an
 * annotated tag. A symbolic ref (`ref: refs/heads/main`) is followed.
 *
 * The answer is one of three things, and the caller treats them differently:
 * `{ sha }` is what git would answer too; `'missing'` means every file git
 * would consult says there is no such ref, which is as authoritative as
 * `rev-parse` answering nothing; `'unreadable'` means this reader could not
 * decide — a repository it does not understand, a tag it cannot peel, a
 * corrupt file, a name it refuses — and the caller asks git, which is
 * authoritative. Never a guess: a read error is `'unreadable'`, not
 * `'missing'`, so a flaky disk sends the caller to git rather than making a
 * branch disappear.
 *
 * Only full ref names (`refs/...`) and `HEAD` are read here. A short name,
 * an abbreviated object id or a `<rev>^{...}` form has resolution rules of
 * its own; callers that hold one spell out the full names git would try, in
 * git's order, or ask git.
 */
export type RefFileAnswer = { sha: string } | 'missing' | 'unreadable';

const SHA = /^[0-9a-f]{40,64}$/;
const MAX_SYMREF_DEPTH = 5;

/** A ref name this reader is willing to turn into a path under `.git`. */
function isSafeRefName(ref: string): boolean {
  if (ref === 'HEAD') return true;
  if (!ref.startsWith('refs/')) return false;
  if (!/^[A-Za-z0-9._\-/@+]+$/.test(ref)) return false;
  return !ref.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

interface GitDirs {
  /** The worktree's own git directory: `HEAD` lives here. */
  gitDir: string;
  /** Where `refs/` and `packed-refs` live: the repository, shared by every worktree. */
  commonDir: string;
}

async function gitDirsOf(repoDir: string): Promise<GitDirs | null> {
  const dotGit = path.join(repoDir, '.git');
  let gitDir: string;
  try {
    const st = await fs.stat(dotGit);
    if (st.isDirectory()) gitDir = dotGit;
    else if (st.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.readFile(dotGit, 'utf-8'));
      if (!m) return null;
      gitDir = path.resolve(repoDir, m[1]!);
    } else return null;
  } catch {
    return null;
  }
  let commonDir = gitDir;
  try {
    const pointer = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf-8')).trim();
    if (pointer) commonDir = path.resolve(gitDir, pointer);
  } catch (err) {
    if (!isAbsence(err)) return null;
  }
  return { gitDir, commonDir };
}

/**
 * `packed-refs`: `<sha> <name>` lines, each optionally followed by `^<sha>`,
 * the peeled commit of an annotated tag. Absent file → an empty table.
 */
async function readPackedRefs(commonDir: string): Promise<Map<string, { sha: string; peeled?: string }> | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(commonDir, 'packed-refs'), 'utf-8');
  } catch (err) {
    return isAbsence(err) ? new Map() : null;
  }
  const table = new Map<string, { sha: string; peeled?: string }>();
  let last: { sha: string; peeled?: string } | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('^')) {
      const peeled = line.slice(1);
      if (last && SHA.test(peeled)) last.peeled = peeled;
      continue;
    }
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const sha = line.slice(0, space);
    const name = line.slice(space + 1).trim();
    if (!SHA.test(sha) || !name) continue;
    last = { sha };
    table.set(name, last);
  }
  return table;
}

async function resolveIn(dirs: GitDirs, ref: string, depth: number): Promise<RefFileAnswer> {
  if (depth > MAX_SYMREF_DEPTH) return 'unreadable';
  if (!isSafeRefName(ref)) return 'unreadable';
  const looseDir = ref === 'HEAD' ? dirs.gitDir : dirs.commonDir;
  let loose: string | null = null;
  try {
    loose = (await fs.readFile(path.join(looseDir, ...ref.split('/')), 'utf-8')).trim();
  } catch (err) {
    if (!isAbsence(err)) return 'unreadable';
  }
  if (loose !== null) {
    if (loose.startsWith('ref:')) return resolveIn(dirs, loose.slice('ref:'.length).trim(), depth + 1);
    if (SHA.test(loose)) return ref.startsWith('refs/tags/') ? 'unreadable' : { sha: loose };
    return 'unreadable';
  }
  if (ref === 'HEAD') return 'missing';
  const packed = await readPackedRefs(dirs.commonDir);
  if (!packed) return 'unreadable';
  const entry = packed.get(ref);
  if (!entry) return 'missing';
  if (ref.startsWith('refs/tags/')) return entry.peeled ? { sha: entry.peeled } : 'unreadable';
  return { sha: entry.sha };
}

/**
 * The commit a full ref name (`refs/...`) or `HEAD` points at in the
 * repository behind `repoDir` (a clone, or a worktree of one). See the module
 * doc for the three answers and what each means to the caller.
 */
export async function readRefSha(repoDir: string, ref: string): Promise<RefFileAnswer> {
  const dirs = await gitDirsOf(repoDir);
  if (!dirs) return 'unreadable';
  return resolveIn(dirs, ref, 0);
}

/**
 * The full ref names `git rev-parse` tries for a name, in git's order
 * (gitrevisions(7)): `refs/<name>`, `refs/tags/<name>`, `refs/heads/<name>`,
 * `refs/remotes/<name>`, `refs/remotes/<name>/HEAD`. `HEAD` and a full
 * `refs/...` name are themselves. Null for a spelling this reader does not
 * resolve — an object id or its abbreviation, a `<rev>^{...}` or `@{...}`
 * form, an empty or option-looking name — which the caller sends to git.
 */
export function refNameCandidates(ref: string): string[] | null {
  if (!ref || ref.startsWith('-')) return null;
  if (ref === 'HEAD') return ['HEAD'];
  if (ref.startsWith('refs/')) return [ref];
  if (/[\^~:@{}\\\s]/.test(ref)) return null;
  if (/^[0-9a-f]{4,64}$/i.test(ref)) return null;
  return [`refs/${ref}`, `refs/tags/${ref}`, `refs/heads/${ref}`, `refs/remotes/${ref}`, `refs/remotes/${ref}/HEAD`];
}

/**
 * {@link readRefSha} for a name as a caller holds it (`main`, `origin/main`,
 * `HEAD`, `refs/heads/main`): the first of git's candidates that resolves.
 * `'missing'` only when every candidate is missing; `'unreadable'` as soon as
 * one cannot be decided, because the undecided one might be the one git
 * would pick.
 */
export async function readRevSha(repoDir: string, rev: string): Promise<RefFileAnswer> {
  const candidates = refNameCandidates(rev);
  if (!candidates) return 'unreadable';
  const dirs = await gitDirsOf(repoDir);
  if (!dirs) return 'unreadable';
  for (const name of candidates) {
    const answer = await resolveIn(dirs, name, 0);
    if (answer !== 'missing') return answer;
  }
  return 'missing';
}

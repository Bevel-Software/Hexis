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
 * is its own), then `packed-refs`. A symbolic ref (`ref: refs/heads/main`)
 * is followed. A tag is never decided here: its file may hold a tag object,
 * and what that peels to is git's to say.
 *
 * The answer is one of three things, and the caller treats them differently:
 * `{ sha }` is what git would answer too; `'missing'` means every file git
 * would consult says there is no such ref, which is as authoritative as
 * `rev-parse` answering nothing; `'unreadable'` means this reader could not
 * decide — a repository it does not understand (one whose refs live in a
 * reftable, say), a tag, a corrupt file, a name it refuses — and the caller
 * asks git, which is authoritative. Never a guess: a read error is
 * `'unreadable'`, not `'missing'`, so a flaky disk sends the caller to git
 * rather than making a branch disappear.
 *
 * What the files guarantee about the object: git itself refuses to write a
 * non-commit under `refs/heads/`, and `refs/remotes/origin/` mirrors the
 * remote's `refs/heads/`, so a branch tip read here is a commit as surely
 * as `rev-parse <branch>^{commit}` would make it one. A caller that holds
 * an object id rather than a name, or a `<rev>^{...}` form, asks git.
 */
export type RefFileAnswer = { sha: string } | 'missing' | 'unreadable';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
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
  // A repository whose refs live in a reftable (`extensions.refStorage`)
  // keeps nothing this reader understands under `refs/` or in `packed-refs`:
  // every name would read as missing. Not a repository for this reader.
  try {
    await fs.stat(path.join(commonDir, 'reftable'));
    return null;
  } catch (err) {
    if (!isAbsence(err)) return null;
  }
  try {
    if (/^\s*refstorage\s*=\s*reftable\s*$/im.test(await fs.readFile(path.join(commonDir, 'config'), 'utf-8'))) {
      return null;
    }
  } catch (err) {
    if (!isAbsence(err)) return null;
  }
  return { gitDir, commonDir };
}

/**
 * `packed-refs`: `<sha> <name>` lines, `^<sha>` peel lines, `#` comments.
 * Absent file → an empty table. A line that is none of those is a file this
 * reader does not understand, and the whole table is null (unreadable): a
 * record it skipped could be the one that was asked for.
 */
async function readPackedRefs(commonDir: string): Promise<Map<string, string> | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(commonDir, 'packed-refs'), 'utf-8');
  } catch (err) {
    return isAbsence(err) ? new Map() : null;
  }
  const table = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('^')) {
      if (!SHA.test(line.slice(1))) return null;
      continue;
    }
    const space = line.indexOf(' ');
    const sha = space < 0 ? '' : line.slice(0, space);
    const name = space < 0 ? '' : line.slice(space + 1).trim();
    if (!SHA.test(sha) || !name) return null;
    table.set(name, sha);
  }
  return table;
}

/**
 * The file at `<dir>/<relative>`, read as git reads a loose ref: a symbolic
 * ref is followed, an object id is the answer, anything else is not decided.
 */
async function readLooseRef(dirs: GitDirs, dir: string, relative: string, depth: number): Promise<RefFileAnswer> {
  let text: string;
  try {
    text = (await fs.readFile(path.join(dir, ...relative.split('/')), 'utf-8')).trim();
  } catch (err) {
    return isAbsence(err) ? 'missing' : 'unreadable';
  }
  if (text.startsWith('ref:')) {
    const answer = await resolveIn(dirs, text.slice('ref:'.length).trim(), depth + 1);
    // A symbolic ref whose target is gone is dangling, and git reports it
    // as such; a packed entry under the symbolic ref's own name does not
    // stand in for it. Git's to report, then.
    return answer === 'missing' ? 'unreadable' : answer;
  }
  return SHA.test(text) ? { sha: text } : 'unreadable';
}

async function resolveIn(dirs: GitDirs, ref: string, depth: number): Promise<RefFileAnswer> {
  if (depth > MAX_SYMREF_DEPTH) return 'unreadable';
  if (!isSafeRefName(ref)) return 'unreadable';
  const loose = await readLooseRef(dirs, ref === 'HEAD' ? dirs.gitDir : dirs.commonDir, ref, depth);
  if (loose !== 'missing') return decidedHere(ref, loose);
  if (ref === 'HEAD') return 'missing';
  const packed = await readPackedRefs(dirs.commonDir);
  if (!packed) return 'unreadable';
  const sha = packed.get(ref);
  return sha ? decidedHere(ref, { sha }) : 'missing';
}

/**
 * The files decide only where git itself guarantees the object is a commit:
 * `HEAD` and `refs/heads/*`, which git refuses to point at anything else,
 * and `refs/remotes/*`, fetched from a remote's `refs/heads/*` under the
 * same refusal. Anything else that exists — a tag, a ref directly under
 * `refs/` — may name a tree or a blob, which only git's `^{commit}` refuses,
 * so it is git's to resolve. Anything that does not exist is as missing as
 * any other ref, so a short name can move on to the branch git would find
 * next.
 */
function decidedHere(ref: string, answer: RefFileAnswer): RefFileAnswer {
  if (answer !== 'missing' && answer !== 'unreadable' && !commitGuaranteed(ref)) return 'unreadable';
  return answer;
}

function commitGuaranteed(ref: string): boolean {
  return ref === 'HEAD' || ref.startsWith('refs/heads/') || ref.startsWith('refs/remotes/');
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
 * (gitrevisions(7)) after `$GIT_DIR/<name>` itself: `refs/<name>`,
 * `refs/tags/<name>`, `refs/heads/<name>`, `refs/remotes/<name>`,
 * `refs/remotes/<name>/HEAD`. `HEAD` and a full `refs/...` name are
 * themselves. Null for a spelling this reader does not resolve — an object
 * id or its abbreviation, a `<rev>^{...}` or `@{...}` form, an empty or
 * option-looking name — which the caller sends to git.
 */
function refNameCandidates(ref: string): string[] | null {
  if (!ref || ref.startsWith('-')) return null;
  if (ref === 'HEAD') return ['HEAD'];
  if (ref.startsWith('refs/')) return [ref];
  if (/[\^~:@{}\\\s]/.test(ref)) return null;
  if (/^[0-9a-f]{4,64}$/i.test(ref)) return null;
  return [`refs/${ref}`, `refs/tags/${ref}`, `refs/heads/${ref}`, `refs/remotes/${ref}`, `refs/remotes/${ref}/HEAD`];
}

/**
 * {@link readRefSha} for a name as a caller holds it (`main`, `origin/main`,
 * `HEAD`, `refs/heads/main`): the first of git's candidates that resolves,
 * starting where git starts, at `$GIT_DIR/<name>` itself. Whatever is found
 * there (`MERGE_HEAD`, `FETCH_HEAD`, `AUTO_MERGE`, which may name a tree) is
 * git's to resolve; only its absence lets the `refs/` candidates be read.
 * `'missing'` only when every candidate is missing; `'unreadable'` as soon
 * as one cannot be decided, because the undecided one might be the one git
 * would pick.
 */
export async function readRevSha(repoDir: string, rev: string): Promise<RefFileAnswer> {
  const candidates = refNameCandidates(rev);
  if (!candidates) return 'unreadable';
  const dirs = await gitDirsOf(repoDir);
  if (!dirs) return 'unreadable';
  if (rev !== 'HEAD' && !rev.startsWith('refs/')) {
    if (!isSafeRefName(`refs/${rev}`)) return 'unreadable';
    try {
      await fs.stat(path.join(dirs.gitDir, ...rev.split('/')));
      return 'unreadable';
    } catch (err) {
      if (!isAbsence(err)) return 'unreadable';
    }
  }
  for (const name of candidates) {
    const answer = await resolveIn(dirs, name, 0);
    if (answer !== 'missing') return answer;
  }
  return 'missing';
}

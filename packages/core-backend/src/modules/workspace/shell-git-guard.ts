/**
 * Which `git` commands the shell tool (`execute_command`) refuses to run in a
 * branch workspace.
 *
 * A workspace is a WORKTREE of the knowledge base's one repository: its HEAD,
 * index and working tree are its own, but the refs, the object store, the
 * list of worktrees and the configuration belong to every branch at once. A
 * full clone kept all of that per branch, so `git update-ref refs/heads/bob/b …`
 * in Alice's clone touched Alice's copy only; in a worktree it moves Bob's
 * checked-out branch. Git itself refuses most of the ways one worktree could
 * move another's branch (`branch -f`, `branch -d`, `fetch`/`push` into a
 * checked-out branch); what it does not refuse is refused here:
 *
 *  - plumbing that writes any ref, unchecked: `update-ref`;
 *  - renaming, copying, deleting or force-moving a branch, and setting or
 *    changing its upstream (which writes the shared configuration) in every
 *    form git has for it: `branch --set-upstream-to|--unset-upstream|-t|--track`,
 *    `checkout`/`switch -t|--track`, `push -u|--set-upstream`;
 *  - what rewrites the shared store or the list of worktrees: `gc`, `prune`,
 *    `repack`, `pack-refs`, `prune-packed`, `reflog expire|delete`, `replace`,
 *    `filter-branch`, `worktree` other than `list`;
 *  - writes to the shared configuration: `config` that sets or unsets, and
 *    `remote` other than reading it.
 *
 * The platform runs those itself, under the repository reservation that
 * keeps them from racing every workspace's own git (`WorkspaceMutex`).
 *
 * Every `git` invocation in the command is checked, not only a standalone one:
 * `cd kb && git update-ref …` reaches the same repository.
 *
 * The command is read the way the shell that runs it reads it (`sh` on
 * POSIX, `cmd.exe` on Windows — `spawn` with `shell: true`): quote removal,
 * escapes and separators as that shell applies them, so `git up"date"-ref`
 * or `git up\date-ref` is `update-ref` here, as it is to git. What only the
 * running shell can resolve — a variable, a command substitution, a glob —
 * is refused where it could decide the outcome (the program, git's
 * subcommand, or the flags of a subcommand whose refusal depends on them),
 * rather than guessed at — and so is such a word among the operands of a
 * program that runs another (`env "$G" gc`). Command substitutions and
 * command lines handed to another shell (`sh -c`, `eval`, `cmd /c`) are read
 * and checked as well; comments and here-document bodies are skipped as `sh`
 * skips them, except the substitutions an unquoted here-document runs. A
 * refusal of something that only looked like such a command (`echo git gc`)
 * costs nothing.
 *
 * This reads the command line; it does not confine the shell. A script the
 * agent writes to a file and then runs is not read here.
 */

const OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env']);

const ALWAYS_REFUSED = new Set([
  'update-ref',
  'gc',
  'prune',
  'repack',
  'pack-refs',
  'prune-packed',
  'replace',
  'filter-branch',
  'filter-repo',
]);

const BRANCH_WRITE_FLAGS =
  /^(?:-[a-zA-Z]*[dDmMcCfut][a-zA-Z]*|--delete|--move|--copy|--force|--set-upstream-to(?:=.*)?|--unset-upstream|--track(?:=.*)?|--edit-description)$/;

/** `checkout`/`switch` flags that record an upstream for the branch they create. */
const CHECKOUT_TRACK_FLAGS = /^(?:-[a-zA-Z]*t[a-zA-Z]*|--track(?:=.*)?)$/;

/** `push` flags that record an upstream for the pushed branch. */
const PUSH_UPSTREAM_FLAGS = /^(?:-[a-zA-Z]*u[a-zA-Z]*|--set-upstream)$/;

const CONFIG_WRITE_FLAGS =
  /^(?:--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section|--edit|-e)$/;
const CONFIG_READ_FLAGS = /^(?:--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--show-origin|--show-scope|--name-only|-z|--null)$/;

/** Subcommands whose refusal depends on their flags: an argument the guard cannot read could be one. */
const FLAG_DEPENDENT = new Set(['worktree', 'reflog', 'branch', 'checkout', 'switch', 'push', 'remote', 'config']);

/** The reason a git invocation is refused, or null when it may run. `args` follow `git`. */
function refusalFor(argWords: Word[]): string | null {
  let i = 0;
  while (i < argWords.length && (argWords[i]!.opaque || argWords[i]!.text.startsWith('-'))) {
    const a = argWords[i]!;
    if (a.opaque) return UNREADABLE;
    // An alias defined for this one call runs whatever it names (`-c alias.u=update-ref`).
    const value = OPTIONS_WITH_VALUE.has(a.text) ? argWords[i + 1] : a.text.startsWith('--config-env=') ? a : undefined;
    if ((a.text === '-c' || a.text.startsWith('--config-env')) && value !== undefined) {
      if (value.opaque) return UNREADABLE;
      if (/^(?:--config-env=)?alias\./i.test(value.text)) return 'git with an alias defined on the command line';
    }
    i += OPTIONS_WITH_VALUE.has(a.text) ? 2 : 1;
  }
  const subWord = argWords[i];
  if (subWord === undefined) return null;
  if (subWord.opaque) return UNREADABLE;
  const sub = subWord.text;
  const restWords = argWords.slice(i + 1);
  if (ALWAYS_REFUSED.has(sub)) return `git ${sub}`;
  // Pathspecs after `--` may be anything; before it, an unreadable word could be a flag.
  const end = restWords.findIndex((w) => !w.opaque && w.text === '--');
  const options = end < 0 ? restWords : restWords.slice(0, end);
  if (FLAG_DEPENDENT.has(sub) && options.some((w) => w.opaque)) return UNREADABLE;
  const rest = restWords.map((w) => w.text);
  const flags = rest.filter((a) => a.startsWith('-'));
  const positionals = rest.filter((a) => !a.startsWith('-'));
  switch (sub) {
    case 'worktree':
      return positionals[0] === 'list' ? null : 'git worktree';
    case 'reflog':
      return positionals[0] === 'expire' || positionals[0] === 'delete' ? `git reflog ${positionals[0]}` : null;
    case 'branch':
      return flags.some((f) => BRANCH_WRITE_FLAGS.test(f))
        ? 'git branch that deletes, renames, copies or force-moves a branch, or changes its upstream'
        : null;
    case 'checkout':
    case 'switch':
      return flags.some((f) => CHECKOUT_TRACK_FLAGS.test(f)) ? `git ${sub} that sets an upstream` : null;
    case 'push':
      return flags.some((f) => PUSH_UPSTREAM_FLAGS.test(f)) ? 'git push that sets an upstream' : null;
    case 'remote': {
      const verb = positionals[0];
      return verb === undefined || verb === 'show' || verb === 'get-url' ? null : `git remote ${verb}`;
    }
    case 'config': {
      const verb = positionals[0];
      if (verb === 'get' || verb === 'list') return null;
      if (verb === 'set' || verb === 'unset' || verb === 'rename-section' || verb === 'remove-section' || verb === 'edit') {
        return `git config ${verb}`;
      }
      if (flags.some((f) => CONFIG_WRITE_FLAGS.test(f))) return 'git config that writes';
      if (flags.some((f) => CONFIG_READ_FLAGS.test(f))) return null;
      return positionals.length >= 2 ? 'git config that writes' : null;
    }
    default:
      return null;
  }
}

/** A word of the command as the shell hands it to the program, quotes removed. */
interface Word {
  text: string;
  /**
   * The word holds an expansion — a variable, a command substitution, an
   * unquoted glob — whose value only exists when the shell runs: the guard
   * cannot read it, so what it may turn into is not known here.
   */
  opaque: boolean;
}

/** The shell `execute_command` runs under: `sh` on POSIX, `cmd.exe` on Windows (`spawn` with `shell: true`). */
export type ShellDialect = 'posix' | 'cmd';

const UNREADABLE = 'a git command whose arguments are only known when the shell runs it';

/**
 * Split `src` into simple commands, the way the shell that runs it does:
 * quote removal and escapes as `sh` (or `cmd.exe`) apply them, so
 * `git up"date"-ref` is the word `update-ref` here exactly as it is to git.
 * The bodies of command substitutions (`$(…)`, backquotes) are commands too,
 * returned for the caller to check.
 */
interface Heredoc {
  delimiter: string;
  /** `<<-`: leading tabs are stripped from the body's lines, the delimiter's too. */
  stripTabs: boolean;
  /** Any part of the delimiter quoted: the body is taken literally, no substitution in it runs. */
  quoted: boolean;
}

/**
 * The here-document operator `<<` at `i` (POSIX): its delimiter word, quotes
 * removed, and the index after it. `readable` is false for a delimiter only
 * the running shell could settle (empty, or with an expansion in it).
 */
function readHeredoc(src: string, i: number): { doc: Heredoc; end: number; readable: boolean } {
  let j = i + 2;
  const stripTabs = src[j] === '-';
  if (stripTabs) j++;
  while (src[j] === ' ' || src[j] === '\t') j++;
  let delimiter = '';
  let quoted = false;
  let readable = true;
  while (j < src.length && !' \t\n;&|()<>'.includes(src[j]!)) {
    const c = src[j]!;
    if (c === "'" || c === '"') {
      const close = src.indexOf(c, j + 1);
      delimiter += src.slice(j + 1, close < 0 ? src.length : close);
      quoted = true;
      j = close < 0 ? src.length : close + 1;
    } else if (c === '\\') {
      delimiter += src[j + 1] ?? '';
      quoted = true;
      j += 2;
    } else {
      if (c === '$' || c === '`') readable = false;
      delimiter += c;
      j++;
    }
  }
  if (delimiter === '') readable = false;
  return { doc: { delimiter, stripTabs, quoted }, end: j, readable };
}

/**
 * A here-document's body starting at `from`, up to its delimiter line:
 * where the body ends, and where the shell reads commands again.
 */
function heredocBody(src: string, from: number, doc: Heredoc): { end: number; next: number } {
  let pos = from;
  while (pos < src.length) {
    const eol = src.indexOf('\n', pos);
    const line = src.slice(pos, eol < 0 ? src.length : eol);
    const next = eol < 0 ? src.length : eol + 1;
    if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) return { end: pos, next };
    pos = next;
  }
  return { end: src.length, next: src.length };
}

function lex(
  src: string,
  dialect: ShellDialect,
): { commands: Word[][]; substitutions: string[]; unreadable: boolean } {
  const commands: Word[][] = [];
  const substitutions: string[] = [];
  /** Shell syntax this reader cannot settle, where it could hide what runs. */
  let unreadable = false;
  /** Here-documents opened on the current line: their bodies follow its newline. */
  let pendingHeredocs: Heredoc[] = [];
  let cur: Word[] = [];
  let text = '';
  let opaque = false;
  let inWord = false;
  const endWord = () => {
    if (inWord) cur.push({ text, opaque });
    text = '';
    opaque = false;
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (cur.length > 0) commands.push(cur);
    cur = [];
  };
  /** Whether the character at `j` begins a word, so that a `#` there opens a comment (`a#b` is one word). */
  const startsWord = (j: number, from = 0): boolean => j === from || /[\s;&|()]/.test(src[j - 1]!);
  /**
   * The index of the `)` closing a `$(` whose body starts at `from`. A `)`
   * that is quoted, escaped, in a comment, in a here-document or in a nested
   * substitution does not close it: `$(printf ")"; git gc)` runs `git gc`.
   */
  const closeParen = (from: number): number => {
    let depth = 1;
    let docs: Heredoc[] = [];
    for (let j = from; j < src.length; j++) {
      const c = src[j];
      if (c === '\\') j++;
      else if (c === "'") j = src.indexOf("'", j + 1) < 0 ? src.length : src.indexOf("'", j + 1);
      else if (c === '"') j = closeDoubleQuote(j + 1);
      else if (c === '`') j = closeBackquote(j + 1);
      else if (c === '#' && startsWord(j, from)) {
        const eol = src.indexOf('\n', j);
        j = eol < 0 ? src.length : eol - 1;
      } else if (c === '<' && src[j + 1] === '<' && src[j + 2] !== '<') {
        const read = readHeredoc(src, j);
        if (!read.readable) unreadable = true;
        docs.push(read.doc);
        j = read.end - 1;
      } else if (c === '<' && src[j + 1] === '<') j += 2;
      else if (c === '\n' && docs.length > 0) {
        let next = j + 1;
        for (const doc of docs) next = heredocBody(src, next, doc).next;
        docs = [];
        j = next - 1;
      } else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return j;
    }
    return src.length;
  };
  /** The index of the `"` closing one whose body starts at `from`. */
  const closeDoubleQuote = (from: number): number => {
    for (let j = from; j < src.length; j++) {
      const c = src[j];
      if (c === '\\') j++;
      else if (c === '"') return j;
      else if (c === '`') j = closeBackquote(j + 1);
      else if (c === '$' && src[j + 1] === '(') j = closeParen(j + 2);
    }
    return src.length;
  };
  /**
   * Past the bodies of the here-documents opened on the line that ended just
   * before `from`: where the shell reads commands again. A body is data, but
   * with an unquoted delimiter its command substitutions run — those are
   * returned for checking with the others.
   */
  const skipHeredocBodies = (from: number): number => {
    let next = from;
    for (const doc of pendingHeredocs) {
      const body = heredocBody(src, next, doc);
      if (!doc.quoted) {
        for (let k = next; k < body.end; k++) {
          if (src[k] === '\\') k++;
          else if (src[k] === '$' && src[k + 1] === '(') {
            const close = closeParen(k + 2);
            substitutions.push(src.slice(k + 2, close));
            k = close;
          } else if (src[k] === '`') {
            const close = closeBackquote(k + 1);
            substitutions.push(src.slice(k + 1, close));
            k = close;
          }
        }
      }
      next = body.next;
    }
    pendingHeredocs = [];
    return next;
  };
  /** The index of the backquote closing one whose body starts at `from`. */
  const closeBackquote = (from: number): number => {
    for (let j = from; j < src.length; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '`') return j;
    }
    return src.length;
  };
  /** A `$` at `i` (unquoted or in double quotes): answers the index after what it consumed. */
  const dollar = (i: number): number => {
    const next = src[i + 1];
    if (next === '(') {
      const close = closeParen(i + 2);
      substitutions.push(src.slice(i + 2, close));
      opaque = true;
      inWord = true;
      return close + 1;
    }
    if (next !== undefined && /[A-Za-z0-9_{@*#?$!'"-]/.test(next)) {
      opaque = true;
      inWord = true;
      return i + 1;
    }
    text += '$';
    inWord = true;
    return i + 1;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (dialect === 'posix') {
      if (c === '\\') {
        if (src[i + 1] === '\n') i += 2;
        else {
          if (i + 1 < src.length) text += src[i + 1];
          inWord = true;
          i += 2;
        }
      } else if (c === "'") {
        const close = src.indexOf("'", i + 1);
        text += src.slice(i + 1, close < 0 ? src.length : close);
        inWord = true;
        i = close < 0 ? src.length : close + 1;
      } else if (c === '"') {
        inWord = true;
        i++;
        while (i < src.length && src[i] !== '"') {
          const d = src[i]!;
          if (d === '\\' && i + 1 < src.length && '$`"\\\n'.includes(src[i + 1]!)) {
            if (src[i + 1] !== '\n') text += src[i + 1];
            i += 2;
          } else if (d === '$') i = dollar(i);
          else if (d === '`') {
            const close = closeBackquote(i + 1);
            substitutions.push(src.slice(i + 1, close));
            opaque = true;
            i = close + 1;
          } else {
            text += d;
            i++;
          }
        }
        i++;
      } else if (c === '$') i = dollar(i);
      else if (c === '`') {
        const close = closeBackquote(i + 1);
        substitutions.push(src.slice(i + 1, close));
        opaque = true;
        inWord = true;
        i = close + 1;
      } else if (c === '\n') {
        endCommand();
        i = pendingHeredocs.length > 0 ? skipHeredocBodies(i + 1) : i + 1;
      } else if (';&|()'.includes(c)) {
        endCommand();
        i++;
      } else if (c === '#' && !inWord && startsWord(i)) {
        // A comment runs to the end of the line; a quote in it is not syntax.
        const eol = src.indexOf('\n', i);
        i = eol < 0 ? src.length : eol;
      } else if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
        endWord();
        const read = readHeredoc(src, i);
        if (!read.readable) unreadable = true;
        pendingHeredocs.push(read.doc);
        i = read.end;
      } else if (c === '<' || c === '>') {
        endWord();
        i += src[i + 1] === '&' || src[i + 1] === c ? 2 : 1;
      } else if (c === ' ' || c === '\t') {
        endWord();
        i++;
      } else {
        if (c === '*' || c === '?' || c === '[') opaque = true;
        text += c;
        inWord = true;
        i++;
      }
    } else {
      // cmd.exe: `^` escapes the next character outside quotes, `%VAR%`
      // expands everywhere, and the program (git, through the C runtime)
      // removes the double quotes — `\"` is a literal quote to it.
      if (c === '^') {
        if (i + 1 < src.length) text += src[i + 1];
        inWord = true;
        i += 2;
      } else if (c === '"') {
        inWord = true;
        i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\' && src[i + 1] === '"') {
            text += '"';
            i += 2;
          } else {
            if (src[i] === '%') opaque = true;
            text += src[i];
            i++;
          }
        }
        i++;
      } else if (c === '\\' && src[i + 1] === '"') {
        text += '"';
        inWord = true;
        i += 2;
      } else if ('&|()\n\r'.includes(c)) {
        endCommand();
        i++;
      } else if (c === '<' || c === '>') {
        endWord();
        i += src[i + 1] === '&' || src[i + 1] === c ? 2 : 1;
      } else if (c === ' ' || c === '\t') {
        endWord();
        i++;
      } else {
        if (c === '%' || c === '!' || c === '*' || c === '?') opaque = true;
        text += c;
        inWord = true;
        i++;
      }
    }
  }
  endCommand();
  return { commands, substitutions, unreadable };
}

const basename = (word: string): string => word.replace(/^.*[\\/]/, '').toLowerCase();
const isGit = (w: Word): boolean => !w.opaque && /^git(?:\.exe)?$/.test(basename(w.text));
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash', 'busybox']);
/** Words that may stand before a command and are not it. */
const PREFIX_WORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time']);
/**
 * Programs that run another program named among their operands. An operand
 * only the shell can resolve may be that program — `env "$G" gc` runs
 * `git gc` when `G=git`.
 */
const WRAPPERS = new Set([
  'env', 'command', 'exec', 'builtin', 'nice', 'nohup', 'timeout', 'xargs', 'sudo', 'doas', 'su', 'runuser',
  'stdbuf', 'ionice', 'setsid', 'setpriv', 'chrt', 'taskset', 'flock', 'chroot', 'unshare', 'nsenter', 'watch',
  'parallel', 'strace', 'ltrace', 'time', 'busybox', 'script', 'start', 'call',
]);
const FIND_RUNS = /^-(?:exec|execdir|ok|okdir)$/;

function commandRefusal(words: Word[], dialect: ShellDialect, depth: number): string | null {
  let i = 0;
  while (i < words.length && !words[i]!.opaque && (PREFIX_WORDS.has(words[i]!.text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!.text))) i++;
  // The program run is not known (`$G update-ref`): it could be git.
  if (words[i]?.opaque) return UNREADABLE;
  for (let j = i; j < words.length; j++) {
    const w = words[j]!;
    if (w.opaque) continue;
    const name = basename(w.text).replace(/\.exe$/, '');
    const runsAnOperand =
      WRAPPERS.has(name) || (name === 'find' && words.some((a, n) => n > j && !a.opaque && FIND_RUNS.test(a.text)));
    if (runsAnOperand && words.slice(j + 1).some((a) => a.opaque)) return UNREADABLE;
    // Every `git` in the command, wherever it stands — `nice -n 5 git gc`,
    // `find . -exec git gc \;`, `timeout 9 git prune` all reach the same
    // repository. A word that only looks like one (`echo git gc`) is refused
    // too; that costs nothing.
    if (isGit(w)) {
      // Its arguments come from somewhere else (`… | xargs git`).
      if (words.slice(i, j).some((p) => !p.opaque && basename(p.text) === 'xargs')) return UNREADABLE;
      const reason = refusalFor(words.slice(j + 1));
      if (reason !== null) return reason;
    }
    // A command line handed to another shell is that shell's to parse: parse it as it will.
    let inner: Word[] | null = null;
    if (SHELLS.has(name)) {
      const k = words.findIndex((a, n) => n > j && !a.opaque && /^-[A-Za-z]*c[A-Za-z]*$/.test(a.text));
      if (k >= 0) inner = words.slice(k + 1, k + 2);
    } else if (name === 'eval' && j === i) inner = words.slice(j + 1);
    else if (name === 'cmd' && dialect === 'cmd') {
      const k = words.findIndex((a, n) => n > j && /^\/[ck]$/i.test(a.text));
      if (k >= 0) inner = words.slice(k + 1);
    }
    if (inner !== null && inner.length > 0) {
      if (inner.some((a) => a.opaque)) return UNREADABLE;
      if (depth > 8) return UNREADABLE;
      const reason = refusalIn(
        inner.map((a) => a.text).join(' '),
        name === 'cmd' ? 'cmd' : name === 'eval' ? dialect : 'posix',
        depth + 1,
      );
      if (reason !== null) return reason;
    }
  }
  return null;
}

function refusalIn(command: string, dialect: ShellDialect, depth: number): string | null {
  const { commands, substitutions, unreadable } = lex(command, dialect);
  if (unreadable) return UNREADABLE;
  for (const words of commands) {
    const reason = commandRefusal(words, dialect, depth);
    if (reason !== null) return reason;
  }
  for (const body of substitutions) {
    const reason = depth > 8 ? UNREADABLE : refusalIn(body, dialect, depth + 1);
    if (reason !== null) return reason;
  }
  return null;
}

/**
 * Why `command` must not run in a branch workspace — the offending git
 * command, in a few words — or null when it may. `dialect` is the shell that
 * will run it: the command is read as THAT shell reads it.
 */
export function sharedRepositoryGitRefusal(
  command: string,
  dialect: ShellDialect = process.platform === 'win32' ? 'cmd' : 'posix',
): string | null {
  return refusalIn(command, dialect, 0);
}

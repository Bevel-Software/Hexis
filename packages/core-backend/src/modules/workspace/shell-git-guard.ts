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
 *  - renaming, copying, deleting or force-moving a branch, and changing its
 *    upstream (which writes the shared configuration);
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
 * `cd kb && git update-ref …` reaches the same repository. The split on shell
 * separators is deliberately coarse — a refusal of something that only looked
 * like such a command (`echo git gc`) costs nothing.
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
  /^(?:-[a-zA-Z]*[dDmMcCfu][a-zA-Z]*|--delete|--move|--copy|--force|--set-upstream-to(?:=.*)?|--unset-upstream|--edit-description)$/;

const CONFIG_WRITE_FLAGS =
  /^(?:--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section|--edit|-e)$/;
const CONFIG_READ_FLAGS = /^(?:--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--show-origin|--show-scope|--name-only|-z|--null)$/;

/** The reason a git invocation is refused, or null when it may run. `args` follow `git`. */
function refusalFor(args: string[]): string | null {
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) {
    i += OPTIONS_WITH_VALUE.has(args[i]!) ? 2 : 1;
  }
  const sub = args[i];
  if (sub === undefined) return null;
  const rest = args.slice(i + 1);
  const flags = rest.filter((a) => a.startsWith('-'));
  const positionals = rest.filter((a) => !a.startsWith('-'));
  if (ALWAYS_REFUSED.has(sub)) return `git ${sub}`;
  switch (sub) {
    case 'worktree':
      return positionals[0] === 'list' ? null : 'git worktree';
    case 'reflog':
      return positionals[0] === 'expire' || positionals[0] === 'delete' ? `git reflog ${positionals[0]}` : null;
    case 'branch':
      return flags.some((f) => BRANCH_WRITE_FLAGS.test(f))
        ? 'git branch that deletes, renames, copies or force-moves a branch, or changes its upstream'
        : null;
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

/** Words of a shell segment, quotes stripped; good enough to find a subcommand and its flags. */
function words(segment: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

/**
 * Why `command` must not run in a branch workspace — the offending git
 * command, in a few words — or null when it may.
 */
export function sharedRepositoryGitRefusal(command: string): string | null {
  for (const segment of command.split(/\$\(|[;&|()`\n]/)) {
    const w = words(segment);
    // Leading `VAR=value` assignments and `env`/`command`/`exec` wrappers.
    let i = 0;
    while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]!) || ['env', 'command', 'exec'].includes(w[i]!))) i++;
    const exe = w[i];
    if (exe === undefined || !/(?:^|[\\/])git(?:\.exe)?$/.test(exe)) continue;
    const reason = refusalFor(w.slice(i + 1));
    if (reason !== null) return reason;
  }
  return null;
}

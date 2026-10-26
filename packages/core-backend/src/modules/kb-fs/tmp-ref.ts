import { WorkflowValidationError } from '../../shared/domain-errors.js';
import { sanitizedPath } from '../../shared/printable.js';

/**
 * The tmp ref's admission: which tool inputs may carry one, and the refusal
 * every other input answers. What the ref REACHES is `workspace/workspace-tmp.ts`'s;
 * whether a tool may be HANDED one is decided here, once, by
 * {@link assertTmpRefsTaken} — which {@link normalizePathArgs} runs before it
 * places any path under the checkout, so no tool surface that takes a path
 * can turn `__tmp__/x` into the repository path `<kbDirName>/__tmp__/x` and
 * write, read or show it as if the ref had been honoured. A surface that
 * resolves its paths without the normaliser (`open_page`) calls the gate
 * itself.
 */

/** The ref's prefix. A ref is `__tmp__/<path inside the workspace's tmp folder>`. */
export const TMP_REF_PREFIX = '__tmp__/';

/**
 * Whether a tool argument is a tmp ref rather than a repository path: the
 * prefix as written, or the prefix's own folder name alone (which names the
 * folder, and is refused as such by the resolver). A path that only CONTAINS
 * the name — `/__tmp__/x`, `knowledge-base/__tmp__/x` — is an ordinary
 * repository path.
 */
export function isTmpRef(value: unknown): boolean {
  return typeof value === 'string' && (value === TMP_REF_PREFIX.slice(0, -1) || value.startsWith(TMP_REF_PREFIX));
}

/**
 * Why a tool refuses a tmp ref in an input that is not one of the four that
 * take it: the folder is read-only through the ref, and a file is kept by
 * copying it into the repository. A 400 with a `kind` to branch on, before
 * any gate, lock or write.
 */
export function tmpRefReadOnlyRefusal(ref: string, tool: string): WorkflowValidationError {
  const shown = sanitizedPath(ref);
  return new WorkflowValidationError(
    `"${shown}" is a tmp ref, and ${tool} does not take one there: the workspace's tmp folder is read-only through ` +
      'the ref. read_file, file_stat and grep read the one file it names; to keep the file, copy_file it to a ' +
      'repository path (the ref as `src`, the repository path as `dest`).',
    { kind: 'tmp-ref-read-only', path: shown, tool },
  );
}

/** The tool inputs that carry a workspace path as a string. */
const PATH_INPUTS = ['path', 'src', 'dest', 'destination'] as const;

/**
 * Every path a tool call carries, with the input it came in: the string
 * inputs, `files` for each `files[].path` of a batch write, and `paths` for
 * each entry of a list of paths (`request_file_download`).
 */
function pathEntries(args: Record<string, unknown>): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = PATH_INPUTS.map((key) => [key, args[key]]);
  if (Array.isArray(args.files)) {
    for (const f of args.files as unknown[]) {
      entries.push(['files', f && typeof f === 'object' ? (f as Record<string, unknown>).path : undefined]);
    }
  }
  if (Array.isArray(args.paths)) {
    for (const p of args.paths as unknown[]) entries.push(['paths', p]);
  }
  return entries;
}

/**
 * Refuse a tmp ref in any input of `tool` that is not in `takes` — with
 * {@link tmpRefReadOnlyRefusal}, before anything else runs. `takes` is empty
 * for every tool but the four reads of the one file a ref names.
 */
export function assertTmpRefsTaken(tool: string, args: Record<string, unknown>, takes: readonly string[] = []): void {
  for (const [key, value] of pathEntries(args)) {
    if (isTmpRef(value) && !takes.includes(key)) throw tmpRefReadOnlyRefusal(value as string, tool);
  }
}

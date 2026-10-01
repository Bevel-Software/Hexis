import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../../shared/logging.js';
import { isAbsence } from '../../../shared/fs.contract.js';
import { printable } from '../../../shared/printable.js';

const log = logger('kb-startup');

/** The opening of the boot note, so a test and an operator's grep agree on it. */
export const BESIDE_CHECKOUT_NOTE = 'Beside the checkout, not in the repository:';

/**
 * Name whatever is sitting in a workspace directory other than the checkout —
 * and touch none of it.
 *
 * A workspace directory holds the repository as one folder (`<kbDirName>/`).
 * Anything else in there is in a location git never sees: never committed,
 * never pushed, never shared, and invisible in the app once the explorer reads
 * its roots from the checkout. Nothing the platform accepts can write there any
 * more — every path goes through the normaliser now — but deployments that ran
 * the older code already have such files, and the only way anyone learns of
 * them is if the platform says so. So it says so, once per start, per workspace.
 *
 * DELETES NOTHING, MOVES NOTHING, on purpose. The platform cannot prove it
 * wrote any of it: a stray may be an operator's own scratch file beside a
 * clone, and a boot that quietly removed it would be a data loss nobody asked
 * for. The operator cleans up, and the note stops on the next start.
 *
 * EVERYTHING other than the checkout folder is named, the platform's own
 * transient `tmp/` scratch included on the rare start that finds one (a run
 * clears it when it finishes). That is deliberate: the note's claim is about
 * what is not in the repository, and a note that quietly kept exceptions would
 * be a note an operator could not trust.
 *
 * NOT a `OnServerStart` step, and deliberately outside the KB startup phase.
 * That phase is gated — it does nothing until the branch model and the
 * repository URL are configured, and it is retried on setup completion and
 * again whenever the remote comes back. A note that lived inside it would be
 * silent on exactly the deployments most likely to hold strays (setup never
 * finished, remote unreachable) and would repeat itself on every retry. This
 * runs ONCE per boot, from the server builder, before that phase, and needs
 * no remote and no clone: what it reads is already on disk.
 *
 * Reads the workspaces root directly rather than through a branch handle: it
 * needs the directories that are ALREADY on disk, not the branches this build
 * would clone, and a read-only scan must not be the thing that clones a branch.
 */
export async function noteBesideCheckout(
  workspacesRoot: string,
  kbDirName: string,
  /** Where the note goes. Injected so a test can read it without a log sink. */
  note: (line: string) => void = (line) => log.warn(line),
): Promise<void> {
  const workspaces = await entries(workspacesRoot);
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = path.join(workspacesRoot, workspace.name);
    const found: string[] = [];
    for (const entry of await entries(workspaceDir)) {
      // The exemption is the CHECKOUT's, not the name's. A regular file called
      // `knowledge-base` is not a clone — `WorkspaceService` refuses the
      // workspace outright as a squatted clone path — so a name-only filter
      // would hide the one thing an operator has to remove to get the
      // deployment working. Judged by `stat`, which FOLLOWS links, exactly as
      // the service judges it: a clone mounted elsewhere is the operator's
      // business, here as it is there.
      if (entry.name === kbDirName && (await isDirectory(path.join(workspaceDir, entry.name)))) continue;
      // A trailing slash marks the folders, so one line says which is which
      // without the operator having to go and look. Then `printable`, because
      // every name here is disk-controlled text on its way into an operator's
      // log: one carrying a control character must not steer the terminal or
      // forge a second line of the note, and the quotes it adds keep a name
      // with a space or a comma in it readable in the list.
      found.push(printable(entry.isDirectory() ? `${entry.name}/` : entry.name));
    }
    const strays = found.sort();
    if (strays.length === 0) continue;
    note(
      `${BESIDE_CHECKOUT_NOTE} ${strays.join(', ')} — in the workspace for ${printable(workspace.name)}, ` +
        'outside the git clone, so never committed or pushed. Nothing was deleted or moved; remove them by hand when you have looked.',
    );
  }
}

/**
 * Whether `p` is a directory, links followed.
 *
 * Absence is an answer — a dangling link where the checkout should be is not a
 * checkout, and saying so is the note's job. Anything else (a permission
 * failure, an I/O error, a symlink loop) is NOT an answer: swallowing it would
 * publish "the checkout is a stray" about a path this process could not read.
 * It is thrown, the same rule {@link entries} keeps, and the boot's diagnostic
 * handler names the path instead.
 */
async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch (err) {
    if (isAbsence(err)) return false;
    throw err;
  }
}

/** A directory's entries, or none when it is not there yet (a cold start). */
async function entries(dir: string): Promise<{ name: string; isDirectory(): boolean }[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isAbsence(err)) return [];
    throw err;
  }
}

/**
 * THE sentence a move answers with when its destination lies inside what is
 * being moved: `Team` to `Team/Twin/Team`. No filesystem can do that move, and
 * the raw `rename` error it fails with names a path on the server's disk.
 *
 * The agent's `move_file` (its dry run and the move) and the app's rename and
 * drag all ask this one function, so the refusal reads the same everywhere.
 *
 * Judged segment by segment on the paths as given, never by string prefix:
 * `Team2` is not inside `Team`. Trailing slashes, `.` segments and empty
 * segments are spelling, not names, and are ignored. The server resolves or
 * refuses `..` and backslashes before it asks, and the app's drag passes paths
 * from its own tree, so they are not resolved here: `..` is compared as a
 * name, which no folder is called, and never makes a path inside. Case is
 * ignored: on a case-insensitive filesystem `team/Twin` is inside `Team`, and
 * the repository treats names that differ only in case as one name, because it
 * is cloned onto such filesystems too.
 *
 * Answers null when the destination is not inside the source, the source
 * itself included (a move onto itself is refused elsewhere, as a no-op).
 */
export function moveIntoItselfRefusal(src: string, dest: string): string | null {
  const from = segmentsOf(src);
  const to = segmentsOf(dest);
  if (from.length === 0 || to.length <= from.length) return null;
  if (!from.every((segment, i) => segment.toLowerCase() === to[i].toLowerCase())) return null;
  const shownSrc = from.join('/');
  return `Nothing can be moved into itself: "${to.join('/')}" is inside "${shownSrc}". Choose a destination outside "${shownSrc}".`;
}

function segmentsOf(p: string): string[] {
  return p.split('/').filter((segment) => segment !== '' && segment !== '.');
}
